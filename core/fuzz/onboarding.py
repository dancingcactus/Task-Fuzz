"""The first-run onboarding (docs/onboarding.md): where you are in it, your working hours, and the setup
cards that come after it.

Progress is the UI's, kept here so closing the page at any step, or opening it in another browser,
comes back to the same step. It isn't an event: nothing in it is a decision Undo should reverse. It
lives in onboarding-u<user>.json in the store folder.

Setup cards are like check-ins: the UI decides when one fits (after real work, one at a time), and
the core keeps the answers and the order (lookup source, output folder, colour theme).
"""

import json
import os
from datetime import datetime, timedelta

from . import outputs, setup
from .db import FuzzError

STEPS = ("intro", "form", "capture", "wait", "card", "done")   # Fuzz says hello, then asks
SETUP_CARDS = ("lookup", "folder", "theme")
THEME_AFTER_DAYS = 3        # the colour theme card is a light one, a few days in
LATER_AGAIN_DAYS = 1        # a card you said Not now to can come back once, a day later at the soonest


def _path(core):
    return os.path.join(core.home, f"onboarding-u{core.user_id}.json")


def _blank():
    return {"step": "intro", "done": False, "skipped": False, "started_at": None, "finished_at": None,
            "task_id": None, "name": None, "app": None, "hours_set": False, "first_read": None,
            "tips": [], "setup": {}}


def load(core):
    p = _path(core)
    st = _blank()
    if os.path.exists(p):
        try:
            with open(p) as f:
                st.update(json.load(f))
        except ValueError:
            pass   # a damaged file starts over rather than locking you out
    return st


def save(core, st):
    os.makedirs(core.home, exist_ok=True)
    tmp = _path(core) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=2)
    os.replace(tmp, _path(core))
    return st


def set_up_before(core):
    """Someone who set Fuzz up before the onboarding existed never sees it: the old guided setup was
    finished, or there is already work in the store."""
    if (core.config.get("setup") or {}).get("done"):
        return True
    return bool(core.one("SELECT COUNT(*) n FROM tasks WHERE user_id=?", (core.user_id,))["n"])


def view(core):
    st = load(core)
    out = dict(st)
    out["needed"] = not st["done"] and not (st["started_at"] is None and set_up_before(core))
    out["hours"] = hours(core)
    out["setup_card"] = next_setup_card(core, st)
    return out


def update(core, body):
    """Saves where you are. {step?, task_id?, name?, app?, tips?, done?, skipped?, again?}"""
    st = load(core)
    if body.get("again"):   # Settings > Show me around again: the intro and the tips, from the start
        keep = {k: st[k] for k in ("setup", "first_read", "name", "app", "hours_set")}
        st = _blank()
        st.update(keep)
        st["step"] = "intro"
    if "step" in body:
        if body["step"] not in STEPS:
            raise FuzzError(f"step must be one of {', '.join(STEPS)}", "step")
        st["step"] = body["step"]
    if "task_id" in body:
        if body["task_id"] is not None and not isinstance(body["task_id"], int):
            raise FuzzError("task_id is the task you captured", "task_id")
        st["task_id"] = body["task_id"]
    for k in ("name", "app"):
        if k in body:
            st[k] = body[k] if isinstance(body[k], str) and body[k].strip() else None
    if "tips" in body:
        if not isinstance(body["tips"], list) or not all(isinstance(t, str) for t in body["tips"]):
            raise FuzzError("tips is a list of the tips already said", "tips")
        st["tips"] = sorted(set(st["tips"]) | set(body["tips"]))
    if st["started_at"] is None:
        st["started_at"] = core.now_iso()
    if body.get("skipped"):
        st["skipped"] = True
        body = dict(body, done=True)
    if body.get("done") and not st["done"]:
        st["done"], st["step"], st["finished_at"] = True, "done", core.now_iso()
        cfg = core.config
        cfg["setup"] = {"done": True}   # the old guided setup no longer opens by itself
        core.save_config(cfg)
    if body.get("first_read"):
        st["first_read"] = core.now_iso()
    save(core, st)
    return view(core)


# ---------------------------------------------------------------- working hours

def hours(core):
    """{hours: [from, until] | None, weekends}. None: no fixed hours, so Fuzz reads around the clock."""
    ex = core.config.get("extract") or {}
    return {"hours": ex.get("hours"), "weekends": bool(ex.get("weekends"))}


def set_hours(core, body):
    h = body.get("hours")
    if h is not None:
        if (not isinstance(h, list) or len(h) != 2 or not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                                                               for x in h)):
            raise FuzzError("hours is [from, until] in hours of the day, like [9, 17.5], or null", "hours")
        if not (0 <= h[0] < h[1] <= 24):
            raise FuzzError("Working hours start before they end, within one day", "hours")
    weekends = body.get("weekends", False)
    if not isinstance(weekends, bool):
        raise FuzzError("weekends is true or false", "weekends")
    cfg = core.config
    cfg["extract"] = dict(cfg.get("extract") or {}, hours=h, weekends=True if h is None else weekends)
    core.save_config(cfg)
    st = load(core)
    st["hours_set"] = True
    save(core, st)
    return hours(core)


# ---------------------------------------------------------------- setup cards

def _lookup_set(core):
    client = (core.config.get("engine") or {}).get("client")
    return bool(client and (((core.config.get("read") or {}).get("tools") or {}).get(client)))


def _ago(core, iso_, days):
    if not iso_:
        return True
    return core.now() - datetime.fromisoformat(iso_) >= timedelta(days=days)


def next_setup_card(core, st=None):
    """The one setup card that may show now, or None. Only after the onboarding, in order, each at most
    twice (Not now once, then it stays away). What's already set never asks."""
    st = st or load(core)
    if not st["done"]:
        return None
    for name in SETUP_CARDS:
        rec = st["setup"].get(name) or {}
        if rec.get("status") in ("answered", "declined"):
            continue
        if name == "lookup" and _lookup_set(core):
            continue
        if name == "folder" and outputs.folder(core):
            continue
        if name == "theme" and not _ago(core, st["finished_at"], THEME_AFTER_DAYS):
            return None   # the light card waits its turn, and nothing comes after it
        if rec.get("status") == "later" and not _ago(core, rec.get("at"), LATER_AGAIN_DAYS):
            return None   # one at a time: a card you put off holds its place
        return {"name": name, "again": rec.get("status") == "later",
                "folder": os.path.expanduser(setup.SUGGESTED_FOLDER) if name == "folder" else None,
                "engine": (core.config.get("engine") or {}).get("client")}
    return None


def answer_setup(core, name, answer):
    """yes: done (the folder card makes ~/Documents/Fuzz). not_now: away quietly; a second Not now and it
    stays away for good. Settings still has everything."""
    if name not in SETUP_CARDS:
        raise FuzzError(f"No setup card {name!r}", "name", 404)
    if answer not in ("yes", "not_now"):
        raise FuzzError("answer is yes or not_now", "answer")
    st = load(core)
    rec = dict(st["setup"].get(name) or {})
    if answer == "yes":
        if name == "folder":
            setup.set_folder(core, setup.SUGGESTED_FOLDER)
        rec["status"] = "answered"
    else:
        rec["later"] = rec.get("later", 0) + 1
        rec["status"] = "declined" if rec["later"] >= 2 else "later"
    rec["at"] = core.now_iso()
    st["setup"][name] = rec
    save(core, st)
    return view(core)

