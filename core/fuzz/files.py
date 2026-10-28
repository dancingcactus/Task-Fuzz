"""Attachments: files you add to a task, kept in a folder per task.

Fuzz doesn't open them. The executor gets each file's path and reads it with its own client's file
tools (a headless run may read only this user's files folder). The record is a `sources` row with
role `attachment`, so attachments show up with the task's other sources.

A task captured with documents gets a row per name at once, with no path. Each upload fills its row.
When the UI says the files are coming (the uploading tag), Fuzz doesn't pick the task up until they're
all in, or WAIT_SECONDS have passed.
"""

import mimetypes
import os
import re
import uuid
from datetime import timedelta

from . import events, tasks
from .db import FuzzError, parse_iso

NAME_MAX = 120
WAIT_SECONDS = 120


def user_dir(core):
    return os.path.join(core.home, "files", f"u{core.user_id}")


def task_dir(core, task_id):
    return os.path.join(user_dir(core), f"t{task_id}")


def clean_name(name):
    """A file name that can't climb out of its folder or hide."""
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f]", "", name).lstrip(".").strip()
    if not name:
        raise FuzzError("name is the file's name, like budget.pdf", "name")
    if len(name) > NAME_MAX:
        stem, ext = os.path.splitext(name)
        name = stem[:NAME_MAX - len(ext)] + ext
    return name


def _free_name(folder, name):
    stem, ext = os.path.splitext(name)
    n, out = 1, name
    while os.path.exists(os.path.join(folder, out)):
        n += 1
        out = f"{stem} ({n}){ext}"
    return out


def limits(core):
    f = core.config.get("files") or {}
    return int(f.get("max_mb", 25)) * 1024 * 1024, int(f.get("max_per_task", 10))


def attach(core, task_id, name, data, mime=None, actor="human"):
    """Write the file into the task's folder and record it. Returns the source row."""
    t = tasks.require(core, task_id)
    name = clean_name(name)
    max_bytes, max_files = limits(core)
    if not isinstance(data, (bytes, bytearray)):
        raise FuzzError("the file's content is required", "body")
    if len(data) > max_bytes:
        raise FuzzError(f"The file is over {max_bytes // (1024 * 1024)} MB", "body", 413)
    n = core.one("SELECT COUNT(*) n FROM sources WHERE task_id=? AND user_id=? AND role='attachment' "
                 "AND withdrawn=0 AND path IS NOT NULL", (t["id"], core.user_id))["n"]
    if n >= max_files:
        raise FuzzError(f"A task can have at most {max_files} files", "task_id", 409)
    mime = (mime or "").split(";")[0].strip() or mimetypes.guess_type(name)[0] or "application/octet-stream"
    folder = task_dir(core, t["id"])
    os.makedirs(folder, exist_ok=True)
    final = _free_name(folder, name)
    path = os.path.join(folder, final)
    tmp = os.path.join(folder, f".upload-{uuid.uuid4().hex}")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    with core.tx(actor):
        named = core.one("SELECT id FROM sources WHERE task_id=? AND user_id=? AND role='attachment' AND path IS NULL "
                         "AND withdrawn=0 AND title=? ORDER BY id LIMIT 1", (t["id"], core.user_id, name))
        if named:   # the name you captured the task with
            sid = named["id"]
            core.q("UPDATE sources SET title=?, path=?, mime=?, size=? WHERE id=?", (final, path, mime, len(data), sid))
        else:
            sid = core.q("INSERT INTO sources (user_id, task_id, role, title, path, mime, size) VALUES (?,?,?,?,?,?,?)",
                         (core.user_id, t["id"], "attachment", final, path, mime, len(data))).lastrowid
        who = "You" if actor == "human" else "Fuzz"
        events.emit(core, "task.file_attached", task_id=t["id"],
                    data={"source_id": sid, "name": final, "mime": mime, "size": len(data)},
                    log=("status", f"{who} attached {final}."))
    return get(core, sid)


def waiting(core, t):
    """How many files the task was captured with haven't arrived yet. 0 once WAIT_SECONDS have passed."""
    if "uploading" not in (t.get("variant_tags") or []) or not t.get("created_at") or core.now() - parse_iso(t["created_at"]) > timedelta(seconds=WAIT_SECONDS):
        return 0
    return core.one("SELECT COUNT(*) n FROM sources WHERE task_id=? AND user_id=? AND role='attachment' "
                    "AND path IS NULL AND withdrawn=0", (t["id"], core.user_id))["n"]


def get(core, source_id):
    s = core.one("SELECT * FROM sources WHERE id=? AND user_id=? AND role='attachment' AND path IS NOT NULL",
                 (source_id, core.user_id))
    if s is None:
        raise FuzzError(f"No file {source_id}", "source_id", 404)
    return s


def detach(core, task_id, source_id, actor="human"):
    s = get(core, source_id)
    if s["task_id"] != int(task_id) or s["withdrawn"]:
        raise FuzzError(f"Task {task_id} has no file {source_id}", "source_id", 404)
    with core.tx(actor):
        core.q("UPDATE sources SET withdrawn=1 WHERE id=?", (s["id"],))
        events.emit(core, "task.file_attached", task_id=s["task_id"], data={"source_id": s["id"], "removed": True},
                    log=("status", f"You removed {s['title']}."))
    if os.path.exists(s["path"]):
        os.remove(s["path"])


def listing(core, task_id):
    rows = core.all("SELECT id, title, path, mime, size FROM sources WHERE task_id=? AND user_id=? "
                    "AND role='attachment' AND path IS NOT NULL AND withdrawn=0 ORDER BY id", (task_id, core.user_id))
    return [{"source_id": r["id"], "name": r["title"], "path": r["path"], "mime": r["mime"], "size": r["size"]}
            for r in rows]
