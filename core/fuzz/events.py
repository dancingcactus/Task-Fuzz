"""The event log and the projection it drives.

Every change to tasks, cards, drafts, grants and user_state is an event whose payload carries
the field changes. The reducer applies them; rebuild() replays them all and must land on the
same tables. emit() also records the earlier values of every field it changes ("prior"), so
Undo is a compensating task.restored event, never a delete.
"""

import json

from .db import FuzzError, JSON_COLS, row_dict

EVENT_TYPES = {
    "task.captured", "task.extracted", "task.merged", "task.split", "task.assigned",
    "task.claimed", "task.step", "task.draft_ready", "task.approved", "task.sent",
    "task.handed_back", "task.scheduled", "task.woke", "task.parked", "task.waiting",
    "task.done", "task.let_go", "task.restored", "task.stale", "task.deadline_level",
    "task.reopened", "task.reply_in", "task.came_back", "task.anchor_moved", "task.anchor_lost",
    "task.confirmed", "task.draft_edited", "task.sent_back", "task.send_failed",
    # not in the design doc's first list; each is a plain fact the UI can ignore
    "task.brief_updated", "task.notes_saved", "task.released", "task.session",
    "task.schedule_suggested", "task.retitled", "source.read", "task.file_attached", "task.gathered",
    "entity.merged", "entity.kept_separate", "entity.defined",
    "card.created", "card.answered", "card.postponed", "card.expired",
    "permission.asked", "permission.granted", "permission.denied",
    "checkin.due", "checkin.answered",
    "run.started", "run.finished",
    "engine.installed", "engine.removed", "engine.selected",
}

# Projected tables and their key column. user_state is keyed by (user_id, key).
TABLES = {"tasks": "id", "cards": "id", "drafts": "id", "grants": "id", "user_state": "key"}

ACTORS = ("human", "fuzz:extractor", "fuzz:executor", "fuzz:sender", "system")

LOG_KINDS = ("research", "action", "guidance", "status", "sent", "blocked")


class Changes:
    """Field changes for one event, keyed by table then row id."""

    def __init__(self):
        self.rows = {t: {} for t in TABLES}

    def _put(self, table, key, fields):
        cur = self.rows[table].setdefault(str(key), {})
        cur.update(fields)
        return cur

    def task(self, tid, **fields):
        return self._put("tasks", tid, fields)

    def card(self, cid, **fields):
        return self._put("cards", cid, fields)

    def draft(self, did, **fields):
        return self._put("drafts", did, fields)

    def grant(self, gid, **fields):
        return self._put("grants", gid, fields)

    def state(self, key, value):
        return self._put("user_state", key, {"value": value})

    def pending(self, table, key):
        return self.rows[table].get(str(key), {})

    def empty(self):
        return not any(self.rows.values())

    def to_json(self):
        return {t: r for t, r in self.rows.items() if r}


def _enc(col, v):
    return json.dumps(v) if col in JSON_COLS and v is not None and not isinstance(v, str) else v


def _current(core, table, key, cols):
    kcol = TABLES[table]
    sel = ", ".join(cols)
    if table == "user_state":
        row = core.conn.execute(f"SELECT {sel} FROM user_state WHERE user_id=? AND key=?",
                                (core.user_id, key)).fetchone()
    else:
        row = core.conn.execute(f"SELECT {sel} FROM {table} WHERE {kcol}=?", (int(key),)).fetchone()
    return row_dict(row)


