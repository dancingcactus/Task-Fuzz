"""Which connector tools Fuzz may use: discovery, the lookup/send split, and read.tools / send.tools.

Discovery is one run of the client, started only when you ask (`fuzz setup`, or Discover in the UI):
the run sees every tool the client loads, can call none of them, and answers with a JSON list. Fuzz
can't list them itself, since most connectors sign in through the client. What it found is kept in
connectors.json in the store folder, so choosing tools later costs nothing.

Nothing here pre-selects a tool that sends or changes anything: a tool is suggested for lookups only
when the run says it only reads and its name doesn't say otherwise.
"""

import json
import os
import re
import subprocess

from . import adapters, runs
from .config import set_
from .db import FuzzError

PROMPT = """You are helping set up Fuzz. Don't call any tool. List every tool you can see that comes from an \
MCP server or connector, skipping your built-in tools and any server whose name starts with fuzz-. Answer with \
JSON only, no prose: a list of objects {"tool": "<its exact name as you see it>", "server": "<the server it \
comes from>", "does": "<what it does, in a short plain sentence>", "kind": "lookup" | "send" | "change"}. \
lookup: it only reads or searches. send: it sends a message, email or post to someone. change: it creates, \
edits, deletes or runs anything else."""

# Names that say a tool does more than read, whatever the run said about it
WRITES = re.compile(r"(^|[_\-.])(send|post|reply|comment|create|add|new|update|edit|set|write|delete|remove|"
                    r"archive|move|upload|book|invite|accept|decline|respond|draft|share|label|mark|trash|"
                    r"do_action|execute|exec|call_function|run|trigger|generate|submit|approve|merge|close)"
                    r"([_\-.]|$)", re.I)
SEND = re.compile(r"^(send|post|reply|forward|chat_postmessage)([_\-.]|$)", re.I)
TOKENS_PER_TOOL = 180   # a tool's name, description and schema in every run's context, roughly


def path(core):
    return os.path.join(core.home, "connectors.json")


def load(core):
    p = path(core)
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def _save(core, data):
    tmp = path(core) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path(core))


def parse(text):
    """The JSON list out of a run's answer, which may come wrapped in prose or a code fence."""
    m = re.search(r"\[.*\]", text or "", re.S)
    if not m:
        raise FuzzError("The discovery run didn't answer with a list of tools", "discover")
    try:
        rows = json.loads(m.group(0))
    except ValueError as e:
        raise FuzzError(f"The discovery run's list isn't valid JSON: {e}", "discover")
    return [r for r in rows if isinstance(r, dict) and (r.get("tool") or "").strip()]


def classify(name, said):
    """lookup, send or change. A name that writes wins over a run that said lookup."""
    said = said if said in ("lookup", "send", "change") else "change"
    short = re.split(r"__|-", name)[-1] if "(" not in name else name[name.index("(") + 1:-1]
    if said == "change":
        return said
    if SEND.search(short):
        return "send"
    if said == "lookup" and WRITES.search(short):
        return "change"
    return said


def build(adapter, rows, servers):
    tools, seen = [], set()
    for r in rows:
        name = r["tool"].strip()
        if name in seen or name.startswith(("fuzz-", "mcp__fuzz-")):
            continue
        seen.add(name)
        allow = adapter.allow_name(name, servers)
        kind = classify(allow, (r.get("kind") or "").strip().lower())
        tools.append({"tool": name, "allow": allow, "server": (r.get("server") or "").strip() or None,
                      "does": (r.get("does") or "").strip(), "kind": kind, "suggested": kind == "lookup"})
    tools.sort(key=lambda t: ((t["server"] or "").lower(), t["tool"].lower()))
    return tools


