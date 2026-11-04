"""Deliverables: named outcomes served by tasks from any channel (design: "Deliverables").

A deliverable has a title, a done-when Fuzz can check with its tools (or checked_by = you), optionally who
it's for and a date, a tier (active: this week's 2 or 3; background: the rest) and a state (open, done,
dropped). Tasks point to it with deliverable_id, and show a "For …" line.

Fuzz suggests deliverables (tasks that share a ticket or a document, "New and loose"); you confirm and
name them. It checks a done-when on Mondays, on a deliverable's weekday card and when one of its tasks
closes: the executor sees which in whoami (deliverables_to_check) and reports report_deliverable_done(id,
evidence), which closes it with Undo, or that it can't reach the evidence, which asks you instead.

On Mondays (deliverables.review_day), after your first check-in, a short run of cards comes first: last
week per active deliverable, pick this week's active ones, this week's steps, and new and loose. On a
rough Monday only the pick comes. Tuesday to Friday, background deliverables come one card each, longest
unchecked first, sized by your check-in like the parked review.
"""

import json
from datetime import timedelta

from . import cards, events, states, timeres
from .db import FuzzError, iso, parse_iso

KINDS = ("part_of", "deliverable", "deliverable_new", "week_plan")
TITLE_MAX = 120
ACTIVITY = ("work on", "support", "drive", "help with", "help ")


def _cfg(core):
    d = core.config.get("deliverables") or {}
    return {"review_day": d.get("review_day", "monday"), "active_max": d.get("active_max", 3),
            "per_day": d.get("per_day", {"good": 3, "okay": 1}), "new_min": d.get("new_min", 3)}


def get(core, did):
    return core.one("SELECT * FROM deliverables WHERE id=? AND user_id=?", (int(did), core.user_id))


def require(core, did):
    d = get(core, did)
    if d is None:
        raise FuzzError(f"No deliverable {did}", "deliverable_id", 404)
    return d


def open_ones(core):
    return core.all("SELECT * FROM deliverables WHERE user_id=? AND state='open' ORDER BY tier='active' DESC, id", (core.user_id,))


def active(core):
    return [d for d in open_ones(core) if d["tier"] == "active"]


def tasks_of(core, did, live_only=False):
    rows = core.all("SELECT * FROM tasks WHERE user_id=? AND deliverable_id=? AND state!='merged' ORDER BY id", (core.user_id, did))
    return [t for t in rows if t["state"] in states.LIVE] if live_only else rows


def active_task_ids(core):
    """This week's focus when you haven't said one: the open tasks of the active deliverables."""
    out = set()
    for d in active(core):
        out |= {t["id"] for t in tasks_of(core, d["id"], live_only=True)}
    return out


def match(core, text):
    """Focus's instant pass: deliverables whose title shares words with the phrase -> {task_id: why}."""
    from .focus import _words
    words = _words(text)
    out = {}
    for d in open_ones(core):
        if words & _words(d["title"]) or (d.get("for_name") and words & _words(d["for_name"])):
            for t in tasks_of(core, d["id"], live_only=True):
                out.setdefault(t["id"], f"For {d['title']}")
    return out


def check_done_when(text):
    """The rubric's first rule, as code: a state, not an activity. Returns the cleaned text."""
    t = (text or "").strip()
    if not t:
        raise FuzzError("done_when says what's true once it's delivered, like “REP-118 is Done and in the release notes”",
                        "done_when")
    if any(t.lower().startswith(a) for a in ACTIVITY):
        raise FuzzError("done_when is a state, not an activity: say what's true when it's done (“NW-342 is accepted”), "
                        "not “work on …”", "done_when")
    return t[:300]


