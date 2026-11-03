"""Groups: the tasks that came from the same place (one email thread, one meeting's notes, one Slack
message or burst). See "Groups" in the design doc.

The core makes them from the signal's fields as matching creates tasks; no AI decides. A group forms
when a second open task of yours comes from the same origin, a task is in at most one group, and each
task keeps its own deadline. A group whose tasks are all done or let go is finished, which is worked
out when it is read, not stored. You can rename one, take a task out or say it's wrapped up.
"""

import json
import re

from . import events, states
from .db import FuzzError, parse_iso

TITLE_MAX = 140
SOURCE_LABEL = {"email": "Email", "slack": "Slack", "meeting": "Meeting", "fuzz": "Fuzz"}


def get(core, group_id):
    return core.one("SELECT * FROM groups WHERE id=? AND user_id=?", (int(group_id), core.user_id))


def require(core, group_id):
    g = get(core, group_id)
    if g is None:
        raise FuzzError(f"No group {group_id}", "group_id", 404)
    return g


def members(core, group_id):
    """Every task in the group but those merged away, oldest first."""
    return core.all("SELECT * FROM tasks WHERE user_id=? AND group_id=? AND state!='merged' ORDER BY id",
                    (core.user_id, group_id))


def finished(core, g, tasks=None):
    tasks = members(core, g["id"]) if tasks is None else tasks
    return g["state"] == "wrapped" or not any(t["state"] in states.LIVE for t in tasks)


def view(core, g):
    """The group as a UI gets it: its name, where it came from, each task with its state and what you
    answered on its card ("What you said"), and once it's finished, the line Fuzz closes it with."""
    ts = members(core, g["id"])
    counted = [t for t in ts if t["state"] != "letgo"]
    fin = finished(core, g, ts)
    return {"id": g["id"], "title": g["title"], "origin": g["origin"], "source": (g["origin"] or "").split(":")[0],
            "link": g["link"], "wrapped": g["state"] == "wrapped", "finished": fin,
            "done": sum(t["state"] == "done" for t in counted), "total": len(counted),
            "tasks": [{"id": t["id"], "title": t["title"], "state": t["state"], "said": said(core, t["id"])} for t in ts],
            "closed_line": closed_line(core, g, ts) if fin else None}


def list_groups(core, since=None):
    """With since, a group shows only while one of its tasks is open or closed on or after then."""
    if since is None:
        return [view(core, g) for g in core.all(
            "SELECT * FROM groups g WHERE user_id=? AND EXISTS (SELECT 1 FROM tasks t WHERE t.group_id=g.id "
            "AND t.state!='merged') ORDER BY id", (core.user_id,))]
    return [view(core, g) for g in core.all(
        "SELECT * FROM groups g WHERE user_id=? AND EXISTS (SELECT 1 FROM tasks t WHERE t.group_id=g.id "
        "AND t.state!='merged' AND (t.state NOT IN ('done','letgo') OR COALESCE(t.state_changed_at,'') >= ?)) ORDER BY id",
        (core.user_id, since))]


def brief(core, t):
    """For the executor's get_task: the group's name and the other tasks in it, by title and state, with
    what the person answered on each one's card and its notes. together: the ones this run holds with
    this task (a group claim), to work as one: one lookup, and for a thread one reply (save_draft covers)."""
    if not t.get("group_id"):
        return None
    g = get(core, t["group_id"])
    mates = {m["id"] for m in claimed_with(core, t)}
    others = []
    for o in members(core, g["id"]):
        if o["id"] == t["id"]:
            continue
        x = {"id": o["id"], "title": o["title"], "state": o["state"]}
        s = said(core, o["id"])
        if s:
            x["you_said"] = s["text"]
        if o["id"] in mates:
            x.update(together=True, ask=o["ask"], notes=o["notes"])
        others.append(x)
    out = {"title": g["title"], "others": others}
    if mates:
        out["together"] = sorted(mates)
        out["reply_to"] = sender(core, g["id"])
    return out


