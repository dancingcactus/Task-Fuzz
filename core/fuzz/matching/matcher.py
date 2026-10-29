"""Ingest signals and run matching stages 1-3, then apply the judge's verdicts (stage 4).

Moved from the matching spike (matcher.py and tasks.py). What changed:
  - every query is scoped by user_id
  - tasks are created, attached, reopened and merged through events, so they show in the log
  - a possible duplicate becomes a duplicate card; an ask with an unclear owner becomes an is_task card
  - pending judgments are stored on the candidate, so the judge can page through them
The thresholds and floors are the spike's.
"""

import json
import math
from datetime import timedelta

from .. import cards, events, groups, states, tasks
from ..db import FuzzError, iso
from . import entities, vectors

MATCHER_VERSION = "core-0.1"

CLOSED_WINDOW_DAYS = 30
THEIRS_WINDOW_DAYS = 90   # someone else's task can come back when it starts needing you, for longer
SHORTLIST_SIZE = 3
ENTITY_MIN = 0.5
STRONG_ENTITY = 2.0

SEM_FLOOR = {"hash": 0.35, "ollama": 0.62}
SEM_MIN_ENTITY = {"hash": 0.05, "ollama": 0.40}
ANCHOR_SEM_FLOOR = {"hash": 0.10, "ollama": 0.45}

TYPE_WEIGHT = {"ticket": 3.0, "document": 3.0, "person": 1.0, "term": 1.0, "org": 0.3}
STRENGTH_WEIGHT = {"id": 1.0, "alias": 0.5, "provisional": 0.0}

# Your own reply that answers the thread closes the task, if it's still waiting on you. Waiting tasks wait on
# someone else, and Fuzz's own work in flight finishes or comes back to you.
ANSWERED_CLOSES = ("triage", "queued", "scheduled", "parked", "session")

MERGE_CONF = 0.85
DUP_CONF = 0.60

UNCHANGING = ("email",)   # sources whose messages are never edited: one signal each, whatever the version
SOURCE_LABEL = {"email": "Email", "slack": "Slack", "meeting": "Meeting", "calendar": "Calendar", "fuzz": "Fuzz"}
BRIEF_KEYS = ("context_md", "question", "effort_mins", "energy")


def _family(model):
    return "hash" if model.startswith("hash") else "ollama"


class Context:
    """What a matching pass needs: the core, the embedder and whether sqlite-vec loaded."""

    def __init__(self, core, embedder=None):
        self.core = core
        self.conn = core.conn
        self.cfg = core.config
        self.embedder = embedder if embedder is not None else vectors.make_embedder(self.cfg)
        self.vec_sql = vectors.load_sqlite_vec(core.conn) is not None
        self.embed_ok = self.embedder is not None
        self.notes = []

    @property
    def run_id(self):
        return (self.core.run or {}).get("id")

    def embed(self, texts):
        if not self.embed_ok:
            return None
        try:
            return self.embedder.embed(texts)
        except vectors.EmbedderUnavailable as e:
            self.embed_ok = False
            self.notes.append(f"Stage 3 (semantic) skipped: {e}")
            return None


def _uid(ctx):
    return ctx.core.user_id


# ---------------------------------------------------------------- ingest

def signal_key(s):
    return f"{s['source']}:{s['source_id']}:{s.get('version', '1')}"


def _seen(ctx, s, key):
    """Already recorded. An email never changes once sent, so any version of it counts: a client's version
    can be its last-modified time, which moves when it's read or flagged, and each run re-reads six hours."""
    if s["source"] in UNCHANGING:
        return ctx.core.q("SELECT 1 FROM signals WHERE user_id=? AND source=? AND source_id=?",
                          (_uid(ctx), s["source"], s["source_id"])).fetchone()
    return ctx.core.q("SELECT 1 FROM signals WHERE user_id=? AND key=?", (_uid(ctx), key)).fetchone()


