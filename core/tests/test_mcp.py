"""The MCP contract: each role sees only its tools, a scripted run goes end to end, and errors name the field."""

import asyncio
import json
import os
import sys
import unittest

from helpers import CoreCase

from mcp import Client, StdioServerParameters

from fuzz import mcp_server, runner, tasks, tools

EXECUTOR = {"whoami", "claim_next_task", "get_task", "read_source", "log_step", "save_notes", "save_draft",
            "hand_back", "create_task", "request_permission", "suggest_schedule", "update_brief", "release"}
EXTRACTOR = {"whoami", "get_cursors", "submit_signals", "get_pending_judgments", "submit_verdicts"}


def run(coro):
    return asyncio.run(coro)


async def tool_names(srv):
    async with Client(srv) as c:
        return {t.name for t in (await c.list_tools()).tools}


async def call(srv, name, args):
    async with Client(srv) as c:
        r = await c.call_tool(name, args)
        return r.is_error, r.content[0].text


class RoleScoping(CoreCase):
    def test_each_role_sees_only_its_tools(self):
        self.assertEqual(run(tool_names(mcp_server.build(self.core, "executor"))), EXECUTOR)
        self.assertEqual(run(tool_names(mcp_server.build(self.core, "extractor"))), EXTRACTOR)
        self.assertLessEqual(len(EXECUTOR), 15, "past about fifteen tools a model picks the wrong one")

    def test_no_tool_reaches_outside(self):
        for name in EXECUTOR | EXTRACTOR:
            for word in ("send", "post", "delete"):
                self.assertNotIn(word, name)

    def test_errors_name_the_field(self):
        srv = mcp_server.build(self.core, "extractor")
        err, text = run(call(srv, "submit_signals", {"signals": [{"source": "fax", "source_id": "1"}]}))
        self.assertTrue(err)
        self.assertIn("signals[0].source", text)
        err, text = run(call(srv, "submit_signals", {"signals": [{"source": "email", "source_id": "1",
                                                                  "candidates": [{"ask": "x", "colour": "red"}]}]}))
        self.assertIn("signals[0].candidates[0]", text)
        self.assertIn("colour", text)

    def test_writes_return_ids_not_echoes(self):
        tid = tasks.capture(self.core, "Reply to Elena")
        tasks.assign(self.core, tid)
        srv = mcp_server.build(self.core, "executor")

        async def go():
            async with Client(srv) as c:
                await c.call_tool("claim_next_task", {})
                r = await c.call_tool("save_draft", {"task_id": tid, "kind": "email.reply", "target": "elena@acme.com",
                                                     "body": "A long body " * 50})
                return json.loads(r.content[0].text)
        out = run(go())
        self.assertEqual(set(out), {"draft_id", "state"})


class ScriptedRuns(CoreCase):
    def test_scripted_executor_end_to_end(self):
        ids = [tasks.capture(self.core, t) for t in ("Book the room for Thursday", "Reply to Elena")]
        for tid in ids:
            tasks.assign(self.core, tid)
        res = runner.run_role(self.core, "executor", scripted_=True, say=lambda s: None)
        self.assertEqual((res["outcome"], res["tasks"]), ("ok", ids))
        for tid in ids:
            self.assertEqual(self.task(tid)["state"], "review")
            self.card_for(tid, "draft")
        rid = res["run_id"]
        ai = self.core.all("SELECT DISTINCT run_id, prompt_version FROM events WHERE actor='fuzz:executor'")
        self.assertEqual(ai, [{"run_id": rid, "prompt_version": "scripted-1"}])
        types = [r["type"] for r in self.core.all("SELECT type FROM events WHERE type LIKE 'run.%'")]
        self.assertEqual(types, ["run.started", "run.finished"])

    def test_scripted_run_with_nothing_to_do(self):
        res = runner.run_role(self.core, "executor", scripted_=True, say=lambda s: None)
        self.assertEqual(res["outcome"], "nothing_to_do")

    def test_task_flag_works_only_that_task(self):
        a, b = tasks.capture(self.core, "First"), tasks.capture(self.core, "Second")
        tasks.assign(self.core, a)
        tasks.assign(self.core, b)
        res = runner.run_role(self.core, "executor", task_id=b, scripted_=True, say=lambda s: None)
        self.assertEqual(res["tasks"], [b])
        self.assertEqual(self.task(a)["state"], "queued")

    def test_a_real_run_needs_an_engine(self):
        from fuzz.db import FuzzError
        with self.assertRaises(FuzzError) as e:
            runner.run_role(self.core, "executor")
        self.assertEqual(e.exception.field, "client")


class OverStdio(CoreCase):
    """The server as a client starts it: `python -m fuzz mcp --role … --run …`."""

    def test_stdio_server_stamps_its_run(self):
        from fuzz import runs
        tid = tasks.capture(self.core, "Reply to Elena")
        tasks.assign(self.core, tid)
        rid = runs.start(self.core, "executor", "claude-code", "model-x", "executor-0.1")
        env = dict(os.environ, FUZZ_HOME=self.home, PYTHONPATH=os.path.dirname(os.path.dirname(__file__)))
        params = StdioServerParameters(command=sys.executable, args=["-m", "fuzz", "mcp", "--role", "executor",
                                                                      "--run", str(rid)], env=env)

        async def go():
            async with Client(params, read_timeout_seconds=30) as c:
                names = {t.name for t in (await c.list_tools()).tools}
                r = await c.call_tool("claim_next_task", {})
                return names, json.loads(r.content[0].text)
        names, claimed = run(go())
        self.assertEqual(names, EXECUTOR)
        self.assertEqual(claimed["task"]["id"], tid)
        ev = self.core.one("SELECT run_id, model, prompt_version FROM events WHERE type='task.claimed'")
        self.assertEqual(ev, {"run_id": rid, "model": "model-x", "prompt_version": "executor-0.1"})


class ExecutorTools(CoreCase):
    def test_create_task_goes_through_matching(self):
        parent = tasks.capture(self.core, "Plan the offsite")
        tasks.assign(self.core, parent)
        tools.claim_next_task(self.core)
        out = tools.create_task(self.core, "Book the offsite venue", parent_task_id=parent)
        self.assertEqual(out["outcome"], "new")
        child = self.task(out["task_id"])
        self.assertEqual((child["state"], child["parent_id"]), ("triage", parent))

    def test_read_source_is_logged(self):
        tools.submit_signals(self.core, [{"source": "slack", "source_id": "C1:1", "anchor": "slack:C1:1",
                                          "ts": "2026-10-20T08:00:00Z", "from": {"name": "Marcus"},
                                          "quote": "Need a final headcount today",
                                          "candidates": [{"ask": "Confirm headcount for the offsite"}]}])
        tid = self.core.one("SELECT id FROM tasks")["id"]
        tasks.assign(self.core, tid)
        t = tools.claim_next_task(self.core)["task"]
        src = tools.read_source(self.core, t["sources"][0]["id"])
        self.assertEqual(src["quote"], "Need a final headcount today")
        self.assertEqual(self.core.one("SELECT COUNT(*) n FROM events WHERE type='source.read'")["n"], 1)


if __name__ == "__main__":
    unittest.main()
