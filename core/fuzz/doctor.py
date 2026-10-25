"""`fuzz doctor`: is each client ready to run Fuzz's roles? Writes nothing; cached for a minute."""

import asyncio
import time

from . import adapters, installer, runs
from .adapters.base import ROLE_SKILLS, SKILLS_SRC, skill_version

CACHE_SECONDS = 60
_cache = {}


async def _starts(adapter, role, home, user_id):
    """Start `fuzz mcp --role <role>` the way the client would, and list its tools."""
    from mcp import Client, StdioServerParameters
    spec = adapter.mcp_server(role, home, user_id=user_id)
    params = StdioServerParameters(command=spec["command"], args=spec["args"], env=spec["env"])
    async with Client(params, read_timeout_seconds=20) as c:
        return len((await c.list_tools()).tools)


def _check_start(adapter, role, home, user_id):
    try:
        return asyncio.run(asyncio.wait_for(_starts(adapter, role, home, user_id), 30)), None
    except Exception as e:  # report, don't fail the whole check
        return 0, f"{type(e).__name__}: {e}"


def client_status(core, name, check_start=True):
    adapter = adapters.get(name)
    man = installer.load_manifest(core)
    entry = man.get(name)
    found = adapter.find()
    out = {"client": name, "label": adapter.label, "found": found["found"], "version": found.get("version"),
           "installed": entry is not None, "skills": [], "mcp": [], "last_run": None,
           "connectors": {"status": "unknown",
                          "note": f"Fuzz can't see {adapter.label}'s connectors. Check that an email and a Slack tool "
                                  f"are connected there for the extractor."}}
    fixes = []
    if not found["found"]:
        fixes.append(f"Install {adapter.label} (no `{adapter.exe}` on PATH)")
    roles = (entry or {}).get("roles") or []
    via = (entry or {}).get("skills_via")
    for role in roles:
        name_ = ROLE_SKILLS[role]
        current = skill_version(SKILLS_SRC / name_)
        src_adapter = adapters.get(via) if via else adapter
        path = src_adapter.skills_dir() / name_
        have = skill_version(path)
        status = "missing" if have is None else ("installed" if have == current else "out_of_date")
        out["skills"].append({"role": role, "name": name_, "status": status, "installed_version": have,
                              "current_version": current, "path": str(path), "via": via})
        if status == "missing":
            fixes.append(f"Reinstall the {name_} skill" + (" (Claude Code's copy is gone)" if via else ""))
        elif status == "out_of_date":
            fixes.append(f"Update the {name_} skill ({have} → {current})")
    for role in roles:
        reg = adapter.mcp_registered(role)
        tools, err = (_check_start(adapter, role, core.home, core.user_id) if check_start else (None, None))
        out["mcp"].append({"role": role, "name": adapter.mcp_name(role), "registered": reg,
                           "starts": (tools or 0) > 0 if check_start else None, "tools": tools, "error": err})
        if not reg:
            fixes.append(f"Register the {adapter.mcp_name(role)} MCP server")
        elif check_start and not tools:
            fixes.append(f"The {adapter.mcp_name(role)} server doesn't start: {err}")
    last = runs.last(core, client=name)
    if last:
        out["last_run"] = {k: last[k] for k in ("id", "role", "model", "started_at", "finished_at", "outcome")}
    eng = core.config.get("engine") or {}
    out["is_engine"] = eng.get("client") == name
    if entry is None:
        out["summary"], out["first_fix"] = "not_installed", f"Install Fuzz for {adapter.label}"
    elif fixes:
        out["summary"], out["first_fix"] = "needs_attention", fixes[0]
    else:
        out["summary"], out["first_fix"] = "ready", None
    out["fixes"] = fixes
    return out


def status(core, refresh=False, check_start=True):
    key = (core.home, core.user_id, check_start)
    hit = _cache.get(key)
    if hit and not refresh and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    eng = core.config.get("engine") or {}
    res = {"engine": {"client": eng.get("client"), "model": eng.get("model")},
           "roles": core.config.get("roles") or {},
           "clients": [client_status(core, n, check_start) for n in adapters.ADAPTERS]}
    _cache[key] = (time.time(), res)
    return res


def clear_cache():
    _cache.clear()