def discover(core, client, model=None, runner=None):
    """One run of the client that lists its tools. runner(argv) -> output text, for tests."""
    adapter = adapters.get(client)
    if runner is None and not adapter.find()["found"]:
        raise FuzzError(f"{adapter.label} isn't installed on this machine (no `{adapter.exe}` on PATH)", "client")
    servers = adapter.list_servers()
    argv = adapter.discovery_command(PROMPT, model)
    rid = runs.start(core, "setup", client, model, "discover-0.1", "setup")
    outcome, detail = "error", {}
    try:
        if runner:
            text = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=600, cwd=core.home)
            text = p.stdout
        tools = build(adapter, parse(text), servers)
        outcome, detail = "ok", {"tools": len(tools)}
    except subprocess.TimeoutExpired:
        detail = {"error": "timed out"}
        raise FuzzError(f"{adapter.label} took too long to list its tools", "discover")
    except FuzzError as e:
        detail = {"error": str(e)}
        raise
    finally:
        runs.finish(core, rid, outcome, detail)
    data = load(core)
    data[client] = {"discovered_at": core.now_iso(), "servers": servers, "tools": tools}
    _save(core, data)
    return view(core, client)


def chosen(core, client):
    cfg = core.config
    return (list(((cfg.get("read") or {}).get("tools") or {}).get(client) or []),
            list(((cfg.get("send") or {}).get("tools") or {}).get(client) or []))


def covers(pattern, allow):
    """Whether a read.tools entry ("Glean" for a whole server) covers a tool ("Glean(search)")."""
    return pattern == allow or ("(" not in pattern and allow.startswith(pattern + "("))


def view(core, client):
    """What the setup screen shows for one client: what was found, what is allowed, what a run costs."""
    adapter = adapters.get(client)
    found = load(core).get(client) or {}
    read, send = chosen(core, client)
    tools = []
    for t in found.get("tools") or []:
        tools.append(dict(t, read=any(covers(p, t["allow"]) for p in read),
                          send=any(covers(p, t["allow"]) for p in send)))
    n = sum(1 for t in tools if t["read"]) or len(read)
    return {"client": client, "label": adapter.label, "discovered_at": found.get("discovered_at"),
            "servers": found.get("servers") or [], "tools": tools, "read": read, "send": send,
            "cost": {"tools": n, "tokens": n * TOKENS_PER_TOOL,
                     "note": f"About {n * TOKENS_PER_TOOL:,} more tokens in every executor run" if n else
                     "Only Fuzz's own tools: the cheapest runs"}}


def choose(core, client, read=None, send=None):
    """Write read.tools and send.tools for a client, in its own syntax. Pass only what changes."""
    adapters.get(client)
    for name, value in (("read", read), ("send", send)):
        if value is None:
            continue
        if not isinstance(value, list) or not all(isinstance(x, str) and x.strip() for x in value):
            raise FuzzError(f"{name} is a list of tool names", name)
        cfg = core.config
        set_(cfg, f"{name}.tools.{client}", sorted({x.strip() for x in value}))
        core.save_config(cfg)
    return view(core, client)


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def match_server(found, resource):
    """The discovered server a permission request names: "Glean search" is Glean, "Gmail" is claude.ai Gmail."""
    r = _norm(resource)
    if not r:
        return None
    names = {t["server"] for t in found.get("tools") or [] if t.get("server")} | \
        {s["name"] for s in found.get("servers") or []}
    hits = [n for n in names if _norm(n) and (_norm(n) in r or r in _norm(n))]
    return max(hits, key=len) if hits else None


def allow_for_grant(core, resource):
    """You said Always allow to a connector: add its lookup tools to read.tools for every client that found
    it, so the next run can use it. Returns [(client, server, tools added)]."""
    out = []
    for client, found in load(core).items():
        server = match_server(found, resource)
        if not server:
            continue
        read, _ = chosen(core, client)
        add = [t["allow"] for t in found.get("tools") or [] if t.get("server") == server and t["kind"] == "lookup"
               and not any(covers(p, t["allow"]) for p in read)]
        if add:
            choose(core, client, read=read + add)
        out.append((client, server, add))
    return out


def askable(core, client=None):
    """Servers with lookup tools you haven't allowed: the names the executor can ask for by permission.
    With no client, every client's."""
    if client is None:
        return sorted({s for c in load(core) for s in askable(core, c)})
    found = load(core).get(client) or {}
    read, _ = chosen(core, client)
    return sorted({t["server"] for t in found.get("tools") or [] if t["kind"] == "lookup" and t.get("server")
                   and not any(covers(p, t["allow"]) for p in read)})
