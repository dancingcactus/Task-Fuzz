"""Task commands. Each one is a transaction that writes events; nothing changes a task without one.

Human decisions (assign, done, park...) and the AI's writes (log_step, update_brief...) both live
here, so HTTP, MCP and the CLI all call the same code.
"""

import re
from datetime import timedelta
from urllib.parse import unquote_plus, urlparse

from . import cards, events, states
from .db import FuzzError, iso, parse_iso

CONTEXT_MAX = 16 * 1024
QUESTION_MAX = 500
SUMMARY_MAX = 400
TITLE_MAX = 140
FINISHED_WINDOW_DAYS = 14   # done and let-go tasks older than this stay out of the UI's list; search finds them


def get(core, task_id):
    if task_id is None:
        return None
    return core.one("SELECT * FROM tasks WHERE id=? AND user_id=?", (int(task_id), core.user_id))


def live(core, task_id):
    """Follow merge redirects so an old task id still resolves."""
    seen = set()
    t = get(core, task_id)
    while t and t["state"] == "merged" and t["merged_into"] and t["id"] not in seen:
        seen.add(t["id"])
        t = get(core, t["merged_into"])
    return t


def require(core, task_id):
    t = get(core, task_id)
    if t is None:
        raise FuzzError(f"No task {task_id}", "task_id", 404)
    return t


def finished_cutoff(core, days=FINISHED_WINDOW_DAYS):
    return iso(core.now() - timedelta(days=days))


def list_tasks(core, state=None, closed_days=None):
    """With closed_days, done and let-go tasks that closed longer ago than that are left out."""
    where, args = "", []
    if closed_days is not None:
        where, args = " AND NOT (state IN ('done','letgo') AND COALESCE(state_changed_at,'') < ?)", [finished_cutoff(core, closed_days)]
    if state:
        wanted = [s for s in state.split(",") if s]
        for s in wanted:
            if s not in states.STATES:
                raise FuzzError(f"Unknown state {s!r}", "state")
        return core.all(f"SELECT * FROM tasks WHERE user_id=? AND state IN ({','.join('?' * len(wanted))}){where} ORDER BY order_key, id",
                        [core.user_id] + wanted + args)
    return core.all(f"SELECT * FROM tasks WHERE user_id=? AND state!='merged'{where} ORDER BY order_key, id", [core.user_id] + args)


def finished_older(core, days=FINISHED_WINDOW_DAYS):
    """How many done and let-go tasks closed before the window: the ones only search finds."""
    return core.one("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND state IN ('done','letgo') AND COALESCE(state_changed_at,'') < ?",
                    (core.user_id, finished_cutoff(core, days)))["n"]


def search_finished(core, q, limit=50):
    """Done and let-go tasks whose title or summary has the words, newest first."""
    words = [w for w in (q or "").split() if w][:8]
    if not words:
        return []
    like = " AND ".join("(title LIKE ? ESCAPE '\\' OR COALESCE(summary,'') LIKE ? ESCAPE '\\')" for _ in words)
    args = []
    for w in words:
        w = "%" + re.sub(r"([%_\\])", r"\\\1", w) + "%"
        args += [w, w]
    return core.all(f"SELECT * FROM tasks WHERE user_id=? AND state IN ('done','letgo') AND {like} "
                    "ORDER BY state_changed_at DESC, id DESC LIMIT ?", [core.user_id] + args + [max(1, min(int(limit), 200))])


def next_order(core, where="back"):
    if where == "front":
        return core.one("SELECT COALESCE(MIN(order_key), 0) m FROM tasks WHERE user_id=?", (core.user_id,))["m"] - 1
    return core.one("SELECT COALESCE(MAX(order_key), 0) m FROM tasks WHERE user_id=?", (core.user_id,))["m"] + 1


def _tags(t, add=(), remove=()):
    tags = [x for x in (t.get("variant_tags") or []) if x not in remove]
    for a in add:
        if a not in tags:
            tags.append(a)
    return tags


