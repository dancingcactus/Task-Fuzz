"""Focus: what you're working on now, said per session (design: "Focus").

It moves those tasks ahead of everything that isn't time-sensitive (a booked block is first while it's
on). The reorder never waits for the AI:

1. Instant, no AI: deliverable names (once there are any), names Fuzz knows (entities and aliases),
   ticket keys, words in titles and asks, and the phrase's meaning against the tasks' stored vectors.
2. Refined by the AI: one tools-free call to a small model with the phrase and a compact task list. It
   can only pick from the ids it was given; an unknown id is refused. A slow or failed pass leaves the
   instant result.

A phrase once resolved is kept (focus_phrases), so it's instant next time. The session's focus ends
when you step away (scheduler.wake) or say otherwise.
"""

import json
import re
import subprocess

from . import events, states
from .db import FuzzError

QUICK = ("small things", "quick ones", "quick things", "small stuff", "quick stuff")
WORD_MIN = 3
SEM_MIN = {"hash": 0.35, "ollama": 0.55}
REFINE_TIMEOUT = 45
PROMPT_VERSION = "focus-0.1"


def _state(core, key):
    row = core.one("SELECT value FROM user_state WHERE user_id=? AND key=?", (core.user_id, key))
    v = (row or {}).get("value")
    return json.loads(v) if isinstance(v, str) and v[:1] in "{[" else None


def current(core):
    """This session's focus: {text, task_ids, terms, deliverables, source, refined, set_at}, or None."""
    return _state(core, "focus")


def norm(text):
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _words(text):
    from .matching.vectors import STOP
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) >= WORD_MIN and w not in STOP
            and w not in {"stuff", "things", "prep", "work", "working", "task", "tasks"}}


def _live(core):
    live = ",".join(f"'{s}'" for s in states.LIVE)
    return {t["id"]: t for t in core.all(f"SELECT * FROM tasks WHERE user_id=? AND state IN ({live})", (core.user_id,))}


def weekly_ids(core):
    """Tasks of this week's active deliverables: the focus when you haven't said one (empty until there are
    deliverables)."""
    try:
        from . import deliverables
    except ImportError:
        return set()
    return deliverables.active_task_ids(core)


def focus_ids(core):
    """The tasks in focus now: this session's, else this week's active deliverables'."""
    cur = current(core)
    if cur and cur.get("task_ids") is not None and cur.get("source") != "skip":
        return set(cur["task_ids"])
    return weekly_ids(core)


# ---------------------------------------------------------------- the instant pass

def _entity_tasks(core, text, live):
    """Tasks that mention a name, ticket or document whose alias is in the phrase."""
    phrase = f" {norm(text)} "
    hits = {}
    for a in core.all("SELECT a.alias, a.entity_id, e.name FROM aliases a JOIN entities e ON e.id=a.entity_id "
                      "WHERE e.user_id=? AND e.redirect_to IS NULL", (core.user_id,)):
        al = norm(a["alias"])
        if len(al) < WORD_MIN or f" {al} " not in phrase:
            continue
        for r in core.all("SELECT DISTINCT s.task_id FROM sources s JOIN mentions m ON m.candidate_id=s.candidate_id "
                          "WHERE m.entity_id=? AND s.user_id=?", (a["entity_id"], core.user_id)):
            if r["task_id"] in live:
                hits.setdefault(r["task_id"], f"Mentions {a['name'] or a['alias']}")
    return hits


def _semantic(core, text, live):
    """The phrase's meaning against each live task's stored vector (its ask), with the local embedder."""
    from .matching import matcher, vectors
    ctx = matcher.Context(core)
    v = ctx.embed([text])
    if not v:
        return {}
    model = ctx.embedder.model
    fam = matcher._family(model)
    rows = core.all("SELECT s.task_id, s.candidate_id FROM sources s WHERE s.user_id=? AND s.candidate_id IS NOT NULL",
                    (core.user_id,))
    rows = [r for r in rows if r["task_id"] in live]
    sims = vectors.similarities(core.conn, v[0], "candidate", [r["candidate_id"] for r in rows], model, ctx.vec_sql)
    out = {}
    for r in rows:
        s = sims.get(r["candidate_id"])
        if s is not None and s >= SEM_MIN[fam]:
            out[r["task_id"]] = max(out.get(r["task_id"], 0), s)
    return out