# ---------------------------------------------------------------- making groups

def _signal(core, key):
    row = core.one("SELECT payload FROM signals WHERE user_id=? AND key=?", (core.user_id, key))
    return row and row["payload"]


def _origin_tasks(core, where, args):
    """Tasks born (role origin) from the signals that match a WHERE on signals g."""
    rows = core.all("SELECT DISTINCT so.task_id FROM sources so JOIN candidates c ON c.id=so.candidate_id "
                    "JOIN signals g ON g.key=c.signal_key AND g.user_id=c.user_id "
                    f"WHERE g.user_id=? AND so.role='origin' AND ({where})", [core.user_id] + list(args))
    return {r["task_id"] for r in rows}


def _sender(s):
    f = s.get("from") or {}
    return f.get("slack_id") or (f.get("email") or "").lower() or (f.get("name") or "").lower() or None


def _is_me(core, s):
    me = core.config.get("me") or {}
    f = s.get("from") or {}
    return bool(f.get("slack_id") and f["slack_id"] in me.get("slack_ids", [])
                or f.get("email") and f["email"].lower() in me.get("emails", []))


def _burst(core, s):
    """The Slack messages sent with this one: the same person in the same channel or DM, each within the
    window of the one before, with nothing from you in between. Other people's messages don't break it."""
    a = s.get("anchor") or ""
    if not a.startswith("slack:") or not s.get("ts") or not _sender(s):
        return [], None
    channel = a.split(":")[1]
    window = float((core.config.get("grouping") or {}).get("slack_burst_minutes", 10)) * 60
    rows = core.all("SELECT key, source_id, ts, payload FROM signals WHERE user_id=? AND source='slack' "
                    "AND substr(anchor, 1, ?)=? AND ts IS NOT NULL ORDER BY ts, key",
                    (core.user_id, len(channel) + 7, f"slack:{channel}:"))
    seq, seen = [], set()
    for r in rows:
        if r["source_id"] in seen:   # an edited message is a new version of the same one
            continue
        seen.add(r["source_id"])
        p = r["payload"] if isinstance(r["payload"], dict) else json.loads(r["payload"])
        if _is_me(core, p):
            seq.append(("me", r))
        elif _sender(p) == _sender(s):
            seq.append(("them", r))
    i = next((n for n, (_, r) in enumerate(seq) if r["source_id"] == s["source_id"]), None)
    if i is None:
        return [], None
    lo = hi = i
    while lo > 0 and seq[lo - 1][0] == "them" and _gap(seq[lo - 1][1], seq[lo][1]) <= window:
        lo -= 1
    while hi + 1 < len(seq) and seq[hi + 1][0] == "them" and _gap(seq[hi][1], seq[hi + 1][1]) <= window:
        hi += 1
    run = [r for _, r in seq[lo:hi + 1]]
    return [r["key"] for r in run], f"slack:{channel}:{run[0]['source_id'].split(':')[-1]}"


def _gap(a, b):
    return (parse_iso(b["ts"]) - parse_iso(a["ts"])).total_seconds()


def origin(core, s):
    """Where a signal's tasks came from, as (origin, the tasks born there). (None, set()) when it has none."""
    src, a = s.get("source"), s.get("anchor") or ""
    if src == "email" and a:
        return a, _origin_tasks(core, "g.source='email' AND g.anchor=?", [a])
    if src == "meeting":
        stem = (a or f"meeting:{s['source_id']}").split("#")[0]
        return stem, _origin_tasks(core, "g.source='meeting' AND (g.anchor=? OR substr(g.anchor, 1, ?)=?)",
                                   [stem, len(stem) + 1, stem + "#"])
    if src == "slack":
        keys, key = _burst(core, s)
        if keys:
            return key, _origin_tasks(core, f"g.key IN ({','.join('?' * len(keys))})", keys)
    return None, set()