def move(core, ch, t, to, card=None, add_tags=(), remove_tags=(), **fields):
    """Change state, keep the cards in step and drop the triage-only variant when leaving triage."""
    states.check(t["state"], to)
    pend = ch.pending("tasks", t["id"])
    remove = set(remove_tags)
    if t["state"] == "triage" and to != "triage":
        remove |= cards.TRIAGE_TAGS | {"unconfirmed"}
        fields.setdefault("reason", None)
        fields.setdefault("quick_answers", None)
    if to not in ("queued", "working"):
        remove.add("gather")   # gathering ends however the task leaves Fuzz's hands
    base = dict(t, **pend)
    f = dict(state=to, variant_tags=_tags(base, add_tags, remove), **fields)
    if "assignee" not in fields:
        f["assignee"] = states.ASSIGNEE[to]
    if t["state"] != to:
        f["state_changed_at"] = core.now_iso()
        cards.withdraw(core, ch, t["id"], keep=card["id"] if card else None)
    if to not in ("working",):
        f.setdefault("lease_owner", None)
        f.setdefault("lease_until", None)
    ch.task(t["id"], **f)


def _answered(core, ch, card, option, value=None):
    if card:
        cards.mark_answered(core, ch, card, option, value)


def _one(core, actor, type, t, to, log, card=None, option=None, value=None, data=None, **fields):
    """The common shape: one event that moves one task, then make sure it has the card it needs."""
    with core.tx(actor):
        ch = events.Changes()
        move(core, ch, t, to, card=card, **fields)
        _answered(core, ch, card, option, value)
        eid = events.emit(core, type, task_id=t["id"], changes=ch, log=log, data=data)
        cards.sync(core, t["id"])
    return eid


# ---------------------------------------------------------------- capture

def capture(core, text, docs=None, actor="human", due=None, gather=False):
    """gather: Fuzz looks the task up with its read-only tools before it reaches triage, so the card can
    show what it found. It waits as queued for Fuzz with the gather tag until then."""
    text = (text or "").strip()
    docs = [d for d in (docs or []) if d]
    if not text and not docs:
        raise FuzzError("Say what the task is, or attach a document", "text")
    title = (text or docs[0]).splitlines()[0][:TITLE_MAX]
    with core.tx(actor):
        tid = core.new_id("tasks")
        now = core.now_iso()
        ch = events.Changes()
        ch.task(tid, state="queued" if gather else "triage", assignee="fuzz" if gather else "human", title=title,
                ask=text or None, owner="me", due=due, order_key=next_order(core),
                variant_tags=["gather"] if gather else [], created_at=now, state_changed_at=now,
                title_history=[], steps_used=0, attempts=0, deadline_level=0)
        events.emit(core, "task.captured", task_id=tid, changes=ch, data={"docs": docs},
                    log=("status", "You captured this task." if actor == "human" else "Fuzz captured this task."))
        for d in docs:
            core.q("INSERT INTO sources (user_id, task_id, role, title) VALUES (?,?,?,?)",
                   (core.user_id, tid, "attachment", d))
        cards.sync(core, tid)
    return tid


# ---------------------------------------------------------------- your decisions

def assign(core, task_id, instructions=None, card=None, option="assign", value=None, actor="human"):
    t = require(core, task_id)
    extra = {}
    log = ("status", "You assigned this to Fuzz.")
    if instructions and instructions.strip():
        notes = ((t.get("notes") or "") + f"\nYou said: {instructions.strip()}").strip()
        extra["notes"] = notes
        log = ("guidance", f"You said: {instructions.strip()}")
    with core.tx(actor):
        ch = events.Changes()
        move(core, ch, t, "queued", card=card, attempts=0, question=None, **extra)
        _answered(core, ch, card, option, value)
        events.emit(core, "task.assigned", task_id=t["id"], changes=ch, log=log, data={"to": "fuzz"})
    return t["id"]


def session(core, task_id, card=None):
    t = require(core, task_id)
    return _one(core, "human", "task.assigned", t, "session",
                ("status", "You opened this in a working session with Claude. Fuzz keeps the sources ready."),
                card=card, option="session", data={"to": "session"}, question=None)


def done(core, task_id, card=None, option="done"):
    t = require(core, task_id)
    log = "You marked this done." if "reopened" not in (t.get("variant_tags") or []) else "You kept this closed."
    return _one(core, "human", "task.done", t, "done", ("status", log), card=card, option=option, question=None)