def view(core, d):
    """The deliverable sheet: its open tasks, what's done, the links its tasks cite most, and the people."""
    ts = tasks_of(core, d["id"])
    links = {}
    for t in ts:
        for s in core.all("SELECT title, link FROM sources WHERE task_id=? AND user_id=? AND role='link' AND withdrawn=0",
                          (t["id"], core.user_id)):
            k = s["link"]
            links.setdefault(k, {"title": s["title"], "link": k, "n": 0})["n"] += 1
    people = {}
    from . import people as people_mod
    for t in ts:
        for p in people_mod.for_task(core, t):
            people.setdefault(p["name"], p.get("email"))
    return {"id": d["id"], "title": d["title"], "done_when": d["done_when"], "checked_by": d["checked_by"],
            "for": d.get("for_name"), "due": d.get("due"), "tier": d["tier"], "state": d["state"],
            "evidence": d.get("evidence"), "reviewed_at": d.get("reviewed_at"),
            "open": [{"id": t["id"], "title": t["title"], "state": t["state"]} for t in ts if t["state"] in states.LIVE],
            "done": [{"id": t["id"], "title": t["title"], "state": t["state"], "summary": t.get("summary")}
                     for t in ts if t["state"] in ("done", "letgo")],
            "links": sorted(links.values(), key=lambda x: -x["n"])[:5],
            "people": [{"name": n, "email": e} for n, e in list(people.items())[:8]]}


# ---------------------------------------------------------------- making, linking, closing

def create(core, title, done_when, task_ids=(), checked_by="fuzz", for_name=None, due=None, tier="background",
           actor="human", card=None, value=None):
    title = (title or "").strip()[:TITLE_MAX]
    if not title:
        raise FuzzError("title names what you're delivering, like “The report builder launch”", "title")
    if checked_by not in ("fuzz", "you"):
        raise FuzzError("checked_by is fuzz or you", "checked_by")
    done_when = check_done_when(done_when)
    if tier not in ("active", "background"):
        raise FuzzError("tier is active or background", "tier")
    from . import tasks
    with core.tx(actor):
        did = core.new_id("deliverables")
        ch = events.Changes()
        ch.deliverable(did, title=title, done_when=done_when, checked_by=checked_by, for_name=for_name, due=due,
                       tier=tier, state="open", created_at=core.now_iso(), reviewed_at=core.now_iso(), check_due=0)
        for tid in task_ids or []:
            t = tasks.require(core, tid)
            ch.task(t["id"], deliverable_id=did)
        if card:
            cards.mark_answered(core, ch, card, "track", value)
        events.emit(core, "deliverable.created", changes=ch, data={"deliverable_id": did, "tasks": list(task_ids or [])},
                    log=None)
    return did


def link(core, task_id, did, actor="human", card=None, quiet=False):
    """The task is part of the deliverable: its "For …" line. Undo takes it out again."""
    from . import tasks
    t = tasks.require(core, task_id)
    d = require(core, did)
    with core.tx(actor):
        ch = events.Changes()
        ch.task(t["id"], deliverable_id=d["id"], maybe_deliverable_id=None)
        if card:
            cards.mark_answered(core, ch, card, "yes")
        events.emit(core, "deliverable.linked", task_id=t["id"], changes=ch, data={"deliverable_id": d["id"], "quiet": quiet},
                    log=("status", f"Part of {d['title']}."))
        if card:
            cards.sync(core, t["id"])


def unlink(core, task_id):
    from . import tasks
    t = tasks.require(core, task_id)
    if not t.get("deliverable_id"):
        raise FuzzError("This task isn't part of a deliverable", "task_id", 409)
    d = get(core, t["deliverable_id"])
    with core.tx("human"):
        ch = events.Changes()
        ch.task(t["id"], deliverable_id=None)
        events.emit(core, "deliverable.unlinked", task_id=t["id"], changes=ch, data={"deliverable_id": t["deliverable_id"]},
                    log=("status", f"You took this out of {d['title'] if d else 'its deliverable'}."))


def set_tier(core, did, tier, actor="human", card=None):
    d = require(core, did)
    if tier not in ("active", "background"):
        raise FuzzError("tier is active or background", "tier")
    with core.tx(actor):
        ch = events.Changes()
        ch.deliverable(d["id"], tier=tier, reviewed_at=core.now_iso())
        if card:
            cards.mark_answered(core, ch, card, "make_active" if tier == "active" else "background")
        events.emit(core, "deliverable.tier_set", changes=ch, data={"deliverable_id": d["id"], "tier": tier})