def _title(s):
    who = (s.get("from") or {}).get("name") or "Someone"
    title = re.sub(r"^\s*((re|fwd?|aw|wg)\s*:\s*)+", "", s.get("title") or "", flags=re.I).strip()
    if title:
        return title[:TITLE_MAX]
    if s["source"] == "meeting":
        return who[:TITLE_MAX]
    return f"{who} on Slack" if s["source"] == "slack" else f"{SOURCE_LABEL.get(s['source'], 'Message')} from {who}"


def _link(s):
    link = s.get("link")
    return link.split("#")[0] if link and s["source"] == "meeting" else link


def place(core, task_id, signal_key):
    """A task matching just created: put it with the open tasks from the same origin. Must run inside
    the transaction that created it. Returns the group id, or None."""
    s = _signal(core, signal_key)
    if not s:
        return None
    where, born = origin(core, s)
    born |= _origin_tasks(core, "g.key=?", [signal_key])   # separate asks in one message
    born.discard(task_id)
    return _join(core, task_id, born, where or f"{s['source']}:{s['source_id']}", _title(s), _link(s))


def join_parent(core, task_id, parent_id):
    """A task Fuzz split off joins its parent's group, or starts one with it."""
    p = core.one("SELECT * FROM tasks WHERE id=? AND user_id=?", (parent_id, core.user_id))
    if not p:
        return None
    g = get(core, p["group_id"]) if p.get("group_id") else None
    return _join(core, task_id, {parent_id}, f"fuzz:task{parent_id}", g["title"] if g else p["title"], None)


def _join(core, task_id, peers, where, title, link):
    if not peers:
        return None
    rows = core.all(f"SELECT * FROM tasks WHERE user_id=? AND id IN ({','.join('?' * len(peers))}) ORDER BY id",
                    [core.user_id] + sorted(peers))
    rows = [t for t in rows if t["state"] in states.LIVE]
    open_groups = []
    for t in rows:
        g = get(core, t["group_id"]) if t.get("group_id") else None
        if g and not finished(core, g) and g["id"] not in [x["id"] for x in open_groups]:
            open_groups.append(g)
    ch = events.Changes()
    if open_groups:
        g = open_groups[0]
        ch.task(task_id, group_id=g["id"])
        events.emit(core, "group.linked", task_id=task_id, changes=ch, data={"group_id": g["id"]},
                    log=("status", f"Grouped with the other tasks from {g['title']}."))
        return g["id"]
    free = [t for t in rows if not t.get("group_id")]
    # once this origin's group is over (wrapped, or every task finished), a new ask starts fresh, even
    # next to a task you took out of it
    if not free or any(finished(core, g) for g in core.all(
            "SELECT * FROM groups WHERE user_id=? AND origin=?", (core.user_id, where))):
        return None
    gid = core.new_id("groups")
    ch.group(gid, title=title, origin=where, link=link, state="open", created_at=core.now_iso())
    for t in free + [{"id": task_id}]:
        ch.task(t["id"], group_id=gid)
    events.emit(core, "group.created", task_id=task_id, changes=ch,
                data={"group_id": gid, "task_ids": [t["id"] for t in free] + [task_id]},
                log=("status", f"Grouped with the other tasks from {title}."))
    return gid


# ---------------------------------------------------------------- your changes, from the group sheet

def rename(core, group_id, title):
    g = require(core, group_id)
    title = (title or "").strip()[:TITLE_MAX]
    if not title:
        raise FuzzError("title is the group's new name, short and plain", "title")
    if title == g["title"]:
        return g["id"]
    with core.tx("human"):
        ch = events.Changes()
        ch.group(g["id"], title=title)
        events.emit(core, "group.renamed", changes=ch, data={"group_id": g["id"], "from": g["title"], "to": title},
                    log=("status", f"You renamed {g['title']} to {title}."))
    return g["id"]


