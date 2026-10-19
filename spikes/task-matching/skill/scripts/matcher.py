"""Ingest signals and run matching stages 1-3. Stage 4 (the AI judge) is Copilot itself:
propose() writes the cases it can't settle to pending_judgments.json, and tasks.apply_verdicts()
applies what the judge decided.
"""

import json
import math
from datetime import datetime, timedelta, timezone

import entities
import store
import tasks
import vectors

MATCHER_VERSION = "spike-0.1"

CLOSED_WINDOW_DAYS = 30   # done/dropped tasks stay eligible this long
SHORTLIST_SIZE = 3
ENTITY_MIN = 0.5          # entity-overlap score needed to make the shortlist
STRONG_ENTITY = 2.0       # a shared doc or ticket: keep even if meaning looks far off

# Similarity floors depend on the embedder: hash vectors score much lower than real ones.
SEM_FLOOR = {"hash": 0.35, "ollama": 0.62}         # no-shared-entity fallback
SEM_MIN_ENTITY = {"hash": 0.05, "ollama": 0.40}    # drop weak-entity matches below this
ANCHOR_SEM_FLOOR = {"hash": 0.10, "ollama": 0.45}  # anchor hit auto-merges above this

TYPE_WEIGHT = {"ticket": 3.0, "document": 3.0, "person": 1.0, "term": 1.0, "org": 0.3}
STRENGTH_WEIGHT = {"id": 1.0, "alias": 0.5, "provisional": 0.0}

SOURCE_LABEL = {"email": "Email", "slack": "Slack", "meeting": "Meeting", "calendar": "Calendar"}


def _family(model):
    return "hash" if model.startswith("hash") else "ollama"


class Context:
    """What a run needs: connection, config, embedder and whether sqlite-vec loaded."""

    def __init__(self, conn, cfg, embedder, run_id):
        self.conn = conn
        self.cfg = cfg
        self.embedder = embedder
        self.run_id = run_id
        self.vec_sql = vectors.load_sqlite_vec(conn) is not None
        self.embed_ok = embedder is not None
        run = conn.execute("SELECT notes FROM runs WHERE id=?", (run_id,)).fetchone()
        if run and any(n.startswith("Stage 3") for n in json.loads(run["notes"])):
            self.embed_ok = False  # an earlier step of this run already found the embedder down

    def note(self, text):
        store.add_run_note(self.conn, self.run_id, text)

    def embed(self, texts):
        if not self.embed_ok:
            return None
        try:
            return self.embedder.embed(texts)
        except vectors.EmbedderUnavailable as e:
            self.embed_ok = False
            self.note(f"Stage 3 (semantic) skipped: {e}")
            return None


# ---------------------------------------------------------------- ingest

def signal_key(s):
    return f"{s['source']}:{s['source_id']}:{s.get('version', '1')}"


def ingest(ctx, signals):
    conn = ctx.conn
    counts = {"signals": 0, "skipped": 0, "candidates": 0, "withdrawn": 0}
    for s in signals:
        key = signal_key(s)
        if conn.execute("SELECT 1 FROM signals WHERE key=?", (key,)).fetchone():
            counts["skipped"] += 1
            continue
        conn.execute("INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (key, s["source"], s["source_id"], str(s.get("version", "1")), s.get("anchor"),
                      s.get("link"), s.get("ts"), s.get("quote"), json.dumps(s), ctx.run_id))
        counts["signals"] += 1
        _advance_cursor(conn, s["source"], s.get("ts"))
        if s.get("withdrawn"):
            counts["withdrawn"] += 1
            tasks.mark_withdrawn(conn, s)
            continue
        cands = s.get("candidates") or []
        rows = []
        if not cands:
            rows.append(("update", None, {}))
        for c in cands:
            rows.append(("ask", c.get("ask"), c))
        new_ids = []
        for i, (kind, ask, c) in enumerate(rows):
            cur = conn.execute(
                "INSERT INTO candidates (signal_key, idx, kind, ask, owner, due, payload) VALUES (?,?,?,?,?,?,?)",
                (key, i, kind, ask, c.get("owner", "me") if kind == "ask" else None, c.get("due"), json.dumps(c)))
            cid = cur.lastrowid
            entities.resolve_candidate(conn, cid, s, c, ctx.cfg.get("me", {}))
            if kind == "ask":
                new_ids.append((cid, ask))
            counts["candidates"] += 1
        vecs = ctx.embed([a for _, a in new_ids]) if new_ids else None
        if vecs:
            for (cid, _), v in zip(new_ids, vecs):
                vectors.put(conn, "candidate", cid, ctx.embedder.model, v)
    conn.commit()
    return counts


def _advance_cursor(conn, source, ts):
    if not ts:
        return
    row = conn.execute("SELECT value FROM cursors WHERE source=?", (source,)).fetchone()
    if row is None or ts > row["value"]:
        conn.execute("INSERT OR REPLACE INTO cursors VALUES (?,?)", (source, ts))