def _close(core, d, state, evidence, actor, card=None, option=None):
    """Done or let go: its open tasks come up next, each to keep on its own or let go."""
    from . import tasks
    typ = "deliverable.done" if state == "done" else "deliverable.dropped"
    with core.tx(actor):
        ch = events.Changes()
        ch.deliverable(d["id"], state=state, evidence=evidence, check_due=0, reviewed_at=core.now_iso())
        if card:
            cards.mark_answered(core, ch, card, option)
        events.emit(core, typ, changes=ch, data={"deliverable_id": d["id"], "evidence": evidence, "title": d["title"]})
        for t in tasks_of(core, d["id"], live_only=True):
            why = f"{d['title']} is {'done' if state == 'done' else 'let go'}. Keep this on its own, or let it go?"
            if t["state"] == "triage":
                ch = events.Changes()
                ch.task(t["id"], reason=why, order_key=tasks.next_order(core, "front"))
                events.emit(core, "task.came_back", task_id=t["id"], changes=ch, log=("status", why))
            elif t["state"] in ("scheduled", "parked", "waiting"):
                tasks.bring_back(core, t["id"], where="front", reason=why, type="task.came_back", actor=actor, tags=("returning",))


def report_done(core, did, evidence, actor="fuzz:executor"):
    """The executor checked the done-when and it's true: closed, with the evidence, and Undo."""
    d = require(core, did)
    if d["checked_by"] == "you":
        raise FuzzError(f"“{d['title']}” is checked by the person, not Fuzz: don't close it", "deliverable_id", 409)
    if d["state"] != "open":
        raise FuzzError(f"“{d['title']}” is already {d['state']}", "deliverable_id", 409)
    if not (evidence or "").strip():
        raise FuzzError("evidence says what you saw, like “REP-118 is Done and in the release notes”", "evidence")
    _close(core, d, "done", evidence.strip()[:300], actor)
    return {"state": "done"}


def cant_check(core, did, why, actor="fuzz:executor"):
    """Fuzz couldn't reach the evidence: it asks you on the next card rather than guessing."""
    d = require(core, did)
    with core.tx(actor):
        ch = events.Changes()
        ch.deliverable(d["id"], check_due=0)
        events.emit(core, "deliverable.reviewed", changes=ch, data={"deliverable_id": d["id"], "cant_check": (why or "")[:200]})
        ask(core, d, "looks_done", reason=f"Fuzz couldn't check: {(why or '').strip()[:200]}" if why else None)


def to_check(core):
    """The deliverables whose done-when Fuzz should check this run (whoami): Monday, the weekday card, or a
    task of theirs closed."""
    return [{"id": d["id"], "title": d["title"], "done_when": d["done_when"]}
            for d in open_ones(core) if d.get("check_due") and d["checked_by"] == "fuzz"]


def mark_check(core, ch, did):
    """A task of this deliverable just closed: Fuzz checks the done-when on its next run."""
    if did:
        ch.deliverable(did, check_due=1)


def list_for_report(core, since=None):
    """list_deliverables(since): open deliverables with tier, done-when and what moved on each since then
    (tasks done, tasks added), for the weekly report and the Monday look-back."""
    since = since or iso(core.now() - timedelta(days=7))
    out = []
    for d in open_ones(core):
        ts = tasks_of(core, d["id"])
        out.append({"id": d["id"], "title": d["title"], "tier": d["tier"], "done_when": d["done_when"], "for": d.get("for_name"),
                    "due": d.get("due"), "moved": moved(core, d, since),
                    "open": [{"id": t["id"], "title": t["title"], "state": t["state"]} for t in ts if t["state"] in states.LIVE]})
    return out


def moved(core, d, since):
    ts = tasks_of(core, d["id"])
    done = [t["title"] for t in ts if t["state"] == "done" and (t.get("state_changed_at") or "") >= since]
    added = [t["title"] for t in ts if (t.get("created_at") or "") >= since and t["state"] in states.LIVE]
    blocked = [t["title"] for t in ts if t["state"] == "waiting" or ("handed_back" in (t.get("variant_tags") or []) and t["state"] == "triage")]
    return {"done": done, "added": added, "blocked": blocked}