def apply(core, user_id, changes, event_id, ts):
    """The reducer: upsert each row's fields. Used live and by rebuild()."""
    for table, rows in changes.items():
        kcol = TABLES[table]
        for key, fields in rows.items():
            fields = dict(fields)
            if table == "tasks":
                fields["updated_event_id"] = event_id
                fields["updated_at"] = ts
            if table == "cards" and fields.get("status") in ("answered", "expired"):
                fields["answered_event_id"] = event_id
            if table == "user_state":
                exists = core.conn.execute("SELECT 1 FROM user_state WHERE user_id=? AND key=?",
                                           (user_id, key)).fetchone()
                where, wargs = "user_id=? AND key=?", [user_id, key]
            else:
                exists = core.conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (int(key),)).fetchone()
                where, wargs = "id=?", [int(key)]
            if exists:
                sets = ", ".join(f"{c}=?" for c in fields)
                core.conn.execute(f"UPDATE {table} SET {sets} WHERE {where}",
                                  [_enc(c, v) for c, v in fields.items()] + wargs)
            else:
                if table == "cards":
                    fields["created_event_id"] = event_id
                cols = ["user_id", kcol] + list(fields)
                vals = [user_id, key if table == "user_state" else int(key)] + \
                       [_enc(c, v) for c, v in fields.items()]
                core.conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                                  vals)


def emit(core, type, task_id=None, changes=None, log=None, data=None, actor=None):
    """Append one event and apply it. Must run inside core.tx(). Returns the event id."""
    if type not in EVENT_TYPES:
        raise FuzzError(f"Unknown event type {type!r}", "type")
    if core._depth == 0:
        raise RuntimeError("emit() outside a transaction")
    actor = actor or core._actor or "system"
    if actor not in ACTORS:
        raise FuzzError(f"Unknown actor {actor!r}", "actor")
    if log is not None:
        kind, text = log
        if kind not in LOG_KINDS:
            raise FuzzError(f"kind must be one of {', '.join(LOG_KINDS)}", "kind")
        log = {"kind": kind, "text": text}
    ch = changes.to_json() if isinstance(changes, Changes) else (changes or {})
    if core.renew and task_id == core.renew[0]:
        # Any write about a leased task renews the lease, inside the same event.
        f = ch.setdefault("tasks", {}).setdefault(str(task_id), {})
        cur = _current(core, "tasks", task_id, ["state"])
        if cur and cur["state"] == "working" and f.get("state", "working") == "working":
            f.setdefault("lease_until", core.renew[1])
        if not f:
            del ch["tasks"][str(task_id)]
            if not ch["tasks"]:
                del ch["tasks"]
    prior = {}
    for table, rows in ch.items():
        for key, fields in rows.items():
            cur = _current(core, table, key, list(fields))
            prior.setdefault(table, {})[key] = cur  # None means the row didn't exist
    payload = {"data": data or {}, "log": log, "changes": ch, "prior": prior}
    run = core.run or {}
    ts = core.now_iso()
    cur = core.conn.execute(
        "INSERT INTO events (user_id, ts, actor, type, task_id, payload, caused_by, run_id, model, prompt_version) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (core.user_id, ts, actor, type, task_id, json.dumps(payload), core._group,
         run.get("id"), run.get("model"), run.get("prompt_version")))
    eid = cur.lastrowid
    if core._group is None:
        core._group = eid
    apply(core, core.user_id, ch, eid, ts)
    return eid


def event_dict(row):
    d = dict(row)
    d["payload"] = json.loads(d["payload"])
    return d


def task_log(core, task_id, limit=None):
    """'Done so far': the log lines of a task's events, newest first."""
    rows = core.conn.execute(
        "SELECT * FROM events WHERE user_id=? AND task_id=? ORDER BY id DESC", (core.user_id, task_id)).fetchall()
    out = []
    for r in rows:
        p = json.loads(r["payload"])
        if p.get("log"):
            out.append({"event_id": r["id"], "ts": r["ts"], "type": r["type"], "actor": r["actor"],
                        "kind": p["log"]["kind"], "text": p["log"]["text"]})
            if limit and len(out) >= limit:
                break
    return out


def since(core, after_id=0, limit=200):
    rows = core.conn.execute("SELECT * FROM events WHERE user_id=? AND id>? ORDER BY id LIMIT ?",
                             (core.user_id, after_id, limit)).fetchall()
    return [public_event(event_dict(r)) for r in rows]


