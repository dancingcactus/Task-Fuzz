#!/usr/bin/env python3
"""A stand-in for the `claude` and `copilot` CLIs, for the installer and adapter tests.

It keeps its MCP registry in $HOME/.stub-<name>.json, records every headless argv in
$HOME/.stub-<name>-runs.json, and on `-p` acts like a client: it starts the server from the
run's MCP config and works one task through Fuzz's tools.
"""

import asyncio
import json
import os
import sys

NAME = os.path.basename(sys.argv[0])
HOME = os.path.expanduser("~")
REG = os.path.join(HOME, f".stub-{NAME}.json")
RUNS = os.path.join(HOME, f".stub-{NAME}-runs.json")


def load(p, default):
    return json.load(open(p)) if os.path.exists(p) else default


def save(p, data):
    if data:
        json.dump(data, open(p, "w"))
    elif os.path.exists(p):
        os.remove(p)


def mcp(args):
    reg = load(REG, {})
    if args[0] == "add-json":
        rest = [a for a in args[1:] if a not in ("--scope", "-s", "user")]
        reg[rest[0]] = json.loads(rest[1])
        save(REG, reg)
        return 0
    if args[0] == "remove":
        name = [a for a in args[1:] if a not in ("--scope", "-s", "user")][0]
        existed = reg.pop(name, None) is not None
        save(REG, reg)
        return 0 if existed else 1
    if args[0] == "get":
        return 0 if args[1] in reg else 1
    return 2


async def work(spec):
    sys.path.insert(0, spec["env"]["PYTHONPATH"])
    from mcp import Client, StdioServerParameters
    params = StdioServerParameters(command=spec["command"], args=spec["args"], env=dict(os.environ, **spec["env"]))
    async with Client(params, read_timeout_seconds=30) as c:
        async def call(name, a=None):
            r = await c.call_tool(name, a or {})
            return json.loads(r.content[0].text)
        await call("whoami", {"prompt_version": "executor-0.1"})
        t = (await call("claim_next_task")).get("task")
        if t:
            await call("log_step", {"task_id": t["id"], "kind": "research", "text": f"{NAME} read the task"})
            for f in [x for x in t["sources"] if x.get("path")]:   # its own file tool, at the path it was given
                size = len(open(f["path"], "rb").read())
                await call("log_step", {"task_id": t["id"], "kind": "research", "text": f"opened {f['title']}: {size}"})
            await call("save_draft", {"task_id": t["id"], "kind": "note", "target": "", "body": f"{NAME} draft"})


def headless(args):
    runs = load(RUNS, [])
    runs.append({"argv": args, "env_run": os.environ.get("FUZZ_RUN_ID")})
    save(RUNS, runs)
    if "--mcp-config" in args:
        path = args[args.index("--mcp-config") + 1]
    else:
        path = args[args.index("--additional-mcp-config") + 1].lstrip("@")
    servers = json.load(open(path))["mcpServers"]
    asyncio.run(work(next(iter(servers.values()))))
    return 0


def main():
    args = sys.argv[1:]
    if args[:1] == ["--version"]:
        print(f"9.9.9 ({NAME} stub)")
        return 0
    if args[:1] == ["mcp"]:
        return mcp(args[1:])
    if args[:1] == ["-p"]:
        return headless(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