def cursors(conn, overlap_hours=6, first_run_days=3):
    out = {}
    now = datetime.now(timezone.utc)
    for src in ("email", "slack", "meeting"):
        row = conn.execute("SELECT value FROM cursors WHERE source=?", (src,)).fetchone()
        if row:
            t = datetime.fromisoformat(row["value"].replace("Z", "+00:00")) - timedelta(hours=overlap_hours)
        else:
            t = now - timedelta(days=first_run_days)
        out[src] = t.strftime("%Y-%m-%dT%H:%M:%SZ")
    return out


# ---------------------------------------------------------------- stages

def candidate_signal(conn, cand):
    row = conn.execute("SELECT payload FROM signals WHERE key=?", (cand["signal_key"],)).fetchone()
    return json.loads(row["payload"])


def candidate_anchors(conn, cand):
    s = candidate_signal(conn, cand)
    out = []
    if s.get("anchor"):
        out.append(("thread", s["anchor"]))
    for m in s.get("message_ids") or []:
        out.append(("thread", "msgid:" + m.strip().strip("<>")))
    for k in entities.tickets_in(cand["ask"], s.get("quote")):
        out.append(("ticket", "ticket:" + k))
    for url in (json.loads(cand["payload"]).get("links") or []) + (s.get("links") or []):
        ident = entities.normalize_url(url)
        if ident.startswith("ticket:"):
            out.append(("ticket", ident))
    return out


def eligible_tasks(conn):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CLOSED_WINDOW_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = conn.execute(
        "SELECT * FROM tasks WHERE state IN ('open','scheduled') "
        "OR (state IN ('done','dropped') AND state_changed_at >= ?)", (cutoff,)).fetchall()
    return {r["id"]: r for r in rows}


def _sibling_tasks(conn, cand):
    """Tasks born from the same signal: separate asks in one message never match each other."""
    rows = conn.execute(
        "SELECT ts.task_id FROM task_sources ts JOIN candidates c ON c.id=ts.candidate_id "
        "WHERE c.signal_key=? AND ts.role='origin'", (cand["signal_key"],)).fetchall()
    return {r["task_id"] for r in rows}


def stage1_anchor(conn, cand, eligible):
    anchors = candidate_anchors(conn, cand)
    hits = {}
    for kind, a in anchors:
        for r in conn.execute("SELECT task_id FROM task_anchors WHERE anchor=?", (a,)):
            t = store.live_task(conn, r["task_id"])
            if t and t["id"] in eligible:
                hits.setdefault(t["id"], kind)
                if kind == "thread":
                    hits[t["id"]] = "thread"
    for tid in _sibling_tasks(conn, cand):
        hits.pop(tid, None)
    return hits


def stage2_entities(conn, cand, eligible):
    cand_m = {r["entity_id"]: r["strength"] for r in
              conn.execute("SELECT entity_id, strength FROM mentions WHERE candidate_id=?", (cand["id"],))}
    if not cand_m or not eligible:
        return {}, {}
    ids = list(eligible)
    marks = ",".join("?" * len(ids))
    task_m = {}
    for r in conn.execute(
            f"SELECT ts.task_id, m.entity_id, m.strength FROM task_sources ts "
            f"JOIN mentions m ON m.candidate_id=ts.candidate_id WHERE ts.task_id IN ({marks})", ids):
        cur = task_m.setdefault(r["task_id"], {})
        cur[r["entity_id"]] = entities._stronger(cur.get(r["entity_id"]), r["strength"])
    df = {}
    for ents in task_m.values():
        for e in ents:
            df[e] = df.get(e, 0) + 1
    n = len(eligible)
    types = {r["id"]: (r["type"], r["name"]) for r in conn.execute(
        f"SELECT id, type, name FROM entities WHERE id IN ({','.join('?' * len(cand_m))})", list(cand_m))}
    scores, shared = {}, {}
    for tid, ents in task_m.items():
        if tid in _sibling_tasks(conn, cand):
            continue
        score, names = 0.0, []
        for e, s in cand_m.items():
            if e not in ents:
                continue
            strength = min(STRENGTH_WEIGHT[s], STRENGTH_WEIGHT[ents[e]])
            typ, name = types[e]
            w = TYPE_WEIGHT.get(typ, 0.5) * strength * math.log(1 + n / df[e])
            if w > 0:
                score += w
                names.append(f"{typ}:{name}")
        if score > 0:
            scores[tid], shared[tid] = round(score, 3), names
    return scores, shared


def stage3_semantic(ctx, cand, task_ids):
    """Similarity of the candidate to each task: the best match over the asks the task already holds."""
    if not ctx.embed_ok or not task_ids:
        return None
    model = ctx.embedder.model
    qv = vectors.get(ctx.conn, "candidate", cand["id"], model)
    if qv is None:
        return None
    ids = list(task_ids)
    rows = ctx.conn.execute(
        f"SELECT task_id, candidate_id FROM task_sources WHERE task_id IN ({','.join('?' * len(ids))})", ids).fetchall()
    sims = vectors.similarities(ctx.conn, qv, "candidate", [r["candidate_id"] for r in rows], model, ctx.vec_sql)
    out = {}
    for r in rows:
        if r["candidate_id"] in sims:
            out[r["task_id"]] = max(out.get(r["task_id"], -1.0), sims[r["candidate_id"]])
    return {k: round(v, 3) for k, v in out.items()}