def public_event(e):
    """What a UI sees: the facts, not the field-level bookkeeping."""
    p = e["payload"]
    return {"id": e["id"], "ts": e["ts"], "actor": e["actor"], "type": e["type"], "task_id": e["task_id"],
            "data": p.get("data") or {}, "log": p.get("log"), "run_id": e["run_id"], "model": e["model"],
            "prompt_version": e["prompt_version"]}


# ---------------------------------------------------------------- replay

def snapshot(core, user_id=None):
    uid = user_id or core.user_id
    out = {}
    for table, kcol in TABLES.items():
        rows = core.conn.execute(f"SELECT * FROM {table} WHERE user_id=? ORDER BY {kcol}", (uid,)).fetchall()
        out[table] = [dict(r) for r in rows]
    return out


def rebuild(core, user_id=None):
    """Drop the projection and replay every event. Returns the number of events replayed."""
    uid = user_id or core.user_id
    with core.tx():
        for table in TABLES:
            core.conn.execute(f"DELETE FROM {table} WHERE user_id=?", (uid,))
        rows = core.conn.execute("SELECT id, ts, payload FROM events WHERE user_id=? ORDER BY id", (uid,)).fetchall()
        for r in rows:
            apply(core, uid, json.loads(r["payload"])["changes"], r["id"], r["ts"])
    return len(rows)


def check_replay(core, user_id=None):
    """Replay the log and compare with the live tables. Returns the tables that differ (empty when they match)."""
    before = snapshot(core, user_id)
    rebuild(core, user_id)
    after = snapshot(core, user_id)
    return [t for t in TABLES if before[t] != after[t]]


# ---------------------------------------------------------------- undo

# The AI's own changes you can take back, like a rename.
AI_UNDOABLE = {"task.retitled"}
NOT_UNDOABLE = {"task.restored", "run.started", "run.finished", "engine.installed", "engine.removed",
                "task.sent", "source.read", "task.file_attached"}


def _groups(core, limit=200):
    """Recent human command groups, newest first: [(root_id, [events oldest first])]."""
    rows = core.conn.execute(
        "SELECT * FROM events WHERE user_id=? ORDER BY id DESC LIMIT ?", (core.user_id, limit)).fetchall()
    groups = {}
    order = []
    for r in rows:
        root = r["caused_by"] or r["id"]
        if root not in groups:
            groups[root] = []
            order.append(root)
        groups[root].insert(0, event_dict(r))
    undone = set()
    for root in order:
        for e in groups[root]:
            if e["type"] == "task.restored":
                undone.add(e["payload"]["data"].get("undoes"))
    out = []
    for root in order:
        evs = groups[root]
        if root in undone or (evs[0]["actor"] != "human" and evs[0]["type"] not in AI_UNDOABLE):
            continue
        if any(e["type"] in NOT_UNDOABLE for e in evs):
            continue
        out.append((root, evs))
    return out


# Fields that say what a command decided. A later change to one of these on the same row means the
# command can't be undone on its own any more. Other fields (tags, order, deadline level, lease
# renewals...) are bookkeeping: undo keeps whatever later events set them to.
DECISIVE = {"tasks": {"state", "assignee", "lease_owner", "notes", "question", "schedule_anchor", "title",
                      "merged_into", "waiting_on", "quick_answers"},
            "cards": {"status"}, "drafts": {"status", "body"}, "grants": {"kind"}, "user_state": {"value"}}


def _restore_plan(evs):
    restore = {}
    for e in reversed(evs):  # newest first, so the oldest prior value wins
        for table, rows in e["payload"]["prior"].items():
            for key, before in rows.items():
                if before is None:
                    before = _absent(table, e["payload"]["changes"][table][key])
                restore.setdefault(table, {}).setdefault(key, {}).update(before)
    return restore