def park(core, task_id, card=None):
    t = require(core, task_id)
    return _one(core, "human", "task.parked", t, "parked", ("status", "You parked this."), card=card,
                option="park", question=None, remove_tags=("woke",))


CHECK_BACK_DAYS = 3        # business days, when Fuzz doesn't pick a time
CHECK_BACK_WEEK = 7        # Fuzz picks within a week, unless it has a reason to wait longer
CHECK_BACK_LONGEST = 30


def default_check_back(core, days=CHECK_BACK_DAYS):
    """9am your time, the given number of business days from now."""
    from . import timeres
    d = core.now().astimezone(timeres.local_tz(core))
    while days:
        d += timedelta(days=1)
        if d.weekday() < 5:
            days -= 1
    return iso(d.replace(hour=9, minute=0, second=0, microsecond=0))


def waiting_on(t, on=None):
    """Who you're waiting on: the name you gave, or the task's owner when it's a person."""
    who = (on or "").strip() or (t.get("owner") if t.get("owner") not in ("me", "unclear", "someone", None) else None)
    return (who or "").strip() or None


def wait(core, task_id, on=None, card=None, option="wait", plan=False, actor="human"):
    """Waiting means you're blocked until someone gets back to you, so it needs a who. It always has a
    check-back time: with plan, Fuzz looks at the context first and picks it (set_check_back); otherwise,
    or until it does, it's a few business days out."""
    t = require(core, task_id)
    who = waiting_on(t, on)
    if not who:
        raise FuzzError("Who are you waiting on?", "value")
    back = default_check_back(core)
    with core.tx(actor):
        ch = events.Changes()
        if plan:
            move(core, ch, t, "queued", card=card, add_tags=("gather", "plan_wait"), waiting_on=who,
                 schedule_anchor=None, schedule_fire_at=back, question=None, attempts=0)
            log = f"You're waiting on {who}. Fuzz is working out when to check back."
        else:
            move(core, ch, t, "waiting", card=card, waiting_on=who, schedule_anchor=None, schedule_fire_at=back,
                 question=None)
            log = f"You're waiting on {who}. Fuzz checks back {_when(core, back)}, sooner if they reply."
        _answered(core, ch, card, option, who)
        eid = events.emit(core, "task.waiting", task_id=t["id"], changes=ch, log=("status", log),
                          data={"on": who, "plan": plan})
        cards.sync(core, t["id"])
    return eid


def _when(core, at):
    from . import timeres
    lab = timeres.label(core, {"type": "exact", "at": at})
    return lab[0].lower() + lab[1:]


def theirs(core, task_id, on=None, card=None, option="someone_else"):
    """Someone else's task: Fuzz doesn't track other people's work, so it closes. It stays findable, and a
    new ask that needs you brings it back (the matcher resurfaces it)."""
    t = require(core, task_id)
    who = waiting_on(t, on)
    why = f"You said this is {who}'s, not yours." if who else "You said this is someone else's, not yours."
    return _one(core, "human", "task.let_go", t, "letgo", ("status", why), card=card, option=option, value=on,
                question=None, reason=why, add_tags=("theirs",), owner=who or t.get("owner"))


def let_go(core, task_id, card=None, option="drop", why=None):
    t = require(core, task_id)
    return _one(core, "human", "task.let_go", t, "letgo", ("status", why or "You let this go."),
                card=card, option=option, question=None, reason=why)


