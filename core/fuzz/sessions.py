"""Work in Claude (or Copilot): open an interactive session with the engine, started on the task.

Fuzz writes the task as a prompt (what's asked, what it found, the sources, the files) and a small
script that starts the engine's own CLI on it, then opens the script in Terminal. The session gets
Fuzz's session server for that one task (`fuzz mcp --role session --task N`), so it can keep the
task's log and next step current and say how it ended (end_session). Its scripts live in
<home>/sessions/u<user>/.

A task keeps its conversation's id, so opening it again resumes the same conversation. A session
that ends without saying how still comes back to you: when its window closes (the script calls
`fuzz session-closed`), or, if that never runs, once it has been quiet for QUIET_HOURS.
"""

import os
import shlex
import shutil
import subprocess
import sys
import uuid
from datetime import timedelta

from . import adapters, events, files, outputs, tasks
from .adapters.base import PKG_PARENT
from .db import FuzzError, iso

DEFAULT_CLIENT = "claude-code"
QUIET_HOURS = 24

INSTRUCTIONS = """## Keep Fuzz up to date
You have Fuzz's tools for this task (the fuzz-session server). Fuzz is where the person tracks it, so:
- Call get_task first: it has the latest log and next_step, which may be newer than this message.
- Call log_progress at each real milestone (a decision, a draft written, a file saved, an answer found).
- Call set_next_step whenever the next step changes, so the task shows where things stand.
- Before the person wraps up, call end_session: done, pause (with a time to come back if they give one),
  fuzz (Fuzz takes the next step on its own) or waiting (on a person). Ask them which, if it isn't clear.
  If they just close the window, the task comes back to their triage with the last next step."""


def client(core):
    """The engine's adapter. With no engine picked yet, Claude Code."""
    eng = core.config.get("engine") or {}
    return adapters.get(eng.get("client") or DEFAULT_CLIENT)


def label(core):
    """What the UI calls the engine: Claude or Copilot."""
    return client(core).short


def prompt(core, task_id):
    t = tasks.require(core, task_id)
    out = [f"I'm working on this task from my Fuzz queue (Fuzz task {t['id']}). Help me get it done.", "",
           f"# {t['title']}"]
    for key, head in (("ask", "What's asked"), ("summary", "What Fuzz found"), ("context_md", "Context"),
                      ("notes", "Notes"), ("next_step", "Where we left off")):
        if (t.get(key) or "").strip() and t.get(key) != t["title"]:
            out += ["", f"## {head}", t[key].strip()]
    if t.get("due"):
        out += ["", f"Due: {t['due']}"]
    if t.get("waiting_on"):
        out += ["", f"Waiting on: {t['waiting_on']}"]
    srcs = core.all("SELECT s.title, COALESCE(s.link, g.link) link, g.quote FROM sources s "
                    "LEFT JOIN signals g ON g.key=s.signal_key AND g.user_id=s.user_id "
                    "WHERE s.task_id=? AND s.user_id=? AND s.withdrawn=0 AND s.role NOT IN ('attachment','output') "
                    "ORDER BY s.id", (t["id"], core.user_id))
    if srcs:
        out += ["", "## Sources"]
        for s in srcs:
            line = f"- {s['title'] or 'Untitled'}" + (f" ({s['link']})" if s["link"] else "")
            if (s["quote"] or "").strip():
                line += "\n  > " + " ".join(s["quote"].split())[:500]
            out.append(line)
    att = files.listing(core, t["id"]) + outputs.listing(core, t["id"])
    if att:
        out += ["", "## Files", *[f"- {f['name']}: {f['path']}" for f in att if f.get("path")]]
    out += ["", INSTRUCTIONS, "", "Start by telling me, in a few lines, what you think the next step is."]
    return "\n".join(out)


def resume_prompt(core, task_id):
    return (f"I'm back on Fuzz task {task_id}. Call get_task for anything that changed since we stopped, then "
            "tell me in a few lines where we are and the next step. Keep Fuzz up to date as before.")


def _dirs(core, task_id):
    """The folders the session may read: the task's attachments and its output folder, when they exist."""
    out = [files.task_dir(core, task_id)]
    if outputs.folder(core):
        out.append(outputs.task_dir(core, task_id, create=True))
    return [d for d in out if d and os.path.isdir(d)]


def _cwd(core, task_id):
    """Where the session starts. It must stay the same for a resume: Claude Code keeps conversations per folder."""
    d = outputs.task_dir(core, task_id, create=True) if outputs.folder(core) else None
    return d if d and os.path.isdir(d) else os.path.expanduser("~")