def ingest(ctx, signals):
    core = ctx.core
    counts = {"signals": 0, "skipped": 0, "candidates": 0, "withdrawn": 0}
    for s in signals:
        key = signal_key(s)
        if _seen(ctx, s, key):
            counts["skipped"] += 1
            continue
        core.q("INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               (_uid(ctx), key, s["source"], s["source_id"], str(s.get("version", "1")), s.get("anchor"),
                s.get("link"), s.get("ts"), s.get("quote"), json.dumps(s), ctx.run_id))
        counts["signals"] += 1
        _advance_cursor(ctx, s["source"], s.get("ts"))
        if s.get("withdrawn"):
            counts["withdrawn"] += 1
            mark_withdrawn(ctx, s)
            continue
        cands = s.get("candidates") or []
        rows = [("update", None, {})] if not cands else [("ask", c.get("ask"), c) for c in cands]
        new_ids = []
        for i, (kind, ask, c) in enumerate(rows):
            cur = core.q(
                "INSERT INTO candidates (user_id, signal_key, idx, kind, ask, owner, due, payload) VALUES (?,?,?,?,?,?,?,?)",
                (_uid(ctx), key, i, kind, ask, c.get("owner", "me") if kind == "ask" else None, c.get("due"), json.dumps(c)))
            cid = cur.lastrowid
            entities.resolve_candidate(core, cid, s, c, ctx.cfg.get("me", {}))
            if kind == "ask":
                new_ids.append((cid, ask))
            counts["candidates"] += 1
        vecs = ctx.embed([a for _, a in new_ids]) if new_ids else None
        if vecs:
            for (cid, _), v in zip(new_ids, vecs):
                vectors.put(core.conn, "candidate", cid, ctx.embedder.model, v)
    return counts


def _advance_cursor(ctx, source, ts):
    if not ts:
        return
    row = ctx.core.q("SELECT value FROM cursors WHERE user_id=? AND source=?", (_uid(ctx), source)).fetchone()
    if row is None or ts > row["value"]:
        ctx.core.q("INSERT OR REPLACE INTO cursors VALUES (?,?,?)", (_uid(ctx), source, ts))


def cursors(core, overlap_hours=6, first_run_days=3):
    out = {}
    now = core.now()
    for src in ("email", "slack", "meeting"):
        row = core.q("SELECT value FROM cursors WHERE user_id=? AND source=?", (core.user_id, src)).fetchone()
        if row:
            from ..db import parse_iso
            t = parse_iso(row["value"]) - timedelta(hours=overlap_hours)
        else:
            t = now - timedelta(days=first_run_days)
        out[src] = iso(t)
    return out


# ---------------------------------------------------------------- stages

def candidate_signal(ctx, cand):
    row = ctx.core.q("SELECT payload FROM signals WHERE user_id=? AND key=?", (_uid(ctx), cand["signal_key"])).fetchone()
    return json.loads(row["payload"])


def candidate_anchors(ctx, cand):
    s = candidate_signal(ctx, cand)
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


def eligible_tasks(ctx):
    cutoff = iso(ctx.core.now() - timedelta(days=CLOSED_WINDOW_DAYS))
    theirs = iso(ctx.core.now() - timedelta(days=THEIRS_WINDOW_DAYS))
    live = ",".join(f"'{s}'" for s in states.LIVE)
    rows = ctx.core.q(
        f"SELECT * FROM tasks WHERE user_id=? AND (state IN ({live}) "
        "OR (state IN ('done','letgo') AND state_changed_at >= ?) "
        "OR (state='letgo' AND variant_tags LIKE '%\"theirs\"%' AND state_changed_at >= ?))", (_uid(ctx), cutoff, theirs)).fetchall()
    return {r["id"]: r for r in rows}


def _sibling_tasks(ctx, cand):
    """Tasks born from the same signal: separate asks in one message never match each other."""
    rows = ctx.core.q(
        "SELECT s.task_id FROM sources s JOIN candidates c ON c.id=s.candidate_id "
        "WHERE c.user_id=? AND c.signal_key=? AND s.role='origin'", (_uid(ctx), cand["signal_key"])).fetchall()
    return {r["task_id"] for r in rows}


def stage1_anchor(ctx, cand, eligible):
    hits = {}
    for kind, a in candidate_anchors(ctx, cand):
        for r in ctx.core.q("SELECT a.task_id FROM task_anchors a JOIN tasks t ON t.id=a.task_id "
                            "WHERE a.anchor=? AND t.user_id=?", (a, _uid(ctx))):
            t = tasks.live(ctx.core, r["task_id"])
            if t and t["id"] in eligible:
                hits.setdefault(t["id"], kind)
                if kind == "thread":
                    hits[t["id"]] = "thread"
    for tid in _sibling_tasks(ctx, cand):
        hits.pop(tid, None)
    return hits