def match(core, text):
    """The instant pass: [{task_id, title, why}], best first, and whether the phrase means "the quick ones"."""
    from .matching import entities
    text = (text or "").strip()
    if not text:
        return {"tasks": [], "quick": False}
    if any(q in norm(text) for q in QUICK):
        return {"tasks": [], "quick": True}
    live = _live(core)
    found = {}
    saved = (_state(core, "focus_phrases") or {}).get(norm(text))
    if saved:   # resolved before: instant
        for tid in saved.get("task_ids") or []:
            if tid in live:
                found[tid] = "Like last time"
        text_terms = " ".join(saved.get("terms") or [])
    else:
        text_terms = ""
    try:
        from . import deliverables
        for tid, why in deliverables.match(core, text).items():
            if tid in live:
                found.setdefault(tid, why)
    except ImportError:
        pass
    keys = entities.tickets_in(text)
    for tid, t in live.items():
        if any(k in f"{t['title']} {t.get('ask') or ''}" for k in keys):
            found.setdefault(tid, f"About {', '.join(keys)}")
    for tid, why in _entity_tasks(core, f"{text} {text_terms}", live).items():
        found.setdefault(tid, why)
    words = _words(f"{text} {text_terms}")
    for tid, t in live.items():
        shared = words & _words(f"{t['title']} {t.get('ask') or ''}")
        if shared:
            found.setdefault(tid, f"Says “{sorted(shared)[0]}”")
    sem = _semantic(core, text, live)
    for tid in sorted(sem, key=lambda x: -sem[x]):
        found.setdefault(tid, "Close in meaning")
    return {"tasks": [{"task_id": tid, "title": live[tid]["title"], "why": why} for tid, why in found.items()],
            "quick": False}


# ---------------------------------------------------------------- saying it

def set_focus(core, text=None, task_ids=None, skip=False, source="session"):
    """You said what you're working on (POST /focus). task_ids: the matches you confirmed (the preview minus
    any "not that one"); without them, the instant pass decides. skip: you pressed Esc; the week's focus
    stands. "Clear the small things" sets the quick moment instead."""
    text = (text or "").strip()[:200]
    live = _live(core)
    ch = events.Changes()
    if skip:
        ch.state("focus", json.dumps({"source": "skip", "text": None, "task_ids": None, "set_at": core.now_iso()}))
        with core.tx("human"):
            events.emit(core, "focus.set", changes=ch, data={"skip": True})
        return current(core)
    m = match(core, text)
    if m["quick"]:
        ch.state("moment", "quick")
        ch.state("focus", json.dumps({"source": source, "text": text, "task_ids": None, "quick": True, "set_at": core.now_iso()}))
        with core.tx("human"):
            events.emit(core, "focus.set", changes=ch, data={"text": text, "quick": True},
                        log=None)
        return current(core)
    if task_ids is None:
        ids = [x["task_id"] for x in m["tasks"]]
    else:
        if not isinstance(task_ids, list) or not all(isinstance(i, int) for i in task_ids):
            raise FuzzError("task_ids is a list of the task ids you confirmed", "task_ids")
        unknown = [i for i in task_ids if i not in live]
        if unknown:
            raise FuzzError(f"Not an open task of yours: {unknown}", "task_ids")
        ids = list(task_ids)
    state = {"source": source, "text": text, "task_ids": ids, "terms": [], "deliverables": [], "refined": False,
             "set_at": core.now_iso()}
    ch.state("focus", json.dumps(state))
    with core.tx("human"):
        events.emit(core, "focus.set", changes=ch, data={"text": text, "tasks": len(ids)})
    return current(core)


def clear(core, why="away"):
    """The session's over (you stepped away): the week's focus comes back."""
    if current(core) is None:
        return False
    with core.tx("system"):
        ch = events.Changes()
        ch.state("focus", None)
        events.emit(core, "focus.cleared", changes=ch, data={"why": why})
    return True


# ---------------------------------------------------------------- the AI pass

