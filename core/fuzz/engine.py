"""Settings > Engine, over the same code as `fuzz install`, `fuzz doctor` and `fuzz config`."""

import os
import subprocess
import sys

from . import doctor, installer
from .adapters.base import PKG_PARENT
from .db import FuzzError

ACTIONS = ("install", "update", "repair", "uninstall")


def get(core, refresh=False):
    return doctor.status(core, refresh=refresh)


def action(core, client, what, roles=None, link=False):
    if what not in ACTIONS:
        raise FuzzError(f"action must be one of {', '.join(ACTIONS)}", "action", 404)
    doctor.clear_cache()
    if what == "uninstall":
        return installer.uninstall(core, client)
    if what in ("update", "repair"):
        entry = installer.load_manifest(core).get(client)
        if entry is None:
            raise FuzzError("Install it first", "client", 409)
        roles = roles or entry.get("roles")
        link = any(s.get("link") for s in entry.get("skills", []))
    return installer.install(core, client, roles=roles or installer.ROLES, link=link)


def select(core, client, model=None):
    """Switch the engine. Only clients whose status is Ready can be picked; it takes effect at the next run."""
    st = next((c for c in doctor.status(core)["clients"] if c["client"] == client), None)
    if st is None:
        raise FuzzError(f"Unknown client {client!r}", "client")
    if st["summary"] != "ready":
        raise FuzzError(f"{st['label']} isn't ready: {st['first_fix']}", "client", 409)
    eng = installer.set_engine(core, client, model)
    doctor.clear_cache()
    return eng


def restore_selection(core, prior):
    """Undo of engine.selected: put the earlier engine back (called inside the undo transaction)."""
    cfg = core.config
    cfg["engine"] = {"client": (prior or {}).get("client"), "model": (prior or {}).get("model")}
    core.save_config(cfg)
    doctor.clear_cache()


def run_now(core, role, task_id=None, scripted=False):
    """Start `fuzz run` in the background, the way launchd would."""
    args = [sys.executable, "-m", "fuzz", "run", role, "--trigger", "ui"]
    if task_id:
        args += ["--task", str(task_id)]
    if scripted:
        args.append("--scripted")
    env = dict(os.environ, FUZZ_HOME=core.home, FUZZ_USER=str(core.user_id),
               PYTHONPATH=PKG_PARENT + os.pathsep + os.environ.get("PYTHONPATH", ""))
    log = open(os.path.join(core.home, "run-now.log"), "a")
    p = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    return {"started": True, "pid": p.pid, "role": role}