def take_out(core, group_id, task_id):
    """Take one task out. A group of one isn't a group, so the last task left stands on its own.
    Returns the ids of the tasks that left."""
    g = require(core, group_id)
    ts = members(core, g["id"])
    if task_id not in [t["id"] for t in ts]:
        raise FuzzError(f"Task {task_id} isn't in this group", "task_id")
    left = [t for t in ts if t["id"] != task_id]
    out = [task_id] + ([left[0]["id"]] if len(left) == 1 else [])
    title = next(t["title"] for t in ts if t["id"] == task_id)
    with core.tx("human"):
        ch = events.Changes()
        for tid in out:
            ch.task(tid, group_id=None)
        if len(left) <= 1:
            ch.group(g["id"], state="wrapped")
        events.emit(core, "group.unlinked", task_id=task_id, changes=ch,
                    data={"group_id": g["id"], "task_ids": out},
                    log=("status", f"You took “{title}” out of {g['title']}."))
    return out


def wrap(core, group_id):
    """You said it's wrapped up: tasks still open keep going on their own, and no new ask joins."""
    g = require(core, group_id)
    if g["state"] == "wrapped":
        return g["id"]
    with core.tx("human"):
        ch = events.Changes()
        ch.group(g["id"], state="wrapped")
        events.emit(core, "group.wrapped", changes=ch, data={"group_id": g["id"]},
                    log=("status", f"You said {g['title']} is wrapped up."))
    return g["id"]


# ---------------------------------------------------------------- working through a group
# A group's cards come one at a time, back to back (cards.queue). Every answer takes effect at once,
# except Assign to Fuzz: that task is held (tag "held") until the group is collected, so Fuzz works
# the group in one run. Collected (group.collected) when the last card is answered, when you say
# "Finish later", or after a quiet spell (grouping.collect_minutes): the held tasks become "together",
# and claim_next_task leases them as one claim. The run in progress is user_state "group_run".

HELD, TOGETHER = "held", "together"
SAID = {"assign": "Fuzz", "quick": "Fuzz", "unclear": "Fuzz works out the first step", "nudge": "Fuzz nudges them",
        "session": "Working session", "schedule": "Later", "done": "Done", "park": "Parked", "wait": "Waiting",
        "keep_waiting": "Still waiting", "someone_else": "Not mine", "drop": "Let go", "not_task": "Not a task",
        "mine": "Yours", "merge": "Merged", "keep_separate": "Kept separate", "keep": "Kept", "keep_parked": "Parked",
        "now": "Yours", "got_it": "They got back to you"}
ROUTING = ("task", "duplicate", "is_task", "entity_person", "entity_term")   # the cards a group is worked through with


def _tags(t):
    return t.get("variant_tags") or []


def said(core, task_id):
    """What you answered on this task's latest card: {"option", "text"}, or None."""
    c = core.one("SELECT answer FROM cards WHERE user_id=? AND task_id=? AND status='answered' AND kind IN "
                 f"({','.join('?' * len(ROUTING))}) ORDER BY answered_event_id DESC LIMIT 1",
                 [core.user_id, task_id] + list(ROUTING))
    a = (c or {}).get("answer") or {}
    if not a.get("option"):
        return None
    v = a.get("value")
    text = SAID.get(a["option"], a["option"].replace("_", " ").capitalize())
    if a["option"] == "wait" and isinstance(v, str):
        text = f"Waiting on {v}"
    elif a["option"] in ("assign", "quick"):
        words = v if isinstance(v, str) else (v or {}).get("instructions") if isinstance(v, dict) else None
        if words:
            text = f"Fuzz: “{words.strip()[:120]}”"
    elif a["option"] == "someone_else" and isinstance(v, str) and v.strip():
        text = f"{v.strip()}'s"
    return {"option": a["option"], "text": text}


def _waiting(core, t):
    """This task has a card you haven't answered yet, and haven't put off to the end."""
    return any(c["kind"] in ROUTING and not c["postponed"] and not (c.get("payload") or {}).get("at_end")
               for c in core.all("SELECT * FROM cards WHERE user_id=? AND task_id=? AND status='open'",
                                 (core.user_id, t["id"])))