def _later(core, evs):
    """Events after a command. A later command you undid and the undo itself cancel out, so they're left out."""
    rows = core.conn.execute("SELECT * FROM events WHERE user_id=? AND id>? ORDER BY id",
                             (core.user_id, evs[-1]["id"])).fetchall()
    later = [event_dict(r) for r in rows]
    roots = {e["caused_by"] or e["id"] for e in later}
    undone = {e["payload"]["data"].get("undoes") for e in later if e["type"] == "task.restored"} & roots
    return [e for e in later if (e["caused_by"] or e["id"]) not in undone
            and not (e["type"] == "task.restored" and e["payload"]["data"].get("undoes") in undone)]


def _blocker(restore, later):
    """The first later event that changed a decisive field this undo would put back, or None."""
    for e in later:
        for table, rows in e["payload"].get("changes", {}).items():
            for key, fields in rows.items():
                mine = restore.get(table, {}).get(key)
                if mine and set(fields) & set(mine) & DECISIVE.get(table, set()):
                    return e
    return None


def _why_blocked(e):
    if e["actor"] == "human":
        text = (e["payload"].get("log") or {}).get("text") or e["type"]
        return f"You changed this since ({text}). Undo that first."
    if e["actor"].startswith("fuzz"):
        return "Fuzz has already worked on this since, so it can't be undone. Bring it back from Lineup instead."
    return "This has changed since, so it can't be undone."


def undo_list(core, limit=10):
    """Recent commands, newest first. Each one undoes on its own; blocked says why one no longer can."""
    out = []
    for root, evs in _groups(core)[:limit]:
        first = evs[0]
        log = next((e["payload"]["log"]["text"] for e in evs if e["payload"].get("log")), None)
        b = _blocker(_restore_plan(evs), _later(core, evs))
        out.append({"group": root, "ts": first["ts"], "type": first["type"], "task_id": first["task_id"],
                    "by": first["actor"],
                    "text": log or first["type"], "blocked": _why_blocked(b) if b else None})
    return out


def undo(core, group=None):
    """Reverse the newest human command (or the one named), on its own: commands aren't a stack.

    Refused (409) when a later event changed a decisive field the undo would put back. Bookkeeping
    fields a later event changed keep their newer value. Returns {"undid": root, "event_id": id}."""
    groups = _groups(core)
    if group is not None:
        groups = [g for g in groups if g[0] == group]
    if not groups:
        raise FuzzError("Nothing to undo", "group", 404)
    root, evs = groups[0]
    restore = _restore_plan(evs)
    later = _later(core, evs)
    b = _blocker(restore, later)
    if b:
        raise FuzzError(_why_blocked(b), "group", 409)
    for e in later:
        for table, rows in e["payload"].get("changes", {}).items():
            for key, fields in rows.items():
                for f in fields:
                    restore.get(table, {}).get(key, {}).pop(f, None)
    restore = {t: {k: f for k, f in rows.items() if f} for t, rows in restore.items()}
    restore = {t: rows for t, rows in restore.items() if rows}
    with core.tx(actor="human"):
        for e in evs:
            if e["type"] == "task.merged":
                from . import matching  # the side tables a merge moved
                matching.unmerge_side_tables(core, e["payload"]["data"]["merge_id"])
            if e["type"] == "engine.selected":
                from . import engine
                engine.restore_selection(core, e["payload"]["data"].get("prior"))
        task_id = evs[0]["task_id"]
        eid = emit(core, "task.restored", task_id=task_id, changes=restore,
                   data={"undoes": root, "type": evs[0]["type"]},
                   log=("status", "You undid that.") if task_id else None)
    return {"undid": root, "event_id": eid}


def _absent(table, created):
    """What 'didn't exist' becomes, since nothing is deleted."""
    if table == "tasks":
        return {"state": "letgo", "reason": "Undone"}
    if table == "cards":
        return {"status": "withdrawn"}
    if table == "drafts":
        return {"status": "withdrawn"}
    if table == "grants":
        return {"kind": "revoked"}
    return {"value": None}