def schedule(core, task_id, anchor, card=None, offered_only=True, instructions=None, gather=False):
    """offered_only: a human pick must be one of the card's options (or exact). The core's own
    scheduling, like "hold the rest until tomorrow", may use any anchor.

    instructions: what you want Fuzz to look into meanwhile. They go in the task's notes, and with
    gather Fuzz looks it up now: the task waits queued for Fuzz with the gather tag, and when Fuzz is
    done it waits as scheduled, so it still comes back at the time you picked, with the brief in."""
    from . import timeres
    t = require(core, task_id)
    the_card = card or next((c for c in cards.open_cards(core, t["id"]) if c["kind"] == "task"), None)
    if the_card and offered_only:
        anchor, fire_at, source = timeres.pick(core, the_card, t, anchor)
    else:
        fire_at, source = timeres.resolve(core, anchor, t), "direct"
    said = (instructions or "").strip()
    when = timeres.label(core, anchor).lower()
    extra, log = {}, ("status", f"You scheduled this: {when}.")
    if said:
        extra["notes"] = ((t.get("notes") or "") + f"\nYou said: {said}").strip()
        log = ("guidance", f"You scheduled this: {when}. You said: {said}")
    look = bool(said and gather)
    with core.tx("human"):
        ch = events.Changes()
        move(core, ch, t, "queued" if look else "scheduled", card=card, add_tags=("gather",) if look else (),
             schedule_anchor=anchor, schedule_fire_at=fire_at and fire_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
             question=None, attempts=0, **extra)
        _answered(core, ch, card, "schedule", {"anchor": anchor, "instructions": said} if said else {"anchor": anchor})
        events.emit(core, "task.scheduled", task_id=t["id"], changes=ch, log=log,
                    data={"anchor": anchor, "source": source, "line": timeres.line(core, anchor), "gather": look})
        core.q("INSERT INTO feedback (user_id, ts, kind, a, note) VALUES (?,?,?,?,?)",
               (core.user_id, core.now_iso(), "schedule", t["id"], f"{anchor['type']}:{source}"))
    return t["id"]


def bring_back(core, task_id, where="back", reason=None, type="task.came_back", actor="human", tags=("returning",),
               log=None):
    """Back into triage: a scheduled task's time came, you pulled it back, or a reply came in. A draft
    you put off ("Not now") comes back to review instead, for your OK."""
    t = require(core, task_id)
    if t["state"] in ("triage", "review"):
        return None
    to = "triage"
    if t["state"] == "scheduled" and core.one("SELECT id FROM drafts WHERE task_id=? AND status='pending'", (t["id"],)):
        to, tags = "review", ()
    with core.tx(actor):
        ch = events.Changes()
        move(core, ch, t, to, add_tags=tags, order_key=next_order(core, where), reason=reason,
             schedule_anchor=None, schedule_fire_at=None)
        eid = events.emit(core, type, task_id=t["id"], changes=ch,
                          log=log or ("status", reason or "Back in triage."), data={"reason": reason})
        cards.sync(core, t["id"], where)
    return eid


def to_back(core, task_id):
    """Not now, but not at a time either: the task stays where it is and its card goes to the end of the
    queue, behind handbacks and anything due soon too. It comes up again once you've been through the rest."""
    t = require(core, task_id)
    open_ = cards.open_cards(core, t["id"])
    if not open_:
        raise FuzzError("This task has no card in triage to move", "task_id", 409)
    with core.tx("human"):
        ch = events.Changes()
        ch.task(t["id"], order_key=next_order(core))
        for c in open_:
            ch.card(c["id"], postponed=c["postponed"] + 1, order_key=cards.next_order(core),
                    payload=dict(c.get("payload") or {}, at_end=True))
        events.emit(core, "card.postponed", task_id=t["id"], changes=ch, data={"kind": open_[0]["kind"], "to": "back"},
                    log=("status", "You moved this to the end of the list."))
    return t["id"]


def reopen(core, task_id, reason, actor="system"):
    return bring_back(core, task_id, where="back", reason=reason, type="task.reopened", actor=actor,
                      tags=("reopened",), log=("status", reason))


def keep_stale(core, task_id, card):
    t = require(core, task_id)
    with core.tx("human"):
        ch = events.Changes()
        ch.task(t["id"], state_changed_at=core.now_iso(), variant_tags=_tags(t, remove=("stale",)))
        _answered(core, ch, card, "keep")
        events.emit(core, "card.answered", task_id=t["id"], changes=ch, data={"kind": "task", "option": "keep"},
                    log=("status", "You said you still care about this."))
        cards.sync(core, t["id"])


def keep_parked(core, task_id, card):
    """The parked review asked and you still want it someday: back to Parked, not asked again for a while."""
    t = require(core, task_id)
    return _one(core, "human", "task.kept_parked", t, "parked", ("status", "You kept this parked."), card=card,
                option="keep_parked", question=None, reviewed_at=core.now_iso(), reviews=(t.get("reviews") or 0) + 1)