def lookback(core, d, since):
    m = moved(core, d, since)
    parts = []
    if m["done"]:
        parts.append(f"Done: {', '.join(m['done'][:3])}" + (f" and {len(m['done']) - 3} more" if len(m["done"]) > 3 else "") + ".")
    if m["added"]:
        parts.append(f"New: {', '.join(m['added'][:3])}.")
    if m["blocked"]:
        parts.append(f"Waiting: {', '.join(m['blocked'][:2])}.")
    return " ".join(parts) or "Nothing moved last week."


# ---------------------------------------------------------------- the cards

def ask(core, d, what, reason=None, monday=False):
    """A deliverable card: lookback (last week), weekday (still moving?), looks_done (close it?), or reopen
    (a new ask for a finished one). Runs inside the caller's transaction."""
    prompts = {"lookback": f"Last week on {d['title']}", "weekday": f"Still moving: {d['title']}?",
               "looks_done": f"Looks done. Close {d['title']}?", "reopen": f"A new ask came in for {d['title']}, which is done."}
    options = {"lookback": ["keep_going", "its_done", "let_go", "not_sure"],
               "weekday": ["keep_going", "make_active", "its_done", "let_go", "not_sure"],
               "looks_done": ["its_done", "keep_going", "not_sure"],
               "reopen": ["reopen", "new_one", "not_sure"]}[what]
    suggested = {"lookback": "keep_going", "weekday": "keep_going", "looks_done": "its_done", "reopen": "reopen"}[what]
    for c in core.all("SELECT * FROM cards WHERE user_id=? AND kind='deliverable' AND status='open'", (core.user_id,)):
        if (c.get("payload") or {}).get("deliverable_id") == d["id"]:
            return c["id"]
    return cards.create(core, "deliverable", None, prompt=prompts[what], reason=reason, suggested=suggested,
                        payload={"deliverable_id": d["id"], "ask": what, "options": options, "monday": monday})