def stage2_entities(ctx, cand, eligible):
    conn = ctx.conn
    cand_m = {r["entity_id"]: r["strength"] for r in
              conn.execute("SELECT entity_id, strength FROM mentions WHERE candidate_id=?", (cand["id"],))}
    if not cand_m or not eligible:
        return {}, {}
    ids = list(eligible)
    marks = ",".join("?" * len(ids))
    task_m = {}
    for r in conn.execute(
            f"SELECT s.task_id, m.entity_id, m.strength FROM sources s "
            f"JOIN mentions m ON m.candidate_id=s.candidate_id WHERE s.task_id IN ({marks})", ids):
        cur = task_m.setdefault(r["task_id"], {})
        cur[r["entity_id"]] = entities._stronger(cur.get(r["entity_id"]), r["strength"])
    df = {}
    for ents in task_m.values():
        for e in ents:
            df[e] = df.get(e, 0) + 1
    n = len(eligible)
    types = {r["id"]: (r["type"], r["name"]) for r in conn.execute(
        f"SELECT id, type, name FROM entities WHERE id IN ({','.join('?' * len(cand_m))})", list(cand_m))}
    siblings = _sibling_tasks(ctx, cand)
    scores, shared = {}, {}
    for tid, ents in task_m.items():
        if tid in siblings:
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
    if not ctx.embed_ok or not task_ids:
        return None
    model = ctx.embedder.model
    qv = vectors.get(ctx.conn, "candidate", cand["id"], model)
    if qv is None:
        return None
    ids = list(task_ids)
    rows = ctx.conn.execute(
        f"SELECT task_id, candidate_id FROM sources WHERE candidate_id IS NOT NULL AND task_id IN ({','.join('?' * len(ids))})",
        ids).fetchall()
    sims = vectors.similarities(ctx.conn, qv, "candidate", [r["candidate_id"] for r in rows], model, ctx.vec_sql)
    out = {}
    for r in rows:
        if r["candidate_id"] in sims:
            out[r["task_id"]] = max(out.get(r["task_id"], -1.0), sims[r["candidate_id"]])
    return {k: round(v, 3) for k, v in out.items()}


def propose(ctx):
    cands = ctx.core.q("SELECT * FROM candidates WHERE user_id=? AND status='new' ORDER BY id", (_uid(ctx),)).fetchall()
    stats = {}
    fam = _family(ctx.embedder.model) if ctx.embedder else "hash"
    for cand in cands:
        eligible = eligible_tasks(ctx)
        hits = stage1_anchor(ctx, cand, eligible)
        out = _decide(ctx, cand, eligible, hits, fam)
        stats[out["outcome"]] = stats.get(out["outcome"], 0) + 1
    return stats


def _decide(ctx, cand, eligible, hits, fam):
    if cand["kind"] == "update":
        if hits:
            tid = sorted(hits)[0]
            return record(ctx, cand, "anchor", "update", tid, reason="Reply in a thread already linked to this task")
        return record(ctx, cand, "rule", "discarded", reason="No new ask and no known thread")

    if len(hits) == 1:
        tid, kind = next(iter(hits.items()))
        t = eligible[tid]
        sem = stage3_semantic(ctx, cand, [tid])
        s = sem.get(tid) if sem else None
        agrees = (s is None and kind == "thread") or (s is not None and s >= ANCHOR_SEM_FLOOR[fam])
        if t["state"] in states.LIVE and agrees:
            return record(ctx, cand, "anchor", "merged", tid, scores={"semantic": s, "anchor": kind},
                          reason=f"Same {kind} as task #{tid}")

    escore, shared = stage2_entities(ctx, cand, eligible)
    short = {tid for tid, sc in escore.items() if sc >= ENTITY_MIN}
    sem = stage3_semantic(ctx, cand, short | set(hits)) or {}
    if ctx.embed_ok:
        short = {t for t in short if escore[t] >= STRONG_ENTITY or sem.get(t, 0) >= SEM_MIN_ENTITY[fam]}
        if not short and not hits:
            open_ids = [t for t, r in eligible.items() if r["state"] in states.LIVE]
            sem_all = stage3_semantic(ctx, cand, open_ids) or {}
            short = {t for t, s in sem_all.items() if s >= SEM_FLOOR[fam]}
            sem.update(sem_all)
    ranked = sorted(short | set(hits), key=lambda t: (t in hits, sem.get(t, 0), escore.get(t, 0)), reverse=True)
    keep = [t for t in ranked if t in hits] + [t for t in ranked if t not in hits][:SHORTLIST_SIZE]
    keep = list(dict.fromkeys(keep))

    if not keep:
        if cand["owner"] not in ("me", "unclear", None):
            return record(ctx, cand, "rule", "discarded", reason=f"Ask is for {cand['owner']}, no related task")
        return record(ctx, cand, "semantic" if ctx.embed_ok else "entity", "new", reason="No anchor, entity or meaning match")

    item = _judgment_item(ctx, cand, keep, hits, escore, shared, sem)
    ctx.core.q("UPDATE candidates SET status='pending', pending_item=? WHERE id=?", (json.dumps(item), cand["id"]))
    return {"outcome": "pending"}


