"""Catching the duplicates matching's own passes miss (design: "Catching duplicates").

Three gaps, all closed here with code, no judge:
  - a task you capture never went through matching. After it's gathered (or straight away with gathering
    off) it gets a matching record of its own: a signal and a candidate from its ask and the links Fuzz
    found, kept as a source with role "ignored" so no list shows it. That gives it entities and a vector,
    so later signals can find it, and it's checked against the open tasks now.
  - asks judged in one run couldn't see each other: a shortlist is frozen before earlier candidates in the
    run create their tasks. A "new" verdict is checked against the tasks made since its shortlist froze.
  - a ticket key or document link two tasks share is the identifier that stays the same across email,
    Slack and meetings, so it counts as a match whichever channels they came from. A link on many live
    tasks (a wiki home page) doesn't.
A likely match becomes a duplicate card. likely() also ranks the choices for "Same as…" in task detail.
"""

import json

from .. import cards, events, states, tasks
from . import entities, matcher, vectors

LINK_COMMON = 3                               # a link on more than this many live tasks is too common to count
DUP_SEM = {"hash": 0.75, "ollama": 0.85}      # meaning alone, close enough to ask
SAME_AS_LIMIT = 5


# ---------------------------------------------------------------- identifiers: tickets and document links

def ident(url):
    """A link as an identifier, or None when it's too general to say anything (a site's home page)."""
    i = entities.normalize_url(url or "")
    if i.startswith(("ticket:", "gdoc:")):
        return i
    host, _, path = i.partition("/")
    return f"doc:{i}" if host and path.strip("/") else None


def _idents(links, *texts):
    out = {x for x in (ident(u) for u in links or []) if x}
    out |= {"ticket:" + k for k in entities.tickets_in(*texts)}
    return out


def task_idents(core, t):
    """The tickets and documents a task points to: its link sources, the links of the messages behind it,
    and ticket keys in its title and ask."""
    links = [r["link"] for r in core.all("SELECT link FROM sources WHERE task_id=? AND user_id=? AND role='link' "
                                         "AND withdrawn=0 AND link IS NOT NULL", (t["id"], core.user_id))]
    texts = [t["title"], t["ask"]]   # a dict or a raw row
    for r in core.all("SELECT c.payload cp, g.payload gp FROM sources s JOIN candidates c ON c.id=s.candidate_id "
                      "JOIN signals g ON g.key=c.signal_key AND g.user_id=c.user_id "
                      "WHERE s.task_id=? AND s.user_id=? AND s.withdrawn=0", (t["id"], core.user_id)):
        cp, gp = json.loads(r["cp"] or "{}"), json.loads(r["gp"] or "{}")
        links += (cp.get("links") or []) + (gp.get("links") or [])
        texts += [cp.get("ask"), gp.get("quote")]
    return _idents(links, *texts)


def cand_idents(ctx, cand):
    s = matcher.candidate_signal(ctx, cand)
    c = json.loads(cand["payload"]) if isinstance(cand["payload"], str) else (cand["payload"] or {})
    return _idents((c.get("links") or []) + (s.get("links") or []), cand["ask"], s.get("quote"))


def _shared(core, mine, others):
    """{task_id: [idents shared with mine]}, leaving out idents that are on too many live tasks."""
    idx = {tid: task_idents(core, t) for tid, t in others.items()}
    live = [tid for tid, t in others.items() if t["state"] in states.LIVE]
    common = {i for i in mine if sum(i in idx[tid] for tid in live) > LINK_COMMON}
    return {tid: sorted((mine & ids) - common) for tid, ids in idx.items() if (mine & ids) - common}


# ---------------------------------------------------------------- scoring

def _not_to_ask(core, task_id):
    """Tasks you already said differ from this one, or that it's already being asked about."""
    out = set()
    for r in core.all("SELECT a, b FROM task_links WHERE (a=? OR b=?) AND kind IN ('kept_separate', 'possible_duplicate')",
                      (task_id, task_id)):
        out.add(r["b"] if r["a"] == task_id else r["a"])
    return out


