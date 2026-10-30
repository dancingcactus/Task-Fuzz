"""Work in Claude / Copilot: the session's own tools, resuming, and sessions that end without saying how."""

import json
import os
import shlex
import unittest
from unittest import mock

from helpers import CoreCase

from fuzz import adapters, cli, mcp_server, scheduler, sessions, tasks, tools
from fuzz.db import FuzzError


def read(path):
    with open(path) as f:
        return f.read()


class Sessions(CoreCase):
    def setUp(self):
        super().setUp()
        self.tid = tasks.capture(self.core, "Decide the pricing page copy")
        p = mock.patch("fuzz.sessions.launch")
        self.launch = p.start()
        self.addCleanup(p.stop)

    def open(self):
        with mock.patch("fuzz.sessions.sys.platform", "darwin"):
            return sessions.open_session(self.core, self.tid)

    def engine(self, client):
        cfg = self.core.config
        cfg["engine"]["client"] = client
        self.core.save_config(cfg)

    def argv(self, res):
        """The command line the script runs, the prompt left as $(cat …)."""
        line = read(res["script"]).strip().splitlines()[-1]
        return shlex.split(line.replace('"$(cat ', "PROMPT(").replace(')"', ""))

    # ---- opening and resuming
    def test_open_moves_to_session_and_gives_the_session_its_tools(self):
        res = self.open()
        t = self.task(self.tid)
        self.assertEqual((t["state"], res["resumed"]), ("session", False))
        self.launch.assert_called_once_with(res["script"])
        argv = self.argv(res)
        sid = t["session_id"].split(":", 1)[1]
        self.assertEqual(argv[argv.index("--session-id") + 1], sid)
        cfg = json.loads(read(argv[argv.index("--mcp-config") + 1]))
        spec = cfg["mcpServers"]["fuzz-session"]
        self.assertEqual(spec["args"][-4:], ["--role", "session", "--task", str(self.tid)])
        self.assertEqual(argv[argv.index("--allowedTools") + 1], "mcp__fuzz-session__*")
        body = read(res["script"][:-len(".command")] + ".md")
        self.assertIn("end_session", body)
        script = read(res["script"])
        self.assertIn(f"session-closed --task {self.tid} --launch {t['session_launch']}", script)
        self.assertIn("trap closed EXIT", script)
        log = [x["text"] for x in tasks.events.task_log(self.core, self.tid)]
        self.assertEqual(log[0], "You started working on it in Claude.")

    def test_open_again_resumes_the_same_conversation(self):
        first = self.task(self.tid)
        self.open()
        sid = self.task(self.tid)["session_id"]
        res = self.open()
        argv = self.argv(res)
        self.assertTrue(res["resumed"])
        self.assertEqual(argv[argv.index("--resume") + 1], sid.split(":", 1)[1])
        self.assertNotIn("--session-id", argv)
        self.assertIn("get_task", read(res["script"][:-len(".command")] + ".md"))
        self.assertEqual(self.task(self.tid)["session_id"], sid)
        log = [x["text"] for x in tasks.events.task_log(self.core, self.tid)]
        self.assertEqual(log[:2], ["You went back to it in Claude.", "You started working on it in Claude."])
        self.assertIsNone(first.get("session_id"))

    def test_copilot_sessions(self):
        self.engine("copilot")
        res = self.open()
        argv = self.argv(res)
        self.assertEqual((res["label"], argv[1]), ("Copilot", "-i"))
        self.assertTrue(argv[argv.index("--additional-mcp-config") + 1].startswith("@"))
        self.assertEqual(argv[argv.index("--allow-tool") + 1], "fuzz-session")
        sid = argv[argv.index("--session-id") + 1]
        again = self.argv(self.open())
        self.assertEqual(again[again.index("--session-id") + 1], sid, "copilot resumes with the same flag")

    def test_switching_engine_starts_a_new_conversation(self):
        self.open()
        self.engine("copilot")
        res = self.open()
        self.assertFalse(res["resumed"])
        self.assertTrue(self.task(self.tid)["session_id"].startswith("copilot:"))

    # ---- the session's tools
    def test_tools_keep_the_task_current(self):
        self.open()
        srv = mcp_server.build(self.core, "session", self.tid)
        self.assertEqual(srv.name, "fuzz-session")
        self.assertEqual(tools.session_get_task(self.core, self.tid)["id"], self.tid)
        tools.session_log(self.core, self.tid, "Picked option B for the headline.")
        tools.session_next_step(self.core, self.tid, "Send the copy to Nadia")
        t = self.task(self.tid)
        self.assertEqual(t["next_step"], "Send the copy to Nadia")
        log = [x["text"] for x in tasks.events.task_log(self.core, self.tid)]
        self.assertEqual(log[:2], ["Next: Send the copy to Nadia", "Picked option B for the headline."])
        self.assertEqual(tools.session_get_task(self.core, self.tid)["next_step"], "Send the copy to Nadia")
        with self.assertRaises(FuzzError):
            mcp_server.build(self.core, "session")

    def test_end_done(self):
        self.open()
        self.assertEqual(tools.session_end(self.core, self.tid, "done", "Wrote and sent it.")["state"], "done")
        self.assertEqual(self.task(self.tid)["summary"], "Wrote and sent it.")
        with self.assertRaises(FuzzError) as e:
            tools.session_log(self.core, self.tid, "more")
        self.assertIn("isn't open", str(e.exception))

    def test_end_pause_comes_back_tomorrow_with_the_next_step(self):
        self.open()
        out = tools.session_end(self.core, self.tid, "pause", "Drafted two options.", next_step="Pick one")
        t = self.task(self.tid)
        self.assertEqual((out["state"], t["next_step"]), ("scheduled", "Pick one"))
        self.assertEqual(t["schedule_fire_at"], "2026-10-21T09:00:00Z")
        self.clock.advance(days=1, hours=1)
        scheduler.tick(self.core)
        self.assertEqual(self.task(self.tid)["state"], "triage")

    def test_end_pause_at_a_time_fuzz_and_waiting(self):
        self.open()
        tools.session_end(self.core, self.tid, "pause", "Halfway.", come_back_at="2026-10-20T15:00:00-04:00")
        self.assertEqual(self.task(self.tid)["schedule_fire_at"], "2026-10-20T19:00:00Z")
        for bad in (dict(outcome="pause", come_back_at="soon"), dict(outcome="later"),
                    dict(outcome="waiting"), dict(outcome="done", summary="")):
            other = tasks.capture(self.core, "Another")
            tasks.session(self.core, other)
            with self.assertRaises(FuzzError):
                tools.session_end(self.core, other, **dict(dict(summary="x"), **bad))
        tid2 = tasks.capture(self.core, "Book the room")
        tasks.session(self.core, tid2)
        with self.assertRaises(FuzzError):
            tools.session_end(self.core, tid2, "fuzz", "Looked at rooms.")
        self.assertEqual(tools.session_end(self.core, tid2, "fuzz", "Looked.", next_step="Book room 4")["state"],
                         "queued")
        self.assertIn("Book room 4", self.task(tid2)["notes"])
        tid3 = tasks.capture(self.core, "Get the estimate")
        tasks.session(self.core, tid3)
        tools.session_end(self.core, tid3, "waiting", "Asked Elena.", waiting_on="Elena")
        self.assertEqual((self.task(tid3)["state"], self.task(tid3)["waiting_on"]), ("waiting", "Elena"))

    # ---- sessions that end without saying how
    def test_closing_the_window_brings_it_back(self):
        self.open()
        tools.session_next_step(self.core, self.tid, "Pick a headline")
        old = self.task(self.tid)["session_launch"]
        self.open()   # a second window on it: the first one closing changes nothing
        self.assertFalse(sessions.closed(self.core, self.tid, old)["came_back"])
        cli.main(["--home", self.home, "session-closed", "--task", str(self.tid),
                  "--launch", self.task(self.tid)["session_launch"]])
        t = self.task(self.tid)
        self.assertEqual(t["state"], "triage")
        self.assertIn("without saying where this got to. Next step: Pick a headline", t["reason"])

    def test_closing_after_end_session_changes_nothing(self):
        self.open()
        launch = self.task(self.tid)["session_launch"]
        tools.session_end(self.core, self.tid, "done", "Done.")
        self.assertFalse(sessions.closed(self.core, self.tid, launch)["came_back"])
        self.assertEqual(self.task(self.tid)["state"], "done")

    def test_a_quiet_session_comes_back(self):
        self.open()
        self.clock.advance(hours=20)
        tools.session_log(self.core, self.tid, "Still at it.")
        self.clock.advance(hours=20)
        self.assertEqual(scheduler.tick(self.core)["quiet_sessions"], 0, "it spoke 20 hours ago")
        self.clock.advance(hours=5)
        self.assertEqual(scheduler.tick(self.core)["quiet_sessions"], 1)
        self.assertIn("no word on how it's going", self.task(self.tid)["reason"])

    def test_every_adapter_builds_a_session(self):
        for name, a in adapters.ADAPTERS.items():
            argv = a.session_command("/bin/x", "hi", ["/tmp/a"], mcp_config="/tmp/c.json", session_id="s1")
            self.assertEqual(argv[0], "/bin/x")
            self.assertIn("s1", argv)
            self.assertTrue(any("/tmp/c.json" in x for x in argv), name)


if __name__ == "__main__":
    unittest.main()
