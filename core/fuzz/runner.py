"""`fuzz run executor|extractor|sender`: the same command for launchd, the UI's Run now, and you debugging.

Every run writes run.started and run.finished. A real run gets its own short-lived MCP config that
starts `fuzz mcp --role <role> --run <id>`, so it sees Fuzz's server and no other, and every event
it writes carries the run id.
"""

import json
import os
import subprocess

from . import adapters, config, files, outputs, runs, scheduler
from .db import FuzzError
from .roles import scripted


def _prompt_version(adapter, role):
    name = adapters.ROLE_SKILLS[role]
    return adapters.skill_version(adapter.skills_dir() / name) or adapters.skill_version(adapters.SKILLS_SRC / name)


def run_role(core, role, client=None, model=None, task_id=None, scripted_=False, verbose=False, trigger="manual",
             signals=None, say=print):
    if role not in ("executor", "extractor", "sender"):
        raise FuzzError("role must be executor, extractor or sender", "role")
    if task_id and role != "executor":
        raise FuzzError("--task works only for the executor", "task")
    if role == "sender" and not scheduler.sends_waiting(core):
        # launchd checks every couple of minutes; don't start a client (or record a run) for nothing
        return {"run_id": None, "outcome": "nothing_to_do", "client": None, "model": None}
    adapter = None
    if scripted_:
        client_name, model, pv = "scripted", None, scripted.PROMPT_VERSION
    else:
        client_name, model = config.role_engine(core.config, role, client, model)
        if not client_name:
            raise FuzzError("No engine is set. Run `fuzz install --client claude-code` (or copilot), or pass --scripted",
                            "client")
        adapter = adapters.get(client_name)
        pv = _prompt_version(adapter, role)
    rid = runs.start(core, role, client_name, model, pv, trigger, detail={"task": task_id})
    runs.attach(core, rid)
    outcome, detail = "error", {}
    try:
        if scripted_:
            say_ = say if verbose else (lambda s: None)
            if role == "executor":
                res = scripted.run_executor(core, task_id, say_)
                outcome = "ok" if res["tasks"] else "nothing_to_do"
            elif role == "sender":
                res = scripted.run_sender(core, say_)
                outcome = "ok" if res["tasks"] else "nothing_to_do"
            else:
                res = scripted.run_extractor(core, signals, say_)
                outcome = "ok"
            detail = res
        else:
            outcome, detail = _headless(core, adapter, role, rid, model, task_id, verbose, say)
    except Exception as e:
        detail = {"error": str(e)}
        raise
    finally:
        core.run = None
        done = runs.finish(core, rid, outcome, detail)
        if role == "executor" and outputs.folder(core):   # whatever the run left in a task's folder is on the task
            for tid in done.get("tasks") or []:
                outputs.record(core, tid)
    return {"run_id": rid, "outcome": outcome, "client": client_name, "model": model, **detail}


def _headless(core, adapter, role, rid, model, task_id, verbose, say):
    if not adapter.find()["found"]:
        raise FuzzError(f"{adapter.label} isn't installed on this machine (no `{adapter.exe}` on PATH)", "client")
    run_dir = os.path.join(core.home, "runs", str(rid))
    os.makedirs(run_dir, exist_ok=True)
    cfg_path = adapter.write_run_config(role, rid, os.path.join(run_dir, "mcp.json"), core.home, core.user_id)
    files_dir = None
    if role == "executor":   # attachments: readable with the client's own file tools, nothing else is
        files_dir = files.user_dir(core)
        os.makedirs(files_dir, exist_ok=True)
    send_tools = read_tools = write_dir = None
    out = outputs.folder(core)
    if out:
        os.makedirs(out, exist_ok=True)
    if role == "sender":   # the connector tools you allowed for sending, as this client names them
        send_tools = list(((core.config.get("send") or {}).get("tools") or {}).get(adapter.name) or [])
        files_dir = out    # it may attach what the executor saved there
    if role in ("executor", "extractor"):   # the ones you allowed for looking things up: Slack, mail, docs
        read_tools = list(((core.config.get("read") or {}).get("tools") or {}).get(adapter.name) or [])
    if role == "executor":   # and the folder it may write to
        write_dir = out
    argv = adapter.headless_command(role, cfg_path, model, task_id, verbose, files_dir, send_tools=send_tools,
                                    read_tools=read_tools, write_dir=write_dir)
    with open(os.path.join(run_dir, "argv.json"), "w") as f:
        json.dump(argv, f, indent=2)
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            env=adapter.run_env(rid), cwd=files_dir or run_dir)   # its working folder is readable too
    out = []
    with open(os.path.join(run_dir, "transcript.log"), "w") as log:
        for line in proc.stdout:
            out.append(line)
            log.write(line)
            if verbose:
                say(line.rstrip())
    rc = proc.wait()
    text = "".join(out)
    ok = adapter.run_ok(rc, text)
    return ("ok" if ok else "error"), {"returncode": rc, "transcript": os.path.join(run_dir, "transcript.log")}