def run(core):
    """The group you're working through, or None: {"group_id", "tasks", "at"}."""
    row = core.one("SELECT value FROM user_state WHERE user_id=? AND key='group_run'", (core.user_id,))
    v = (row or {}).get("value")
    return json.loads(v) if isinstance(v, str) and v.startswith("{") else None


def holds(core, t):
    """Assigning this task from its card waits for the rest of its group: another task in it still has a
    card for you, or is already held."""
    if not t.get("group_id"):
        return False
    return any(m["id"] != t["id"] and (_waiting(core, m) or HELD in _tags(m))
               for m in members(core, t["group_id"]) if m["state"] in states.LIVE)


def after_answer(core, task_id):
    """You answered a card. Inside the answer's transaction, so one Undo takes back both. Either the group
    has cards left, and the run goes on, or this was the last one, and the group is collected."""
    from . import tasks
    t = tasks.get(core, task_id)
    gid = t and t.get("group_id")
    cur = run(core)
    if cur and cur["group_id"] != gid:   # you moved on to something else: what was answered goes ahead
        collect(core, cur["group_id"], "moved_on")
        cur = None
    if not gid:
        return None
    mem = [m for m in members(core, gid) if m["state"] in states.LIVE or m["id"] == task_id]
    left = [m for m in mem if m["id"] != task_id and _waiting(core, m)]
    if left:
        ids = cur["tasks"] if cur else [task_id] + [m["id"] for m in left]
        ch = events.Changes()
        ch.state("group_run", json.dumps({"group_id": gid, "tasks": sorted(set(ids) | {task_id}), "at": core.now_iso()}))
        events.emit(core, "group.working", task_id=task_id, changes=ch, actor="system",
                    data={"group_id": gid, "left": len(left)})
        return None
    if cur or any(HELD in _tags(m) for m in mem):
        return collect(core, gid, "answered")
    return None


def collect(core, gid, why="answered", actor="system"):
    """Fuzz has the answers: the held tasks become one claim (together), and the run is over.
    why: answered (the last card), later (you said Finish later), quiet (no answer for a while), moved_on."""
    from . import tasks
    g = get(core, gid)
    cur = run(core)
    mem = members(core, gid)
    held = [m for m in mem if HELD in _tags(m) and m["state"] in states.LIVE]
    ch = events.Changes()
    for h in held:
        ch.task(h["id"], variant_tags=tasks._tags(h, add=(TOGETHER,) if len(held) > 1 else (), remove=(HELD,)))
    if cur and cur["group_id"] == gid:
        ch.state("group_run", None)
    if ch.empty():
        return None
    ids = cur["tasks"] if cur and cur["group_id"] == gid else [m["id"] for m in mem]
    line = plan_line(core, g, [m for m in mem if m["id"] in ids], held, why)
    if why == "later":   # the rest wait behind everything else, as ordinary cards
        from . import cards
        n = cards.next_order(core)
        for m in mem:
            for c in core.all("SELECT * FROM cards WHERE user_id=? AND task_id=? AND status='open'", (core.user_id, m["id"])):
                if c["kind"] in ROUTING and not (c.get("payload") or {}).get("at_end"):
                    ch.card(c["id"], order_key=n, postponed=c["postponed"] + 1, payload=dict(c.get("payload") or {}, at_end=True))
                    n += 1
    events.emit(core, "group.collected", task_id=held[0]["id"] if held else None, changes=ch, actor=actor,
                data={"group_id": gid, "together": [h["id"] for h in held], "why": why, "line": line},
                log=("status", line) if held else None)
    return line


def finish_later(core, gid):
    """You stopped partway: Fuzz goes ahead with the answers it has; the rest come back as ordinary cards."""
    require(core, gid)
    with core.tx("human"):
        line = collect(core, gid, "later", actor="human")
        if line is None:
            raise FuzzError("You're not working through this group", "group_id", 409)
    return line


