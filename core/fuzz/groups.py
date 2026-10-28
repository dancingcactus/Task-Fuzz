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
    """The group as a UI gets it: its name, where it came from and each task with its state."""
    ts = members(core, g["id"])
    counted = [t for t in ts if t["state"] != "letgo"]
    return {"id": g["id"], "title": g["title"], "origin": g["origin"], "source": (g["origin"] or "").split(":")[0],
            "link": g["link"], "wrapped": g["state"] == "wrapped", "finished": finished(core, g, ts),
            "done": sum(t["state"] == "done" for t in counted), "total": len(counted),
            "tasks": [{"id": t["id"], "title": t["title"], "state": t["state"]} for t in ts]}


def list_groups(core):
    return [view(core, g) for g in core.all(
        "SELECT * FROM groups g WHERE user_id=? AND EXISTS (SELECT 1 FROM tasks t WHERE t.group_id=g.id "
        "AND t.state!='merged') ORDER BY id", (core.user_id,))]


def brief(core, t):
    """For the executor's get_task: the group's name and the other tasks in it, by title and state."""
    if not t.get("group_id"):
        return None
    g = get(core, t["group_id"])
    return {"title": g["title"], "others": [{"id": o["id"], "title": o["title"], "state": o["state"]}
                                            for o in members(core, g["id"]) if o["id"] != t["id"]]}


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