def clarify(core, task_id, card, option="now", log="You brought this back from Parked."):
    """It's yours to decide again: it stays in triage, first in line, as a fresh task card. From the parked
    review (you want it now) and from a check-back (they got back to you)."""
    t = require(core, task_id)
    with core.tx("human"):
        ch = events.Changes()
        f = dict(variant_tags=_tags(t, remove=("review", "check_back")), order_key=next_order(core, "front"), reason=None)
        if option == "now":
            f["reviewed_at"] = core.now_iso()
        ch.task(t["id"], **f)
        _answered(core, ch, card, option)
        events.emit(core, "card.answered", task_id=t["id"], changes=ch, data={"kind": "task", "option": option},
                    log=("status", log))
        cards.sync(core, t["id"], "front")
    return t["id"]


def check_back(core, task_id, actor="system"):
    """A waiting task's check-back time came: back to triage to ask if they got back to you."""
    t = require(core, task_id)
    who = t.get("waiting_on") or "they"
    return bring_back(core, t["id"], where="front", reason=f"Did {who} get back to you?", actor=actor,
                      tags=("check_back",), log=("status", f"Checking in: you've been waiting on {who} since "
                                                           f"{_when(core, t['state_changed_at'])}."))


# ---------------------------------------------------------------- the AI's writes

def update_brief(core, task_id, context_md=None, question=None, effort_mins=None, energy=None, due=None,
                 summary=None, actor="fuzz:executor"):
    t = require(core, task_id)
    f = {}
    if due is not None:
        from .timeres import local_iso
        # a bare date means by the end of that working day
        f["due"] = local_iso(core, due + "T17:00" if len(due.strip()) == 10 else due, "due") if due.strip() else None
    if context_md is not None:
        if len(context_md.encode()) > CONTEXT_MAX:
            raise FuzzError(f"context_md is over {CONTEXT_MAX // 1024} KB; keep the brief short and link out",
                            "context_md")
        f["context_md"] = context_md or None
    if summary is not None:
        if len(summary) > SUMMARY_MAX:
            raise FuzzError(f"summary is over {SUMMARY_MAX} characters; say what you did or found in a sentence "
                            "or two", "summary")
        f["summary"] = summary.strip() or None
    if question is not None:
        if len(question) > QUESTION_MAX:
            raise FuzzError(f"question is over {QUESTION_MAX} characters; ask one short thing", "question")
        f["question"] = question.strip() or None
    if effort_mins is not None:
        f["effort_mins"] = int(effort_mins)
    if energy is not None:
        if energy not in ("low", "normal", "high"):
            raise FuzzError("energy must be low, normal or high", "energy")
        f["energy"] = energy
    if not f:
        raise FuzzError("Pass context_md, summary, question, effort_mins, energy or due", "context_md")
    with core.tx(actor):
        ch = events.Changes()
        ch.task(t["id"], **f)
        if "due" in f:
            cards.refresh_schedule_options(core, ch, t["id"])
        events.emit(core, "task.brief_updated", task_id=t["id"], changes=ch, data={"fields": sorted(f)})
    return sorted(f)


def save_notes(core, task_id, text, actor="fuzz:executor"):
    t = require(core, task_id)
    with core.tx(actor):
        ch = events.Changes()
        ch.task(t["id"], notes=(text or "").strip() or None)
        events.emit(core, "task.notes_saved", task_id=t["id"], changes=ch)


LINK_RE = re.compile(r"^https?://\S+$", re.I)
_URL_VERBS = {"edit", "view", "preview", "browse", "pages", "spaces", "display", "d", "u", "0", "1"}
_GOOGLE = {"document": "Google Doc", "presentation": "Google Slides", "spreadsheets": "Google Sheet",
           "forms": "Google Form"}


