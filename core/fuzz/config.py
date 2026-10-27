"""config.json in the store folder: who you are, the engine, budgets and the matcher's settings."""

import copy
import json
import os

DEFAULTS = {
    "me": {"names": [], "emails": [], "slack_ids": [], "folders": {}},
    "engine": {"client": None, "model": None},
    "roles": {},
    "budget": {"max_working": 5, "max_steps": 20, "max_attempts": 3, "lease_minutes": 10},
    "tz": "local",
    "stale_days": 7,
    "presence": {"enabled": True, "away_minutes": 15},   # back-at-desk detection, on a Mac
    "files": {"max_mb": 25, "max_per_task": 10},
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


def role_engine(cfg, role, client=None, model=None):
    """The client and model a role runs on: --client/--model, then the role's override, then the engine."""
    over = (cfg.get("roles") or {}).get(role) or {}
    eng = cfg.get("engine") or {}
    return client or over.get("client") or eng.get("client"), model or over.get("model") or eng.get("model")
