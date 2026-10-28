"""The output folder: the one place the executor may create and change files, with no draft and no asking.

You pick it in setup (config output.folder, like ~/Documents/Fuzz). Each task gets its own subfolder,
"<id> <title>", made when the executor claims it. A headless run may write only inside the folder
(Claude Code: Write and Edit on it; Copilot: write(<folder>/**)). Nothing in it is sent anywhere.

After a run, every file in a task's subfolder is recorded as a `sources` row with role `output`, so the
card and the task sheet can link to it. Files are overwritten in place, and once written they stay:
Undo doesn't remove them, since you may have opened or moved them. Approved notes and results are saved
there too, as Markdown. The Artifacts tab lists them all (artifacts()), and the viewer previews one.
"""

import mimetypes
import os
import re
from datetime import datetime, timezone

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


def _kind(name, mime):
    ext = os.path.splitext(name)[1].lower()
    if ext in (".md", ".markdown"):
        return "markdown"
    if ext == ".docx":
        return "word"
    if ext == ".pptx":
        return "slides"
    if ext == ".pdf" or mime == "application/pdf":
        return "pdf"
    if (mime or "").startswith("image/"):
        return "image"
    if ext in (".html", ".htm"):
        return "html"
    if ext in (".csv", ".tsv"):
        return "table"
    if (mime or "").startswith("text/") or ext in (".json", ".txt", ".yaml", ".yml", ".py", ".js", ".ts", ".sql"):
        return "text"
    return "other"


def _view(r):
    try:
        updated = os.path.getmtime(r["path"])
    except OSError:
        return None
    return {"source_id": r["id"], "name": r["title"], "mime": r["mime"], "size": r["size"],
            "kind": _kind(r["title"], r["mime"]), "role": r["role"],
            "updated_at": datetime.fromtimestamp(updated, timezone.utc).isoformat(timespec="seconds"),
            "task": {"id": r["task_id"], "title": r["task_title"], "state": r["task_state"]}}


_Q = ("SELECT s.id, s.role, s.title, s.path, s.mime, s.size, s.task_id, t.title AS task_title, t.state AS task_state "
      "FROM sources s JOIN tasks t ON t.id=s.task_id AND t.user_id=s.user_id "
      "WHERE s.user_id=? AND s.withdrawn=0 AND s.path IS NOT NULL ")


def artifacts(core):
    """Every file Fuzz has written in your output folder, newest first, with the task it's for."""
    rows = core.all(_Q + "AND s.role='output'", (core.user_id,))
    return sorted(filter(None, map(_view, rows)), key=lambda a: a["updated_at"], reverse=True)


def artifact(core, source_id):
    """One output file, or an attachment you added, for the viewer. None when it's gone."""
    r = core.one(_Q + "AND s.role IN ('attachment','output') AND s.id=?", (core.user_id, source_id))
    return _view(r) if r else None