def collect_quiet(core):
    """Run by the clock: a run nobody has answered in a while goes ahead with what it has."""
    from datetime import timedelta
    cur = run(core)
    if not cur:
        return 0
    quiet = float((core.config.get("grouping") or {}).get("collect_minutes", 30))
    if parse_iso(cur["at"]) > core.now() - timedelta(minutes=quiet):
        return 0
    with core.tx("system"):
        collect(core, cur["group_id"], "quiet")
    return 1


def sender(core, gid):
    """Who a reply for the whole thread goes to: the person the group's first message came from, for an
    email thread or a Slack burst. None for meeting notes, which have no one recipient."""
    g = get(core, gid)
    if (g["origin"] or "").split(":")[0] not in ("email", "slack"):
        return None
    row = core.one("SELECT g.payload FROM sources s JOIN signals g ON g.key=s.signal_key AND g.user_id=s.user_id "
                   "JOIN tasks t ON t.id=s.task_id WHERE t.group_id=? AND s.user_id=? AND s.role='origin' "
                   "ORDER BY g.ts, s.id LIMIT 1", (gid, core.user_id))
    return (((row or {}).get("payload") or {}).get("from") or {}).get("name")


_NUM = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}


def plan_line(core, g, ran, held, why):
    """What Fuzz says once it has the answers: "Got all 4. I'll look into the two together and draft one
    reply to Priya. You've got the plan review." Deterministic, from the answers."""
    from .sessions import label
    n = len(ran)
    answered = sum(1 for m in ran if not _waiting(core, m))
    out = [f"Got all {n}." if why == "answered" or answered >= n else f"Got {answered} of {n}."]
    who = sender(core, g["id"])
    k = len(held)
    reply = f" and draft one reply to {who}" if who and k else ""
    if k > 1:
        out.append(f"I'll look into the {_NUM.get(k, k)} together{reply}.")
    elif k == 1:
        out.append(f"I'll get on “{held[0]['title']}”{reply}.")
    yours = [m for m in ran if m["state"] == "session"]
    if yours:
        out.append(f"You've got “{yours[0]['title']}” in {label(core)}." if len(yours) == 1
                   else f"You've got {len(yours)} in {label(core)}.")
    if why != "answered" and answered < n:
        out.append("The rest come back as ordinary cards.")
    return " ".join(out)


def closed_line(core, g, ts):
    """Fuzz's line for a finished group (the thread-closed moment)."""
    done = [t for t in ts if t["state"] == "done"]
    if g["state"] == "wrapped" and any(t["state"] in states.LIVE for t in ts):
        return f"{g['title']} is wrapped up. What's still open carries on by itself."
    if not done:
        return f"That thread's closed: {g['title']} has nothing left in it."
    one = core.one("SELECT d.covers FROM drafts d JOIN tasks t ON t.id=d.task_id WHERE t.group_id=? AND d.user_id=? "
                   "AND d.status='sent' AND d.covers IS NOT NULL ORDER BY d.id DESC LIMIT 1", (g["id"], core.user_id))
    who = sender(core, g["id"])
    if one and one.get("covers"):
        whose = f"{who}’s" if who else "the"
        return f"All {len(one['covers']) + 1} of {whose} asks answered in one reply. That thread's done."
    return f"All {len(done)} done from {g['title']}. That thread's done." if len(done) > 1 else f"{g['title']}: done. That thread's closed."


def claimed_with(core, t):
    """The other tasks this run holds in the same group claim as t."""
    if not t.get("group_id") or t["state"] != "working" or not t.get("lease_owner"):
        return []
    return core.all("SELECT * FROM tasks WHERE user_id=? AND group_id=? AND state='working' AND lease_owner=? AND id!=?",
                    (core.user_id, t["group_id"], t["lease_owner"], t["id"]))