def _judgment_item(ctx, cand, keep, hits, escore, shared, sem):
    s = candidate_signal(ctx, cand)
    short = []
    for tid in keep:
        t = tasks.live(ctx.core, tid)
        short.append({
            "task_id": tid, "title": t["title"], "state": t["state"], "state_changed_at": t["state_changed_at"],
            "owner": t["owner"], "due": t["due"], "anchor_hit": hits.get(tid), "entity_score": escore.get(tid, 0),
            "shared_entities": shared.get(tid, []), "semantic": sem.get(tid),
            "title_history": t.get("title_history") or [],
            "recent_history": [x["text"] for x in events.task_log(ctx.core, tid, 5)],
        })
    return {
        "candidate_id": cand["id"], "ask": cand["ask"], "owner": cand["owner"], "due": cand["due"],
        "source": s["source"], "from": (s.get("from") or {}).get("name"), "ts": s.get("ts"),
        "link": s.get("link"), "quote": s.get("quote"),
        "needs_new_ask_test": any(x["state"] in states.CLOSED for x in short),
        "shortlist": short,
    }


def pending_judgments(core, page=1, page_size=10):
    rows = core.q("SELECT pending_item FROM candidates WHERE user_id=? AND status='pending' ORDER BY id",
                  (core.user_id,)).fetchall()
    items = [json.loads(r["pending_item"]) for r in rows if r["pending_item"]]
    start = (max(page, 1) - 1) * page_size
    return {"page": page, "pages": max(1, -(-len(items) // page_size)), "total": len(items),
            "items": items[start:start + page_size]}


# ---------------------------------------------------------------- outcomes

def _is_other(cand):
    return cand["owner"] not in ("me", "unclear", None)


def _signal(ctx, cand):
    return candidate_signal(ctx, cand)


def record(ctx, cand, stage, outcome, task_id=None, other_task_id=None, verdict=None, confidence=None,
           reason=None, scores=None, new_title=None):
    """Log a decision for one candidate and apply its effect. Returns {"outcome": ...}."""
    core = ctx.core
    if outcome == "merged" and _is_other(cand):
        outcome = "context"
    if outcome == "update" and task_id is not None:
        t = tasks.live(core, task_id)
        if t["state"] in states.CLOSED:
            outcome = "ignored"
            reason = (reason or "") + f" (task is {t['state']}, no new ask)"
    cur = core.q(
        "INSERT INTO decisions (user_id, run_id, candidate_id, stage, outcome, task_id, other_task_id, verdict, "
        "confidence, reason, scores, matcher_version, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (_uid(ctx), ctx.run_id, cand["id"], stage, outcome, task_id, other_task_id, verdict, confidence, reason,
         json.dumps(scores or {}), MATCHER_VERSION, core.now_iso()))
    did = cur.lastrowid
    with core.tx():
        if outcome in ("new", "possible_duplicate", "related"):
            tid = create_task(ctx, cand, did)
            core.q("UPDATE decisions SET task_id=?, other_task_id=? WHERE id=?",
                   (tid, task_id if outcome != "new" else None, did))
            if outcome != "new" and task_id is not None:
                core.q("INSERT OR REPLACE INTO task_links VALUES (?,?,?,?,?)", (tid, task_id, outcome, confidence, reason))
                if outcome == "possible_duplicate":
                    cards.create(core, "duplicate", tid, other_id=task_id, reason=reason, suggested="merge")
            cards.sync(core, tid)
        elif outcome in ("merged", "update"):
            attach(ctx, task_id, cand, "update", did, new_title=new_title)
        elif outcome in ("context", "ignored"):
            attach(ctx, task_id, cand, outcome, did)
        elif outcome in ("reopened", "resurfaced"):
            attach(ctx, task_id, cand, "update", did, reopen=True)
    core.q("UPDATE candidates SET status='decided', pending_item=NULL WHERE id=?", (cand["id"],))
    return {"outcome": outcome, "decision_id": did}


def _brief(cand):
    c = json.loads(cand["payload"]) if isinstance(cand["payload"], str) else (cand["payload"] or {})
    return {k: c[k] for k in BRIEF_KEYS if c.get(k) is not None}


def create_task(ctx, cand, decision_id):
    core = ctx.core
    s = _signal(ctx, cand)
    title = (cand["ask"] or s.get("quote") or "Untitled").strip()
    if len(title) > tasks.TITLE_MAX:
        title = title[:tasks.TITLE_MAX - 3] + "..."
    owner = cand["owner"] or "me"
    brief = _brief(cand)
    if len((brief.get("context_md") or "").encode()) > tasks.CONTEXT_MAX:
        raise FuzzError(f"context_md is over {tasks.CONTEXT_MAX // 1024} KB", "candidates[].context_md")
    tid = core.new_id("tasks")
    now = core.now_iso()
    ch = events.Changes()
    ch.task(tid, state="triage", assignee="human", title=title, ask=cand["ask"], owner=owner, due=cand["due"],
            order_key=tasks.next_order(core), variant_tags=["unconfirmed"] if owner == "unclear" else [],
            created_at=now, state_changed_at=now, title_history=[], steps_used=0, attempts=0, deadline_level=0,
            **brief)
    note = f"Created from {SOURCE_LABEL.get(s['source'], s['source'])}"
    if (s.get("from") or {}).get("name"):
        note += f" ({s['from']['name']})"
    if owner == "unclear":
        note += ". Not sure this is yours, so Fuzz asks first"
    events.emit(core, "task.extracted", task_id=tid, changes=ch, log=("status", note),
                data={"candidate_id": cand["id"], "decision_id": decision_id, "source": s["source"]})
    _moments(core, tid, cand)
    core.q("INSERT INTO sources (user_id, task_id, candidate_id, signal_key, role, title, added_run) VALUES (?,?,?,?,?,?,?)",
           (_uid(ctx), tid, cand["id"], cand["signal_key"], "origin", _source_title(s), ctx.run_id))
    tasks.add_links(core, tid, _links(cand, s), ctx.run_id)
    _add_anchors(ctx, tid, cand)
    groups.place(core, tid, cand["signal_key"])
    return tid


def _moments(core, tid, cand):
    """Described dates on the ask. One that fails the core's check is dropped without a word."""
    from .. import scheduler
    c = json.loads(cand["payload"]) if isinstance(cand["payload"], str) else (cand["payload"] or {})
    for m in (c.get("moments") or [])[:2]:
        try:
            scheduler.suggest_schedule(core, tid, dict(m, type="moment"), m.get("reason"), actor=None)
        except FuzzError:
            pass


def _links(cand, s):
    """The candidate's own links first, then the signal's, each once."""
    c = json.loads(cand["payload"]) if isinstance(cand["payload"], str) else (cand["payload"] or {})
    return list(dict.fromkeys((c.get("links") or []) + (s.get("links") or [])))


def _source_title(s):
    who = (s.get("from") or {}).get("name") or "Someone"
    return f"{SOURCE_LABEL.get(s['source'], s['source'])} from {who}"


def _add_anchors(ctx, tid, cand):
    for _, a in candidate_anchors(ctx, cand):
        ctx.core.q("INSERT OR IGNORE INTO task_anchors VALUES (?,?)", (a, tid))


def attach(ctx, task_id, cand, role, decision_id, new_title=None, reopen=False):
    """A new signal on an existing task. The state rules from the design's "When a new signal brings a task back"."""
    core = ctx.core
    t = tasks.live(core, task_id)
    tid = t["id"]
    s = _signal(ctx, cand)
    core.q("INSERT OR IGNORE INTO sources (user_id, task_id, candidate_id, signal_key, role, title, added_run) "
           "VALUES (?,?,?,?,?,?,?)", (_uid(ctx), tid, cand["id"], cand["signal_key"], role, _source_title(s), ctx.run_id))
    if role != "ignored":
        tasks.add_links(core, tid, _links(cand, s), ctx.run_id)
    _add_anchors(ctx, tid, cand)
    who = (s.get("from") or {}).get("name") or "Someone"
    where = SOURCE_LABEL.get(s["source"], s["source"])
    text = f"{who} in {where}: “{(s.get('quote') or cand['ask'] or '').strip()[:160]}”"
    ch = events.Changes()
    new_ask = cand["kind"] == "ask"
    back = None   # (type, reason, tag) when the task returns to triage
    answered = (role == "update" and not new_ask and s.get("answers") and t["state"] in ANSWERED_CLOSES
                and entities.sent_by_me(s.get("from") or {}, ctx.cfg.get("me", {})))
    if role == "update":
        if new_title:
            tasks.retitle(core, ch, t, new_title)
        due = cand["due"]
        if due and (not t["due"] or due < t["due"]):
            ch.task(tid, due=due)
            cards.refresh_schedule_options(core, ch, tid)
        if reopen:
            theirs = "theirs" in (t.get("variant_tags") or [])
            why = (f"{who} asked something new after you marked this done" if t["state"] == "done"
                   else f"This was someone else's, but now {who} needs you" if theirs
                   else f"{who} asked again after you let this go")
            back = ("task.reopened", why, "reopened")
            if theirs:
                ch.task(tid, owner="me", variant_tags=tasks._tags(t, remove=("theirs",)))
        elif t["state"] == "scheduled" and due and t["schedule_fire_at"] and due < t["schedule_fire_at"]:
            back = ("task.came_back", f"Pulled forward: the new deadline {due} is before {t['schedule_fire_at'][:10]}",
                    "returning")
        elif t["state"] == "waiting" and (new_ask or _from_waited_on(t, s)):
            back = ("task.reply_in", f"Reply came in from {who}", "returning")
        elif t["state"] == "parked" and not answered:
            if new_ask:
                back = ("task.reopened", f"{who} asked something new about this", "reopened")
            else:
                ch.task(tid, variant_tags=tasks._tags(t, add=("woke",)))
        brief = _brief(cand)
        if brief:
            ch.task(tid, **brief)
    if back:
        typ, why, tag = back
        tasks.move(core, ch, t, "triage", add_tags=(tag,), order_key=tasks.next_order(core), reason=why,
                   schedule_anchor=None, schedule_fire_at=None)
        events.emit(core, typ, task_id=tid, changes=ch, log=("status", f"{text}. {why}."),
                    data={"candidate_id": cand["id"], "role": role, "decision_id": decision_id})
        cards.sync(core, tid, "front" if typ == "task.reply_in" else "back")
    elif answered:
        tasks.move(core, ch, t, "done", question=None)
        quote = (s.get("quote") or "").strip()[:160]
        events.emit(core, "task.done", task_id=tid, changes=ch,
                    log=("status", f"You answered in {where}" + (f": “{quote}”" if quote else "") + ". Fuzz marked this done."),
                    data={"candidate_id": cand["id"], "role": role, "decision_id": decision_id, "by": "reply"})
        cards.sync(core, tid)
    else:
        events.emit(core, "task.reply_in", task_id=tid, changes=ch, log=("status", text),
                    data={"candidate_id": cand["id"], "role": role, "decision_id": decision_id})
    if role == "update":
        _moments(core, tid, cand)


def _from_waited_on(t, s):
    on = (t.get("waiting_on") or "").lower()
    frm = s.get("from") or {}
    return bool(on) and on in ((frm.get("name") or "").lower(), (frm.get("email") or "").lower())


def mark_withdrawn(ctx, s):
    core = ctx.core
    rows = core.q(
        "SELECT so.task_id, so.candidate_id FROM sources so JOIN candidates c ON c.id=so.candidate_id "
        "JOIN signals g ON g.key=c.signal_key AND g.user_id=c.user_id WHERE g.user_id=? AND g.source=? AND g.source_id=?",
        (_uid(ctx), s["source"], s["source_id"])).fetchall()
    for r in rows:
        core.q("UPDATE sources SET withdrawn=1 WHERE task_id=? AND candidate_id=?", (r["task_id"], r["candidate_id"]))
        with core.tx():
            events.emit(core, "task.reply_in", task_id=r["task_id"], data={"withdrawn": True},
                        log=("status", f"A {SOURCE_LABEL.get(s['source'], s['source'])} source was deleted. The task stays open."))


def apply_verdicts(ctx, verdicts):
    """Stage 4: turn the judge's verdicts into outcomes, honouring task state."""
    core = ctx.core
    stats = {}
    for v in verdicts:
        cand = core.q("SELECT * FROM candidates WHERE id=? AND user_id=?", (v["candidate_id"], _uid(ctx))).fetchone()
        if cand is None or cand["status"] != "pending":
            stats["skipped"] = stats.get("skipped", 0) + 1
            continue
        verdict = v.get("verdict", "new")
        conf = float(v.get("confidence", 0))
        target = tasks.live(core, v["task_id"]) if v.get("task_id") is not None else None
        other = _is_other(cand)
        tid = target["id"] if target else None
        if verdict == "same" and target and conf >= DUP_CONF:
            st = target["state"]
            if st == "done":
                outcome = "reopened" if v.get("new_ask") else "ignored"
            elif st == "letgo" and other and "theirs" in (target.get("variant_tags") or []):
                outcome = "context"   # still theirs: kept with it, so it has the history if it ever needs you
            elif st == "letgo":
                ts = _signal(ctx, cand).get("ts") or ""
                outcome = "resurfaced" if v.get("new_ask") and ts > (target["state_changed_at"] or "") else "ignored"
            elif conf >= MERGE_CONF:
                outcome = "merged"
            else:
                outcome = "discarded" if other else "possible_duplicate"
        elif verdict == "related" and target:
            outcome = "context" if other else "related"
        else:
            outcome, tid = ("discarded", None) if other else ("new", None)
        res = record(ctx, cand, "judge", outcome, tid, verdict=verdict, confidence=conf,
                     reason=v.get("reason"), scores={"judge": conf}, new_title=v.get("new_title"))
        stats[res["outcome"]] = stats.get(res["outcome"], 0) + 1
    return stats


# ---------------------------------------------------------------- your decisions about matches

def _creation_decision(core, task_id):
    row = core.one("SELECT id FROM decisions WHERE task_id=? AND user_id=? ORDER BY id LIMIT 1", (task_id, core.user_id))
    return row["id"] if row else None


def merge(core, a, b, card=None):
    """Merge task a into task b. Records exactly what moved, so split can undo it."""
    ta, tb = tasks.live(core, a), tasks.live(core, b)
    if not ta or not tb or ta["id"] == tb["id"]:
        raise FuzzError("Both tasks must exist and differ", "task_id")
    a, b = ta["id"], tb["id"]
    with core.tx("human"):
        srcs = core.all("SELECT * FROM sources WHERE task_id=?", (a,))
        anchors = [r["anchor"] for r in core.all("SELECT anchor FROM task_anchors WHERE task_id=?", (a,))]
        b_had = [r["anchor"] for r in core.all("SELECT anchor FROM task_anchors WHERE task_id=?", (b,))]
        for s in srcs:
            core.q("UPDATE sources SET task_id=?, role=? WHERE id=?",
                   (b, "update" if s["role"] == "origin" else s["role"], s["id"]))
        for an in anchors:
            core.q("INSERT OR IGNORE INTO task_anchors VALUES (?,?)", (an, b))
        moved = {"sources": srcs, "anchors": anchors, "prior_state": ta["state"],
                 "anchors_b_had": [x for x in b_had if x not in anchors]}
        mid = core.q("INSERT INTO merges (user_id, into_task, from_task, moved, ts) VALUES (?,?,?,?,?)",
                     (core.user_id, b, a, json.dumps(moved), core.now_iso())).lastrowid
        link = core.one("SELECT kind FROM task_links WHERE (a=? AND b=?) OR (a=? AND b=?)", (a, b, b, a))
        core.q("DELETE FROM task_links WHERE (a=? AND b=?) OR (a=? AND b=?)", (a, b, b, a))
        core.q("INSERT INTO feedback (user_id, ts, kind, a, b, decision_id, note) VALUES (?,?,?,?,?,?,?)",
               (core.user_id, core.now_iso(), "merge", a, b, _creation_decision(core, a), link["kind"] if link else "unlinked"))
        ch = events.Changes()
        tasks.move(core, ch, ta, "merged", card=card, merged_into=b)
        if card:
            cards.mark_answered(core, ch, card, "merge")
        events.emit(core, "task.merged", task_id=b, changes=ch, data={"merge_id": mid, "from": a, "into": b},
                    log=("status", f"Merged #{a} into this task (“{ta['title']}”)."))
    return mid


def unmerge_side_tables(core, merge_id):
    """Put sources and anchors back where they were before a merge. The task rows come back through events."""
    m = core.one("SELECT * FROM merges WHERE id=? AND user_id=? AND undone=0", (merge_id, core.user_id))
    if m is None:
        raise FuzzError(f"No open merge {merge_id}", "merge_id", 404)
    moved = m["moved"] if isinstance(m["moved"], dict) else json.loads(m["moved"])
    a, b = m["from_task"], m["into_task"]
    for s in moved["sources"]:
        core.q("UPDATE sources SET task_id=?, role=? WHERE id=?", (a, s["role"], s["id"]))
    for an in moved["anchors"]:
        if an not in moved.get("anchors_b_had", []):
            core.q("DELETE FROM task_anchors WHERE anchor=? AND task_id=?", (an, b))
        core.q("INSERT OR IGNORE INTO task_anchors VALUES (?,?)", (an, a))
    core.q("UPDATE merges SET undone=1 WHERE id=?", (merge_id,))
    core.q("INSERT INTO feedback (user_id, ts, kind, a, b, note) VALUES (?,?,?,?,?,?)",
           (core.user_id, core.now_iso(), "split", a, b, f"merge {merge_id}"))
    return moved, a, b


def split(core, merge_id):
    """Undo a merge by id (the CLI's `fuzz split`). Undo of the merge itself does the same."""
    with core.tx("human"):
        moved, a, b = unmerge_side_tables(core, merge_id)
        ch = events.Changes()
        ch.task(a, state=moved["prior_state"], merged_into=None, state_changed_at=core.now_iso())
        events.emit(core, "task.split", task_id=b, changes=ch, data={"merge_id": merge_id, "from": a},
                    log=("status", f"Split #{a} back out."))
        cards.sync(core, a)


def keep_separate(core, a, b, card=None, feedback=True):
    with core.tx("human"):
        core.q("DELETE FROM task_links WHERE (a=? AND b=?) OR (a=? AND b=?)", (a, b, b, a))
        core.q("INSERT INTO task_links VALUES (?,?,?,?,?)", (a, b, "kept_separate", None, "You said these differ"))
        if feedback:
            core.q("INSERT INTO feedback (user_id, ts, kind, a, b, decision_id) VALUES (?,?,?,?,?,?)",
                   (core.user_id, core.now_iso(), "keep", a, b, _creation_decision(core, a)))
        if card:
            ch = events.Changes()
            cards.mark_answered(core, ch, card, "keep_separate")
            events.emit(core, "card.answered", task_id=a, changes=ch, data={"kind": "duplicate", "option": "keep_separate"},
                        log=("status", f"You said this is separate from #{b}."))
        cards.sync(core, a)


def create_from_ask(ctx, ask, parent_id=None, links=None, people=None, due=None):
    """The executor's create_task: an ask from Fuzz goes through matching like any other."""
    core = ctx.core
    n = core.one("SELECT COUNT(*) n FROM signals WHERE user_id=? AND source='fuzz'", (core.user_id,))["n"]
    sig = {"source": "fuzz", "source_id": f"task{parent_id or 0}-{n + 1}", "ts": core.now_iso(),
           "from": {"name": "Fuzz"}, "quote": ask, "links": links or [],
           "candidates": [{"ask": ask, "owner": "me", "due": due, "people": people or []}]}
    if parent_id:
        sig["anchor"] = f"fuzz:task{parent_id}:{n + 1}"
    ingest(ctx, [sig])
    stats = propose(ctx)
    key = signal_key(sig)
    row = core.one("SELECT s.task_id FROM sources s JOIN candidates c ON c.id=s.candidate_id "
                   "WHERE c.user_id=? AND c.signal_key=?", (core.user_id, key))
    tid = row["task_id"] if row else None
    if tid and parent_id:
        with core.tx("fuzz:executor"):
            ch = events.Changes()
            ch.task(tid, parent_id=parent_id)
            events.emit(core, "task.notes_saved", task_id=tid, changes=ch, data={"parent_id": parent_id})
            if not tasks.get(core, tid).get("group_id"):
                groups.join_parent(core, tid, parent_id)
    return {"outcome": next(iter(stats), None), "task_id": tid}