def refine(core, text, result):
    """Apply the AI pass: {"in": [ids], "maybe": [ids], "terms": [...], "deliverables": [ids]}. It may only
    pick from open tasks; an unknown id is refused. The phrase is saved, so next time it's instant.
    Returns the task ids it added to the focus."""
    if not isinstance(result, dict):
        raise FuzzError("The refined result is {in, maybe, terms, deliverables}", "result")
    live = _live(core)
    picked = [i for i in (result.get("in") or []) + (result.get("maybe") or [])]
    if not all(isinstance(i, int) for i in picked):
        raise FuzzError("in and maybe are lists of task ids", "result.in")
    unknown = [i for i in picked if i not in live]
    if unknown:
        raise FuzzError(f"The AI named tasks that aren't open: {unknown}", "result.in")
    terms = [t.strip()[:60] for t in result.get("terms") or [] if isinstance(t, str) and t.strip()][:10]
    phrases = _state(core, "focus_phrases") or {}
    phrases[norm(text)] = {"task_ids": list(result.get("in") or []), "terms": terms,
                           "deliverables": list(result.get("deliverables") or [])}
    cur = current(core)
    ch = events.Changes()
    ch.state("focus_phrases", json.dumps(phrases))
    added = []
    if cur and norm(cur.get("text")) == norm(text):
        have = list(cur.get("task_ids") or [])
        added = [i for i in result.get("in") or [] if i not in have]
        dropped = set(result.get("drop") or [])
        cur.update(task_ids=[i for i in have if i not in dropped] + added, terms=terms,
                   deliverables=list(result.get("deliverables") or []), refined=True, added=added)
        ch.state("focus", json.dumps(cur))
    with core.tx("system"):
        events.emit(core, "focus.refined", changes=ch, data={"text": text, "added": added},
                    actor="system")
    return added


def prompt(core, text):
    """What the one-shot gets: the phrase and a compact list of open tasks."""
    live = _live(core)
    rows = []
    for t in list(live.values())[:150]:
        rows.append({"id": t["id"], "title": t["title"][:100], "group": t.get("group_id"),
                     "deliverable": t.get("deliverable_id")})
    return (
        "You help sort a to-do list. The person said what they're working on now. From the tasks below, pick "
        "the ones that belong to it. Reply with one JSON object and nothing else: "
        '{"in": [ids that clearly belong], "maybe": [ids that might], "terms": [names and words that mark this '
        'focus], "deliverables": [ids]}. Use only ids from the list.\n\n'
        f"They said: {json.dumps(text)}\n\nTasks: {json.dumps(rows)}")


def _parse(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise FuzzError("The AI pass didn't return JSON", "result")
    try:
        return json.loads(m.group(0))
    except ValueError:
        raise FuzzError("The AI pass returned broken JSON", "result")


def ai_pass(core, text, runner=None, timeout=REFINE_TIMEOUT, lock=None):
    """One tools-free call to a small model, the shape of connector discovery. runner(argv, prompt) -> output
    text, for tests. A slow or failed pass changes nothing (the instant order stands). lock: held only while
    reading and writing the store, never while the model runs. Returns the ids added, or None when it didn't work."""
    from contextlib import nullcontext
    from . import adapters
    from .config import role_engine
    lock = lock or nullcontext()
    with lock:
        client, model = role_engine(core.config, "executor")
        cfg = core.config.get("focus") or {}
        p = prompt(core, text)
    if runner is None and client not in adapters.ADAPTERS:
        return None
    try:
        if runner is not None:
            out = runner(None, p)
        else:
            adapter = adapters.get(client)
            fmodel = cfg.get("model") or ("haiku" if client == "claude-code" else model)
            argv = adapter.discovery_command(p, fmodel)
            out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=core.home).stdout
        result = _parse(out)
        with lock:
            return refine(core, text, result)
    except (FuzzError, subprocess.TimeoutExpired, OSError, ValueError) as e:
        print(f"focus AI pass skipped: {e}")
        return None


def chips(core):
    """What the session question offers: this week's active deliverables, last session's focus, and
    "Whatever's next"."""
    out = []
    try:
        from . import deliverables
        out += [{"label": d["title"], "deliverable_id": d["id"]} for d in deliverables.active(core)]
    except ImportError:
        pass
    last = core.one("SELECT payload FROM events WHERE user_id=? AND type='focus.set' ORDER BY id DESC LIMIT 1", (core.user_id,))
    text = ((last or {}).get("payload") or {}).get("data", {}).get("text") if last else None
    if text:
        out.append({"label": text, "text": text})
    out.append({"label": "Whatever’s next", "skip": True})
    return out