def link_title(url):
    """A readable name from a link alone: the page's slug ("Experimentation Knowledge Base - Use Cases Queries"),
    a ticket key, the kind of Google file, or else its site."""
    p = urlparse(url)
    segs = [s for s in p.path.split("/") if s]
    for i in range(len(segs) - 1, -1, -1):
        name = unquote_plus(segs[i]).strip()
        if name in _GOOGLE and (p.hostname or "").endswith("google.com"):
            return _GOOGLE[name]
        if i and segs[i - 1] == "d":   # /d/<id>/: a Google file's id
            continue
        if name.lower() in _URL_VERBS or len(name) < 3 or not re.search(r"[A-Za-z]", name):
            continue
        if len(name) > 20 and not re.search(r"[\s_-]", name):   # a document id, not a name
            continue
        return name
    return p.hostname or url


def _same_page(link):
    """What makes two links one source: a Google file's id or a ticket key, else the address without its #part."""
    from .matching.entities import normalize_url
    ident = normalize_url(link)
    return ident if ident.startswith(("gdoc:", "ticket:")) else link.split("#")[0].rstrip("/")


def _link_source(core, task_id, title, link, run_id):
    for s in core.all("SELECT id, link FROM sources WHERE task_id=? AND user_id=? AND role='link' AND withdrawn=0",
                      (task_id, core.user_id)):
        if _same_page(s["link"]) == _same_page(link):
            return s["id"], False
    return core.q("INSERT INTO sources (user_id, task_id, role, title, link, added_run) VALUES (?,?,?,?,?,?)",
                  (core.user_id, task_id, "link", title, link, run_id)).lastrowid, True


def add_links(core, task_id, links, run_id=None):
    """The docs and tickets an email or message linked to join the task's sources with it, quietly."""
    for url in links or []:
        url = (url or "").strip()
        if LINK_RE.match(url):
            _link_source(core, task_id, link_title(url), url, run_id)


def add_link(core, task_id, title, link, actor="fuzz:executor"):
    """A web page that belongs with the task (a wiki, a doc) becomes one of its sources. The same link twice is one source."""
    t = require(core, task_id)
    link = (link or "").strip()
    if not LINK_RE.match(link):
        raise FuzzError("link is the page's full http(s) address", "link")
    title = (title or "").strip() or link_title(link)
    with core.tx(actor):
        sid, added = _link_source(core, t["id"], title, link, (core.run or {}).get("id"))
        if not added:
            return sid, False
        who = "You" if actor == "human" else "Fuzz"
        events.emit(core, "task.link_added", task_id=t["id"], data={"source_id": sid, "title": title, "link": link},
                    log=("status", f"{who} added {title} as a source."))
    return sid, True


def rename(core, task_id, title=None, ask=None, actor="fuzz:executor"):
    """The task is now something else (new instructions changed it). Its own event, so Undo can reverse it."""
    t = require(core, task_id)
    if title is not None and not title.strip():
        raise FuzzError("title is the task's new name, short and plain", "title")
    f = {}
    if ask is not None and ask.strip() and ask.strip() != (t.get("ask") or ""):
        f["ask"] = ask.strip()
    with core.tx(actor):
        ch = events.Changes()
        renamed = title is not None and retitle(core, ch, t, title)
        if f:
            ch.task(t["id"], **f)
        if not renamed and not f:
            return []
        new = ch.pending("tasks", t["id"]).get("title", t["title"])
        log = f"Renamed “{t['title']}” to “{new}”." if renamed else f"Rewrote what “{t['title']}” asks for."
        events.emit(core, "task.retitled", task_id=t["id"], changes=ch, log=("action", log),
                    data={"from": t["title"], "to": new})
    return (["title"] if renamed else []) + sorted(f)


def retitle(core, ch, t, title):
    title = title.strip()[:TITLE_MAX]
    if not title or title == t["title"]:
        return False
    ch.task(t["id"], title=title, title_history=(t.get("title_history") or []) + [t["title"]])
    return True


def handed_back_fields(question, options):
    return dict(question=question.strip(), quick_answers=[o.strip() for o in (options or []) if o and o.strip()][:4])


def due_level(core, t):
    """0 none, 1 within a day, 2 within four hours, 3 within an hour or past its time."""
    due = parse_iso(t.get("due"))
    if not due:
        return 0
    left = (due - core.now()).total_seconds() / 3600
    return 3 if left <= 1 else 2 if left <= 4 else 1 if left <= 24 else 0
