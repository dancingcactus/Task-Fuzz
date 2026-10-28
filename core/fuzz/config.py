"""config.json in the store folder: who you are, the engine, budgets and the matcher's settings."""

import copy
import json
import os

DEFAULTS = {
    "me": {"names": [], "emails": [], "slack_ids": [], "folders": {}},
    "engine": {"client": None, "model": None},
    "roles": {},
    "budget": {"max_working": 2, "max_steps": 20, "max_attempts": 3, "lease_minutes": 10},
    "tz": "local",
    "stale_days": 7,
    # The parked review: a few parked tasks a day come back to ask "Still want this?", how many by your
    # last check-in that day (none without one), at most `weekly` in any 7 days. A task is asked about
    # once it has sat `rest_days`, then again `again_days` after you keep it. After `let_go_after` keeps,
    # the card suggests letting it go.
    "review": {"enabled": True, "weekly": 7, "per_day": {"good": 3, "okay": 1}, "rest_days": 7,
               "again_days": 28, "let_go_after": 3},
    # A task you capture goes to Fuzz first, to look it up with the read tools below, then to triage.
    # minutes: how long it may wait for a run before it comes to you without. finish_results: when
    # looking it up is the whole task (a summary, an agenda), Fuzz does it then and it arrives done.
    "gather": {"enabled": True, "minutes": 10, "finish_results": True},
    # The one folder the executor may create and change files in, one subfolder per task. None: it can't
    # write files. Set it in `fuzz setup`; the suggestion is ~/Documents/Fuzz.
    "output": {"folder": None},
    "setup": {"done": False},
    "presence": {"enabled": True, "away_minutes": 15},   # back-at-desk detection, on a Mac
    "files": {"max_mb": 25, "max_per_task": 10},
    # Slack messages from one person, each within this many minutes of the one before (and nothing from
    # you in between), are one origin, so their asks form a group.
    "grouping": {"slack_burst_minutes": 10},
    # The connector tools the sender may call to send an approved draft, per client, as that client
    # names them (e.g. "mcp__claude_ai_Slack__slack_send_message"). Empty: the sender can't send and
    # hands each draft back.
    "send": {"tools": {"claude-code": [], "copilot": []}},
    # Connector tools the executor may call to look things up (a search, a calendar read), per client, as
    # that client names them (e.g. "Glean" for every tool of that Copilot server). List only tools that
    # read: whatever is listed runs without asking. Empty: the executor has only Fuzz's own tools.
    "read": {"tools": {"claude-code": [], "copilot": []}},
    "embedder": "ollama",
    "ollama_model": "nomic-embed-text",
    "ollama_url": "http://localhost:11434",
}


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load(home):
    path = os.path.join(home, "config.json")
    if not os.path.exists(path):
        return copy.deepcopy(DEFAULTS)
    with open(path) as f:
        return _merge(DEFAULTS, json.load(f))


def save(home, cfg):
    os.makedirs(home, exist_ok=True)
    tmp = os.path.join(home, "config.json.tmp")
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, os.path.join(home, "config.json"))


def get(cfg, key):
    cur = cfg
    for part in key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise KeyError(key)
        cur = cur[part]
    return cur


def set_(cfg, key, value):
    parts = key.split(".")
    cur = cfg
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value
    return cfg


ME_KEYS = {"names": "name", "emails": "email", "slack_ids": "slack"}


def update_me(cfg, add=None, remove=None, replace=None):
    """Who you are: every name, email address and Slack ID that is yours (work and personal alike), so the
    executor knows a connector signed in to any of them is yours. Each of add/remove/replace maps names,
    emails and slack_ids to lists. Emails are kept lowercase."""
    me = cfg.setdefault("me", {})
    for key in ME_KEYS:
        def clean(vals):
            vals = [v.strip() for v in (vals or []) if isinstance(v, str) and v.strip()]
            return [v.lower() for v in vals] if key == "emails" else vals
        if replace is not None and key in replace:
            cur = clean(replace[key])
        else:
            cur = list(me.get(key, []))
        cur += clean((add or {}).get(key))
        gone = set(clean((remove or {}).get(key)))
        me[key] = sorted({v for v in cur if v not in gone})
    return me


def gathers(cfg):
    """Whether a capture goes to Fuzz first: only when it's on and an executor can run."""
    return bool((cfg.get("gather") or {}).get("enabled") and role_engine(cfg, "executor")[0])


def role_engine(cfg, role, client=None, model=None):
    """The client and model a role runs on: --client/--model, then the role's override, then the engine."""
    over = (cfg.get("roles") or {}).get(role) or {}
    eng = cfg.get("engine") or {}
    return client or over.get("client") or eng.get("client"), model or over.get("model") or eng.get("model")