def answer(core, card, option, value=None):
    """The answers in "What each answer writes" for part_of, deliverable, deliverable_new and week_plan."""
    p = card.get("payload") or {}
    kind = card["kind"]
    if kind == "part_of":
        if option == "yes":
            return link(core, card["task_id"], p["deliverable_id"], card=card)
        with core.tx("human"):   # no: not asked again for this pair
            ch = events.Changes()
            cards.mark_answered(core, ch, card, "no")
            ch.task(card["task_id"], maybe_deliverable_id=None)
            core.q("INSERT INTO feedback (user_id, ts, kind, a, b, note) VALUES (?,?,?,?,?,?)",
                   (core.user_id, core.now_iso(), "not_part", card["task_id"], p["deliverable_id"], "part_of card"))
            events.emit(core, "card.answered", task_id=card["task_id"], changes=ch, data={"kind": "part_of", "option": "no"})
            cards.sync(core, card["task_id"])
        return
    if kind == "deliverable":
        d = require(core, p["deliverable_id"])
        if option == "keep_going":
            with core.tx("human"):
                ch = events.Changes()
                ch.deliverable(d["id"], reviewed_at=core.now_iso())
                cards.mark_answered(core, ch, card, option)
                events.emit(core, "deliverable.reviewed", changes=ch, data={"deliverable_id": d["id"]})
            return
        if option == "make_active":
            return set_tier(core, d["id"], "active", card=card)
        if option == "its_done":
            return _close(core, d, "done", "You said it's done.", "human", card, option)
        if option == "let_go":
            return _close(core, d, "dropped", None, "human", card, option)
        if option == "reopen":
            with core.tx("human"):
                ch = events.Changes()
                ch.deliverable(d["id"], state="open", evidence=None)
                cards.mark_answered(core, ch, card, option)
                for tid in p.get("tasks") or []:
                    ch.task(tid, deliverable_id=d["id"])
                events.emit(core, "deliverable.reopened", changes=ch, data={"deliverable_id": d["id"]})
            return
        if option == "new_one":
            v = value if isinstance(value, dict) else {}
            return create(core, v.get("title") or f"{d['title']} v2", v.get("done_when") or d["done_when"],
                          task_ids=p.get("tasks") or [], for_name=d.get("for_name"), card=card, value=value)
    if kind == "deliverable_new":
        if option == "track":
            v = value if isinstance(value, dict) else {}
            return create(core, v.get("title") or p.get("title"), v.get("done_when") or p.get("done_when"),
                          task_ids=p.get("task_ids") or [], checked_by=v.get("checked_by") or "fuzz", card=card, value=value)
        with core.tx("human"):   # no
            ch = events.Changes()
            cards.mark_answered(core, ch, card, "no")
            core.q("INSERT INTO feedback (user_id, ts, kind, note) VALUES (?,?,?,?)",
                   (core.user_id, core.now_iso(), "not_deliverable", json.dumps(p.get("task_ids") or [])))
            events.emit(core, "card.answered", changes=ch, data={"kind": "deliverable_new", "option": "no"})
        return
    if kind == "week_plan":
        if option == "keep_these":
            ids = value if isinstance(value, list) else p.get("suggested") or []
            mx = _cfg(core)["active_max"]
            if len(ids) > mx:
                raise FuzzError(f"Pick at most {mx} for this week", "value")
            with core.tx("human"):
                ch = events.Changes()
                for d in open_ones(core):
                    tier = "active" if d["id"] in ids else "background"
                    if d["tier"] != tier:
                        ch.deliverable(d["id"], tier=tier, reviewed_at=core.now_iso())
                cards.mark_answered(core, ch, card, option, ids)
                events.emit(core, "deliverable.tier_set", changes=ch, data={"active": ids})
            return
        if option == "keep_steps":
            from . import tasks
            steps = value if isinstance(value, dict) else {}
            with core.tx("human"):
                ch = events.Changes()
                cards.mark_answered(core, ch, card, option, value)
                events.emit(core, "card.answered", changes=ch, data={"kind": "week_plan", "option": option})
                for did, texts in steps.items():
                    d = require(core, int(did))
                    for text in texts or []:
                        tid = tasks.capture(core, text, actor="human")
                        ch2 = events.Changes()
                        ch2.task(tid, deliverable_id=d["id"])
                        events.emit(core, "deliverable.linked", task_id=tid, changes=ch2, data={"deliverable_id": d["id"]},
                                    log=("status", f"Part of {d['title']}."))
            return
        with core.tx("human"):   # not now
            ch = events.Changes()
            cards.mark_answered(core, ch, card, option)
            events.emit(core, "card.answered", changes=ch, data={"kind": "week_plan", "option": option})
        return
    raise FuzzError(f"option {option} isn't an answer on this card", "option")


# ---------------------------------------------------------------- joining tasks from matching

def from_verdict(core, task_id, did, confidence, merge_conf):
    """The judge said "part of deliverable D". Confident: linked quietly. Unsure: a part_of card now for an
    active one; for a background one it waits for that deliverable's next card. A finished one comes up in
    that week's review: reopen it, or start a new one."""
    d = get(core, did)
    if d is None:
        return None
    if d["state"] != "open":
        with core.tx("system"):
            c = ask(core, d, "reopen", reason="Reopen it, or start a new deliverable?")
            card = cards.get(core, c)
            ch = events.Changes()
            ch.card(c, payload=dict(card.get("payload") or {}, tasks=sorted(set((card.get("payload") or {}).get("tasks", []) + [task_id]))))
            events.emit(core, "card.updated", changes=ch, data={"kind": "deliverable", "added": task_id})
        return "reopen"
    if confidence >= merge_conf:
        link(core, task_id, d["id"], actor="system", quiet=True)
        return "linked"
    with core.tx("system"):
        ch = events.Changes()
        ch.task(task_id, maybe_deliverable_id=d["id"])
        events.emit(core, "card.updated", task_id=task_id, changes=ch, data={"maybe_deliverable": d["id"]})
        if d["tier"] == "active":
            _part_of_card(core, task_id, d)
    return "asked" if d["tier"] == "active" else "waiting"