def likely(ctx, cand, others, strict=True):
    """Tasks the candidate is likely the same as, best first: [(task_id, reason, scores)].

    strict: only ones close enough to ask about (a shared ticket or document, or very close in meaning).
    Otherwise the ranked shortlist "Same as…" offers."""
    if not others:
        return []
    fam = matcher._family(ctx.embedder.model) if ctx.embedder else "hash"
    shared = _shared(ctx.core, cand_idents(ctx, cand), others)
    escore, names = matcher.stage2_entities(ctx, cand, others)
    sem = matcher.stage3_semantic(ctx, cand, list(others)) or {}
    out = []
    for tid in others:
        e, s, link = escore.get(tid, 0), sem.get(tid, 0), shared.get(tid)
        close = bool(link) or s >= DUP_SEM[fam] or (e >= matcher.STRONG_ENTITY and s >= matcher.SEM_MIN_ENTITY[fam])
        loose = close or s >= matcher.SEM_FLOOR[fam] or e >= matcher.ENTITY_MIN
        if not (close if strict else loose):
            continue
        why = (f"Both point to {_name(link[0])}" if link else
               f"Same {', '.join(n.split(':', 1)[1] for n in names.get(tid, [])[:2])}" if e >= matcher.STRONG_ENTITY
               else "Asks for nearly the same thing")
        out.append((tid, why, {"link": link or [], "entity": e, "semantic": s}))
    out.sort(key=lambda x: (bool(x[2]["link"]), x[2]["semantic"], x[2]["entity"]), reverse=True)
    return out


def _name(i):
    kind, _, rest = i.partition(":")
    if kind == "ticket":
        return rest
    if kind == "gdoc":
        return "the same Google file"
    return tasks.link_title("https://" + rest)


# ---------------------------------------------------------------- a captured task's matching record

def _captured(core, t):
    return bool(core.one("SELECT id FROM events WHERE user_id=? AND task_id=? AND type='task.captured'",
                         (core.user_id, t["id"])))


def _yours(core):
    return {r["task_id"] for r in core.all("SELECT task_id FROM events WHERE user_id=? AND type='task.captured' "
                                           "AND actor='human'", (core.user_id,))}


def capture_key(task_id):
    return f"capture:task{task_id}:1"


def _cand(core, key):
    """A candidate row as matching reads it (payload still JSON text)."""
    return core.q("SELECT * FROM candidates WHERE user_id=? AND signal_key=?", (core.user_id, key)).fetchone()


def _record(ctx, t):
    """Give a captured task the signal and candidate matching keeps for every other task, once. Returns the candidate."""
    core = ctx.core
    key = capture_key(t["id"])
    row = _cand(core, key)
    if row:
        return row
    links = [r["link"] for r in core.all("SELECT link FROM sources WHERE task_id=? AND user_id=? AND role='link' "
                                         "AND withdrawn=0 AND link IS NOT NULL ORDER BY id", (t["id"], core.user_id))]
    ask = (t.get("ask") or t["title"]).strip()
    sig = {"source": "capture", "source_id": f"task{t['id']}", "version": "1", "quote": ask[:600], "links": links,
           "candidates": [{"ask": ask[:300], "owner": "me", "links": links}]}
    matcher.ingest(ctx, [sig])
    row = _cand(core, key)
    core.q("UPDATE candidates SET status='decided' WHERE id=?", (row["id"],))
    core.q("INSERT OR IGNORE INTO sources (user_id, task_id, candidate_id, signal_key, role, title, added_run) "
           "VALUES (?,?,?,?,?,?,?)", (core.user_id, t["id"], row["id"], key, "ignored", "For matching", ctx.run_id))
    matcher._add_anchors(ctx, t["id"], row)   # a ticket in it is an anchor, as on any other task
    return row


def check_captured(core, task_id, embedder=None):
    """Match a task you captured, once it's been looked up (or straight away with gathering off). A likely
    match becomes a duplicate card, which comes before the task's own card. Returns the other task's id, or None."""
    t = tasks.get(core, task_id)
    if not t or t["state"] not in states.LIVE or not _captured(core, t):
        return None
    ctx = matcher.Context(core, embedder)
    with core.tx("system"):
        cand = _record(ctx, t)
        # Against what arrived from elsewhere: two things you typed yourself are yours to tell apart
        skip = _not_to_ask(core, t["id"]) | {t["id"]} | _yours(core)
        others = {tid: r for tid, r in matcher.eligible_tasks(ctx).items() if tid not in skip and r["state"] in states.LIVE}
        hits = likely(ctx, cand, others)
        if not hits:
            return None
        other, why, scores = hits[0]
        ask(core, t["id"], other, why, scores.get("semantic"))
    return other