def script(core, task_id, launch, session_id, resume=False):
    """Writes <home>/sessions/u<user>/t<id>.command, its prompt and its server config; returns the script's
    path. The script runs the session, then tells Fuzz the window closed, however it closes."""
    ad = client(core)
    exe = shutil.which(ad.exe) or ad.exe   # under launchd PATH may not have it; the login shell below will
    folder = os.path.join(core.home, "sessions", f"u{core.user_id}")
    os.makedirs(folder, exist_ok=True)
    base = os.path.join(folder, f"t{task_id}")
    with open(base + ".md", "w") as f:
        f.write(resume_prompt(core, task_id) if resume else prompt(core, task_id))
    cfg = ad.write_run_config("session", None, base + ".mcp.json", core.home, core.user_id, task_id)
    argv = ad.session_command(exe, "@PROMPT@", _dirs(core, task_id), mcp_config=cfg, session_id=session_id,
                              resume=resume)
    cmd = " ".join('"$(cat ' + shlex.quote(base + ".md") + ')"' if a == "@PROMPT@" else shlex.quote(a) for a in argv)
    env = {"FUZZ_HOME": core.home, "FUZZ_USER": str(core.user_id), "PYTHONPATH": PKG_PARENT}
    closed = " ".join([*(f"{k}={shlex.quote(v)}" for k, v in env.items()), shlex.quote(sys.executable), "-m", "fuzz",
                       "session-closed", "--task", str(task_id), "--launch", shlex.quote(launch)])
    path = base + ".command"
    with open(path, "w") as f:
        f.write("#!/bin/zsh -l\n"
                f"# Fuzz task {task_id}, in {ad.label}\n"
                "# When the session ends, or the window closes, Fuzz hears about it once\n"
                f"closed() {{ [[ -n $FUZZ_CLOSED ]] && return; FUZZ_CLOSED=1; nohup {closed} >/dev/null 2>&1 & }}\n"
                "trap closed EXIT\n"
                "trap 'closed; exit' HUP TERM\n"
                f"cd {shlex.quote(_cwd(core, task_id))}\n"
                f"{cmd}\n")
    os.chmod(path, 0o755)
    return path


def launch(path):
    """Opens the script in Terminal (macOS: a .command file opens there)."""
    subprocess.Popen(["open", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def open_session(core, task_id):
    """{client, label, opened, resumed, script}. A task not yet in a session moves there first. Off macOS
    nothing opens: run the script yourself."""
    t = tasks.require(core, task_id)
    if t["state"] != "session":
        tasks.session(core, task_id)
        t = tasks.require(core, task_id)
    ad = client(core)
    # A conversation started in the other engine can't be resumed in this one
    prior = t.get("session_id") or ""
    resume = prior.startswith(ad.name + ":")
    sid = prior.split(":", 1)[1] if resume else str(uuid.uuid4())
    token = uuid.uuid4().hex[:12]
    path = script(core, task_id, token, sid, resume)
    with core.tx("human"):
        ch = events.Changes()
        ch.task(t["id"], session_id=f"{ad.name}:{sid}", session_launch=token, session_at=core.now_iso())
        events.emit(core, "task.session_opened", task_id=t["id"], changes=ch,
                    log=("status", f"You went back to it in {ad.short}." if resume
                         else f"You started working on it in {ad.short}."),
                    data={"client": ad.name, "resumed": resume})
    opened = sys.platform == "darwin"
    if opened:
        try:
            launch(path)
        except OSError as e:
            raise FuzzError(f"Couldn't open Terminal: {e}", "session", 500)
    return {"client": ad.name, "label": ad.short, "opened": opened, "resumed": resume, "script": path}


def _left_off(t):
    return f" Next step: {t['next_step']}" if t.get("next_step") else ""


def closed(core, task_id, launch_token):
    """The session's window closed. If the session didn't say how it ended (the task is still in it) and no
    newer window is open on it, the task comes back to the front of triage."""
    t = tasks.get(core, task_id)
    if not t or t["state"] != "session" or t.get("session_launch") != launch_token:
        return {"came_back": False}
    tasks.bring_back(core, task_id, where="front", actor="system",
                     reason=f"You closed {label(core)} without saying where this got to.{_left_off(t)}")
    return {"came_back": True}


def quiet(core, hours=QUIET_HOURS):
    """Sessions with no word for `hours` come back to triage, in case the window never said it closed."""
    cutoff = iso(core.now() - timedelta(hours=hours))
    n = 0
    for t in core.all("SELECT * FROM tasks WHERE user_id=? AND state='session' "
                      "AND COALESCE(session_at, state_changed_at) < ?", (core.user_id, cutoff)):
        tasks.bring_back(core, t["id"], actor="system",
                         reason=f"This has been open in {label(core)} a while with no word on how it's going."
                                f"{_left_off(t)}")
        n += 1
    return n