# ---------------------------------------------------------------- propose

def propose(ctx):
    conn = ctx.conn
    cands = conn.execute("SELECT * FROM candidates WHERE status IN ('new','pending') ORDER BY id").fetchall()
    stats = {}
    pending = []
    fam = _family(ctx.embedder.model) if ctx.embedder else "hash"
    for cand in cands:
        eligible = eligible_tasks(conn)
        hits = stage1_anchor(conn, cand, eligible)
        out = _decide(ctx, cand, eligible, hits, fam)
        stats[out["outcome"]] = stats.get(out["outcome"], 0) + 1
        if out["outcome"] == "pending":
            pending.append(out["item"])
    conn.commit()
    return stats, pending


def _decide(ctx, cand, eligible, hits, fam):
    conn = ctx.conn
    sem_all = None

    # updates (a signal with no new ask) only ever match by anchor
    if cand["kind"] == "update":
        if len(hits) >= 1:
            tid = sorted(hits)[0]
            return tasks.record(ctx, cand, "anchor", "update", tid, reason="Reply in a thread already linked to this task")
        return tasks.record(ctx, cand, "rule", "discarded", reason="No new ask and no known thread")

    # stage 1: one anchor hit on a live task settles it, if the meaning agrees
    if len(hits) == 1:
        tid, kind = next(iter(hits.items()))
        t = eligible[tid]
        sem = stage3_semantic(ctx, cand, [tid])
        s = sem.get(tid) if sem else None
        agrees = (s is None and kind == "thread") or (s is not None and s >= ANCHOR_SEM_FLOOR[fam])
        if t["state"] in ("open", "scheduled") and agrees:
            return tasks.record(ctx, cand, "anchor", "merged", tid, scores={"semantic": s, "anchor": kind},
                                reason=f"Same {kind} as task #{tid}")

    # stage 2: entity overlap
    escore, shared = stage2_entities(conn, cand, eligible)
    short = {tid for tid, sc in escore.items() if sc >= ENTITY_MIN}

    # stage 3: meaning, over the shortlist (or the open tasks, as a fallback)
    sem = stage3_semantic(ctx, cand, short | set(hits)) or {}
    if ctx.embed_ok:
        short = {t for t in short if escore[t] >= STRONG_ENTITY or sem.get(t, 0) >= SEM_MIN_ENTITY[fam]}
        if not short and not hits:
            open_ids = [t for t, r in eligible.items() if r["state"] in ("open", "scheduled")]
            sem_all = stage3_semantic(ctx, cand, open_ids) or {}
            short = {t for t, s in sem_all.items() if s >= SEM_FLOOR[fam]}
            sem.update(sem_all)
    ranked = sorted(short | set(hits),
                    key=lambda t: (t in hits, sem.get(t, 0), escore.get(t, 0)), reverse=True)
    keep = [t for t in ranked if t in hits] + [t for t in ranked if t not in hits][:SHORTLIST_SIZE]
    keep = list(dict.fromkeys(keep))

    if not keep:
        if cand["owner"] not in ("me", "unclear", None):
            return tasks.record(ctx, cand, "rule", "discarded", reason=f"Ask is for {cand['owner']}, no related task")
        stage = "semantic" if ctx.embed_ok else "entity"
        return tasks.record(ctx, cand, stage, "new", reason="No anchor, entity or meaning match")

    conn.execute("UPDATE candidates SET status='pending' WHERE id=?", (cand["id"],))
    return {"outcome": "pending", "item": _judgment_item(ctx, cand, keep, hits, escore, shared, sem)}


def _judgment_item(ctx, cand, keep, hits, escore, shared, sem):
    conn = ctx.conn
    s = candidate_signal(conn, cand)
    short = []
    for tid in keep:
        t = store.live_task(conn, tid)
        hist = [h["text"] for h in conn.execute(
            "SELECT text FROM history WHERE task_id=? ORDER BY id DESC LIMIT 5", (tid,))]
        short.append({
            "task_id": tid, "title": t["title"], "state": t["state"],
            "state_changed_at": t["state_changed_at"], "owner": t["owner"], "due": t["due"],
            "anchor_hit": hits.get(tid), "entity_score": escore.get(tid, 0),
            "shared_entities": shared.get(tid, []), "semantic": sem.get(tid),
            "title_history": json.loads(t["title_history"]), "recent_history": hist,
        })
    return {
        "candidate_id": cand["id"], "ask": cand["ask"], "owner": cand["owner"], "due": cand["due"],
        "source": s["source"], "from": (s.get("from") or {}).get("name"), "ts": s.get("ts"),
        "link": s.get("link"), "quote": s.get("quote"),
        "needs_new_ask_test": any(x["state"] in ("done", "dropped") for x in short),
        "shortlist": short,
    }
