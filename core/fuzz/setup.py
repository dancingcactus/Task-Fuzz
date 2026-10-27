"""Setup, shared by `fuzz setup` and the UI's guided setup: who you are, which tools Fuzz can use, an
output folder, and a check. Each step can be skipped and done again later."""

import os
import subprocess
import sys

from . import adapters, config, connectors, doctor, installer, outputs
from .db import FuzzError

SUGGESTED_FOLDER = "~/Documents/Fuzz"


def clients(core):
    """The clients Fuzz is installed for, the engine first; every client when none is."""
    man = installer.load_manifest(core)
    eng = (core.config.get("engine") or {}).get("client")
    names = [n for n in adapters.ADAPTERS if n in man] or list(adapters.ADAPTERS)
    return sorted(names, key=lambda n: n != eng)


def state(core, check=True):
    cfg = core.config
    out = {"done": bool((cfg.get("setup") or {}).get("done")),
           "me": {k: cfg["me"].get(k, []) for k in config.ME_KEYS},
           "tools": [connectors.view(core, n) for n in clients(core)],
           "folder": {"path": outputs.folder(core), "suggested": os.path.expanduser(SUGGESTED_FOLDER)}}
    if check:
        st = doctor.status(core, check_start=False)
        out["check"] = [{"client": c["client"], "label": c["label"], "summary": c["summary"],
                         "first_fix": c["first_fix"], "is_engine": c["is_engine"]} for c in st["clients"]
                        if c["client"] in clients(core)]
    return out


def set_folder(core, folder):
    """The output folder, made if it isn't there. None or "" turns file writing off."""
    cfg = core.config
    if folder:
        path = os.path.abspath(os.path.expanduser(str(folder).strip()))
        if os.path.exists(path) and not os.path.isdir(path):
            raise FuzzError(f"{path} is a file, not a folder", "folder")
        os.makedirs(path, exist_ok=True)
        if not os.access(path, os.W_OK):
            raise FuzzError(f"Fuzz can't write to {path}", "folder")
        cfg["output"] = {"folder": path}
    else:
        cfg["output"] = {"folder": None}
    core.save_config(cfg)
    doctor.clear_cache()
    return {"path": outputs.folder(core)}


def finish(core, done=True):
    cfg = core.config
    cfg["setup"] = {"done": bool(done)}
    core.save_config(cfg)
    return {"done": bool(done)}


def choose_folder(start=None, timeout=600):
    """The Mac's own folder chooser, opened by the server for the page: a browser never tells a page the
    real path of a folder you pick. Returns the path, or None if you cancelled."""
    if sys.platform != "darwin":
        raise FuzzError("Choosing a folder this way works on a Mac only. Type the path instead", "folder", 501)
    start = os.path.abspath(os.path.expanduser(start or SUGGESTED_FOLDER))
    while start and not os.path.isdir(start):
        start = os.path.dirname(start)
    choose = ('choose folder with prompt "The folder Fuzz may write to"'
              + (f' default location (POSIX file "{_osa(start)}")' if start else ""))
    # Inside System Events it opens in front of the browser. macOS may not allow that (-1743, Automation),
    # so then it opens from osascript itself, which can land behind other windows.
    for lines in (['tell application "System Events"', "activate", f"set f to {choose}", "end tell", "POSIX path of f"],
                  [f"set f to {choose}", "POSIX path of f"]):
        argv = ["osascript"] + [x for line in lines for x in ("-e", line)]
        try:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None
        if p.returncode == 0:
            return p.stdout.strip().rstrip("/") or None
        if "-128" in (p.stderr or ""):   # you pressed Cancel
            return None
        if "-1743" not in (p.stderr or ""):
            break
    raise FuzzError(f"The folder chooser didn't open: {(p.stderr or '').strip()}", "folder")


def _osa(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')