def ask(core, task_id, other_id, why, confidence=None):
    """A duplicate card on task_id about other_id, before its own card: the routing card waits until it's answered."""
    core.q("INSERT OR REPLACE INTO task_links VALUES (?,?,?,?,?)", (task_id, other_id, "possible_duplicate", confidence, why))
    open_ = cards.open_cards(core, task_id)
    if any(c["kind"] == "duplicate" for c in open_):
        return None
    ch = events.Changes()
    for c in open_:
        if c["kind"] == "task":
            ch.card(c["id"], status="withdrawn")
    if not ch.empty():
        events.emit(core, "card.updated", task_id=task_id, changes=ch, data={"kind": "task", "why": "duplicate_first"})
    return cards.create(core, "duplicate", task_id, other_id=other_id, reason=why, suggested="merge", where="front")


# ---------------------------------------------------------------- the same run

def run_mates(ctx, cand, frozen_after):
    """Tasks matching made after this candidate's shortlist froze, except asks from the same message."""
    if frozen_after is None:
        return {}
    core = ctx.core
    rows = core.all("SELECT DISTINCT task_id FROM decisions WHERE user_id=? AND id>? AND task_id IS NOT NULL "
                    "AND outcome IN ('new', 'possible_duplicate', 'related')", (core.user_id, frozen_after))
    siblings = matcher._sibling_tasks(ctx, cand)
    out = {}
    for r in rows:
        t = tasks.live(core, r["task_id"])
        if t and t["id"] not in siblings and t["state"] in states.LIVE:
            out[t["id"]] = t
    return out


def same_run(ctx, cand, frozen_after):
    """The task an ask judged new is likely the same as, among those made since its shortlist froze:
    (task_id, reason, semantic) or None."""
    hits = likely(ctx, cand, run_mates(ctx, cand, frozen_after))
    if not hits:
        return None
    tid, why, scores = hits[0]
    return tid, f"{why}, and came in with #{tid} in the same run", scores.get("semantic")


# ---------------------------------------------------------------- "Same as…" in task detail

def same_as_choices(core, task_id, embedder=None):
    """The open tasks this one is most likely the same as, for "Same as…": [{task_id, title, state, why}]."""
    t = tasks.require(core, task_id)
    ctx = matcher.Context(core, embedder)
    with core.tx("system"):
        cand = _candidate_for(ctx, t)
        if cand is None:
            return []
        skip = {r["b"] if r["a"] == t["id"] else r["a"] for r in core.all(
            "SELECT a, b FROM task_links WHERE (a=? OR b=?) AND kind='kept_separate'", (t["id"], t["id"]))} | {t["id"]}
        others = {tid: r for tid, r in matcher.eligible_tasks(ctx).items() if tid not in skip and r["state"] in states.LIVE}
        hits = likely(ctx, cand, others, strict=False)[:SAME_AS_LIMIT]
    return [{"task_id": tid, "title": others[tid]["title"], "state": others[tid]["state"], "why": why}
            for tid, why, _ in hits]


def _candidate_for(ctx, t):
    """The candidate a task came from, or its capture record (made now if a captured task has none)."""
    row = ctx.core.q("SELECT c.* FROM sources s JOIN candidates c ON c.id=s.candidate_id WHERE s.task_id=? "
                     "AND s.user_id=? AND s.role IN ('origin', 'ignored') ORDER BY s.role='origin' DESC, s.id LIMIT 1",
                     (t["id"], ctx.core.user_id)).fetchone()
    if row:
        if vectors.get(ctx.conn, "candidate", row["id"], ctx.embedder.model if ctx.embedder else "") is None and ctx.embed_ok:
            v = ctx.embed([row["ask"] or t["title"]])
            if v:
                vectors.put(ctx.conn, "candidate", row["id"], ctx.embedder.model, v[0])
        return row
    return _record(ctx, t) if _captured(ctx.core, t) else None