def _part_of_card(core, task_id, d):
    for c in cards.open_cards(core, task_id):
        if c["kind"] == "part_of":
            return c["id"]
    ch = events.Changes()
    for c in cards.open_cards(core, task_id):   # the question comes before its routing card
        if c["kind"] == "task":
            ch.card(c["id"], status="withdrawn")
    if not ch.empty():
        events.emit(core, "card.updated", task_id=task_id, changes=ch, data={"kind": "task", "why": "part_of_first"})
    return cards.create(core, "part_of", task_id, prompt=f"Is this part of {d['title']}?", payload={"deliverable_id": d["id"]},
                        suggested="yes", where="front")


def choices(core, task_id):
    """"Part of…" in task detail: the open deliverables, likeliest first (shared words with the task)."""
    from .focus import _words
    from . import tasks
    t = tasks.require(core, task_id)
    words = _words(f"{t['title']} {t.get('ask') or ''}")
    ds = open_ones(core)
    ds.sort(key=lambda d: -len(words & _words(f"{d['title']} {d.get('for_name') or ''}")))
    return [{"deliverable_id": d["id"], "title": d["title"], "tier": d["tier"]} for d in ds]


# ---------------------------------------------------------------- new and loose: suggesting deliverables

def suggest_new(core):
    """Tasks that look like one thing you're delivering: three or more live tasks, in no deliverable, that
    share a ticket key or a document. [{task_ids, title, done_when}]."""
    from .matching import dupes
    live = [t for t in core.all("SELECT * FROM tasks WHERE user_id=? AND deliverable_id IS NULL AND state!='merged'",
                                (core.user_id,)) if t["state"] in states.LIVE]
    by = {}
    for t in live:
        for i in dupes.task_idents(core, t):
            by.setdefault(i, []).append(t)
    said_no = {r["note"] for r in core.all("SELECT note FROM feedback WHERE user_id=? AND kind='not_deliverable'", (core.user_id,))}
    out, used = [], set()
    for ident, ts in sorted(by.items(), key=lambda x: -len(x[1])):
        ids = sorted({t["id"] for t in ts} - used)
        if len(ids) < _cfg(core)["new_min"] or json.dumps(ids) in said_no:
            continue
        used |= set(ids)
        name = dupes._name(ident)
        out.append({"task_ids": ids, "title": name,
                    "done_when": f"{name} is Done" if ident.startswith("ticket:") else None})
    return out


# ---------------------------------------------------------------- the clock: Monday and the weekdays

def _today(core):
    return core.now().astimezone(timeres.local_tz(core))


def _released_today(core, what):
    start = iso(_today(core).replace(hour=0, minute=0, second=0, microsecond=0))
    rows = core.all("SELECT payload FROM cards WHERE user_id=? AND kind IN ('deliverable', 'week_plan', 'deliverable_new') "
                    "AND created_at>=?", (core.user_id, start))
    return [r for r in rows if (r.get("payload") or {}).get("release") == what]


