"""The output folder: the one place the executor may create and change files, with no draft and no asking.

You pick it in setup (config output.folder, like ~/Documents/Fuzz). Each task gets its own subfolder,
"<id> <title>", made when the executor claims it. A headless run may write only inside the folder
(Claude Code: Write and Edit on it; Copilot: write(<folder>/**)). Nothing in it is sent anywhere.

After a run, every file in a task's subfolder is recorded as a `sources` row with role `output`, so the
card and the task sheet can link to it. Files are overwritten in place, and once written they stay:
Undo doesn't remove them, since you may have opened or moved them. Approved notes and results are saved
there too, as Markdown.
"""

import mimetypes
import os
import re

from . import events, tasks

TITLE_MAX = 60


def folder(core):
    f = (core.config.get("output") or {}).get("folder")
    return os.path.abspath(os.path.expanduser(f)) if f else None


def _safe(title):
    s = re.sub(r'[\x00-\x1f/\\:*?"<>|]', " ", title or "").strip(" .")
    s = re.sub(r"\s+", " ", s)
    return s[:TITLE_MAX].rstrip(" .") or "Task"


def task_dir(core, task_id, create=False):
    """<folder>/<id> <title>/. A task keeps the folder it first got, even after a rename."""
    root = folder(core)
    if not root:
        return None
    t = tasks.require(core, task_id)
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            if name.split(" ", 1)[0] == str(t["id"]) and os.path.isdir(os.path.join(root, name)):
                return os.path.join(root, name)
    path = os.path.join(root, f"{t['id']} {_safe(t['title'])}")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def listing(core, task_id):
    rows = core.all("SELECT id, title, path, mime, size FROM sources WHERE task_id=? AND user_id=? AND role='output' "
                    "AND withdrawn=0 ORDER BY title", (task_id, core.user_id))
    return [{"source_id": r["id"], "name": r["title"], "path": r["path"], "mime": r["mime"], "size": r["size"]}
            for r in rows]


def record(core, task_id, actor="fuzz:executor"):
    """Record what is in a task's folder now: new files, changed sizes, and files that are gone."""
    d = task_dir(core, task_id)
    if not d or not os.path.isdir(d):
        return []
    have = {r["path"]: r for r in core.all("SELECT * FROM sources WHERE task_id=? AND user_id=? AND role='output'",
                                           (task_id, core.user_id))}
    found = {}
    for base, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        for f in files:
            if not f.startswith("."):
                p = os.path.join(base, f)
                found[p] = os.path.getsize(p)
    new = []
    with core.tx(actor):
        for p, size in sorted(found.items()):
            rel = os.path.relpath(p, d)
            r = have.get(p)
            if r and not r["withdrawn"] and r["size"] == size:
                continue
            mime = mimetypes.guess_type(p)[0] or "application/octet-stream"
            if r:
                core.q("UPDATE sources SET size=?, mime=?, withdrawn=0 WHERE id=?", (size, mime, r["id"]))
                sid, verb = r["id"], "Updated"
            else:
                sid = core.q("INSERT INTO sources (user_id, task_id, role, title, path, mime, size) VALUES "
                             "(?,?,?,?,?,?,?)", (core.user_id, task_id, "output", rel, p, mime, size)).lastrowid
                verb = "Saved"
            new.append(rel)
            events.emit(core, "task.file_written", task_id=task_id,
                        data={"source_id": sid, "name": rel, "path": p, "mime": mime, "size": size},
                        log=("action", f"{verb} {rel} in your Fuzz folder."))
        for p, r in have.items():
            if p not in found and not r["withdrawn"]:
                core.q("UPDATE sources SET withdrawn=1 WHERE id=?", (r["id"],))
    return new


def save_markdown(core, task_id, name, body, actor="system"):
    """An approved note or a result, as a Markdown file in the task's folder. Overwritten in place."""
    if not folder(core) or not (body or "").strip():
        return None
    d = task_dir(core, task_id, create=True)
    path = os.path.join(d, name)
    with open(path, "w") as f:
        f.write(body.rstrip() + "\n")
    record(core, task_id, actor=actor)
    return path