def release(core):
    """Run by the clock. Monday after the first check-in: last week per active deliverable, the pick, this
    week's steps, and new and loose (a rough Monday: only the pick, the rest on Tuesday). Tuesday to Friday:
    background deliverables one card each, sized by the check-in. Returns how many cards came out."""
    from . import review
    energy = review.energy_today(core)
    if energy is None or not open_ones(core) and not suggest_new(core):
        return 0
    day = _today(core)
    names = timeres.DAYS
    review_day = names.index(_cfg(core)["review_day"])
    rough = energy in ("tired", "overloaded")
    n = 0
    tuesday_rest = day.weekday() == (review_day + 1) % 7 and core.one(
        "SELECT 1 x FROM cards WHERE user_id=? AND kind='week_plan' AND json_extract(payload, '$.rest_later')=1 "
        "AND created_at>=?", (core.user_id, iso(day - timedelta(days=1))))
    if day.weekday() == review_day and not _released_today(core, "monday"):
        with core.tx("system"):
            if not rough:
                n += _monday_rest(core)
            ds = open_ones(core)
            suggested = sorted(ds, key=lambda d: (d["tier"] != "active", d.get("due") or "9999", -len(moved(
                core, d, iso(core.now() - timedelta(days=7)))["added"])))[:min(3, _cfg(core)["active_max"])]
            if ds:
                cards.create(core, "week_plan", None, prompt="Which are this week’s active ones?",
                             reason="Their tasks come first this week. You can swap one from its sheet any day.",
                             suggested="keep_these", payload={"release": "monday", "monday": True, "rest_later": rough,
                                                              "suggested": [d["id"] for d in suggested],
                                                              "all": [{"id": d["id"], "title": d["title"], "tier": d["tier"]} for d in ds]})
                n += 1
            for d in ds:
                if d["checked_by"] == "fuzz":
                    events.emit(core, "deliverable.reviewed", changes={"deliverables": {str(d["id"]): {"check_due": 1}}},
                                data={"deliverable_id": d["id"], "check": "monday"})
        return n
    if tuesday_rest and not _released_today(core, "monday"):
        with core.tx("system"):
            return _monday_rest(core)
    if day.weekday() < 5 and day.weekday() != review_day:
        share = _cfg(core)["per_day"].get(energy, 0) - len(_released_today(core, "weekday"))
        due = sorted([d for d in open_ones(core) if d["tier"] == "background"
                      and parse_iso(d.get("reviewed_at") or d["created_at"]) < core.now() - timedelta(days=6)],
                     key=lambda d: d.get("reviewed_at") or d["created_at"])
        for d in due[:max(0, share)]:
            with core.tx("system"):
                c = ask(core, d, "weekday")
                card = cards.get(core, c)
                ch = events.Changes()
                ch.card(c, payload=dict(card.get("payload") or {}, release="weekday"))
                ch.deliverable(d["id"], check_due=1 if d["checked_by"] == "fuzz" else 0)
                events.emit(core, "card.updated", changes=ch, data={"kind": "deliverable", "weekday": True})
                for t in core.all("SELECT * FROM tasks WHERE user_id=? AND maybe_deliverable_id=? AND state!='merged'",
                                  (core.user_id, d["id"])):
                    if t["state"] in states.LIVE:   # "Is this part of it?"
                        _part_of_card(core, t["id"], d)
            n += 1
    return n


def _monday_rest(core):
    """Monday's steps 1, 3 and 4: last week per active deliverable, this week's steps, and new and loose."""
    n = 0
    since = iso(core.now() - timedelta(days=7))
    for d in active(core):
        ask(core, d, "lookback", reason=lookback(core, d, since), monday=True)
        n += 1
    act = active(core)
    if act:
        cards.create(core, "week_plan", None, prompt="This week’s steps?", suggested="keep_steps",
                     reason="Add the next tasks for each active deliverable. The ones you keep go into triage, linked.",
                     payload={"release": "monday", "monday": True, "steps": True,
                              "all": [{"id": d["id"], "title": d["title"],
                                       "open": [t["title"] for t in tasks_of(core, d["id"], live_only=True)]} for d in act]})
        n += 1
    for s in suggest_new(core):
        cards.create(core, "deliverable_new", None, prompt=f"These {len(s['task_ids'])} look like one thing you’re delivering. "
                     f"Track them as {s['title']}?",
                     reason=None if s["done_when"] else "How will we know it’s done? Name the evidence Fuzz can check.",
                     suggested="track", payload=dict(s, release="monday", monday=True))
        n += 1
    for d in open_ones(core):   # tasks Fuzz was unsure belonged
        for t in core.all("SELECT * FROM tasks WHERE user_id=? AND maybe_deliverable_id=? AND state!='merged'", (core.user_id, d["id"])):
            if t["state"] in states.LIVE:
                _part_of_card(core, t["id"], d)
                n += 1
    return n
