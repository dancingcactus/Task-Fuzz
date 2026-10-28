"""The HTTP API and event stream, and two users who never see each other's work."""

import json
import threading
import time
import unittest
import urllib.error
import urllib.request

from helpers import CoreCase

from fuzz import http_api, mcp_server, tasks, tools


class Server(CoreCase):
    def setUp(self):
        super().setUp()
        self.srv = http_api.make_server(self.home, port=0, clock=self.clock, ticker=False)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.token = http_api.ensure_token(self.home, 1)

    def req(self, method, path, body=None, token=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        if token is not False:
            r.add_header("Authorization", f"Bearer {token or self.token}")
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                text = resp.read()
                return resp.status, (text if raw else json.loads(text))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())


class Api(Server):
    def test_token_required(self):
        self.assertEqual(self.req("GET", "/cards", token=False)[0], 401)
        self.assertEqual(self.req("GET", "/cards", token="wrong")[0], 401)
        self.assertEqual(self.req("GET", "/health", token=False), (200, {"ok": True}))

    def test_serves_the_ui(self):
        status, body = self.req("GET", "/", token=False, raw=True)
        self.assertEqual(status, 200)
        self.assertIn(b"<html", body.lower())
        self.assertEqual(self.req("GET", "/js/store.js", token=False, raw=True)[0], 200)
        self.assertEqual(self.req("GET", "/artifact.html", token=False, raw=True)[0], 200)
        self.assertEqual(self.req("GET", "/../README.md", token=False)[0], 404)
        self.assertEqual(self.req("GET", "/core/fuzz/db.py", token=False)[0], 404)

    def test_capture_assign_run_approve_undo(self):
        status, body = self.req("POST", "/tasks", {"text": "Do the corporate compliance video"})
        self.assertEqual(status, 201)
        tid = body["task_id"]
        cards = self.req("GET", "/cards")[1]["cards"]
        self.assertEqual([(c["kind"], c["task"]["id"]) for c in cards], [("task", tid)])
        self.assertEqual(self.req("POST", f"/cards/{cards[0]['id']}/answer", {"option": "assign"})[0], 200)
        from fuzz import runner   # a separate process in real use (Run now); here its own Core
        runner.run_role(self.core, "executor", scripted_=True, say=lambda s: None)
        cards = self.req("GET", "/cards")[1]["cards"]
        draft = next(c for c in cards if c["kind"] == "draft")
        self.assertIn("Draft for", draft["draft"]["body"])
        self.assertEqual(self.req("POST", f"/cards/{draft['id']}/answer", {"option": "approve"})[1]["option"], "approve")
        self.assertEqual(self.req("GET", f"/tasks/{tid}")[1]["state"], "done")
        status, again = self.req("POST", f"/cards/{draft['id']}/answer", {"option": "approve"})
        self.assertEqual((status, again["field"]), (409, "card_id"))
        self.req("POST", "/undo", {})
        full = self.req("GET", f"/tasks/{tid}")[1]
        self.assertEqual(full["state"], "review")
        self.assertTrue(full["log"] and full["drafts"] and full["cards"])

    def test_checkin_is_recorded_not_raised(self):
        self.req("POST", "/tasks", {"text": "One"})
        status, body = self.req("POST", "/checkin", {"answer": "tired"})
        self.assertEqual((status, body["moment"]), (201, "low"))
        self.assertEqual(self.req("GET", "/cards")[1]["moment"], "low")
        self.assertEqual({c["kind"] for c in self.req("GET", "/cards")[1]["cards"]}, {"task"})
        status, body = self.req("POST", "/checkin", {"answer": "meh"})
        self.assertEqual((status, body["field"]), (400, "answer"))

    def test_undo_list_says_what_is_blocked(self):
        tid = self.req("POST", "/tasks", {"text": "One"})[1]["task_id"]
        self.req("POST", f"/tasks/{tid}/park")
        self.req("POST", f"/tasks/{tid}/done")
        recent = self.req("GET", "/undo")[1]["recent"]
        park = next(r for r in recent if r["type"] == "task.parked")
        self.assertIn("Undo that first", park["blocked"])
        status, body = self.req("POST", "/undo", {"group": park["group"]})
        self.assertEqual((status, body["field"]), (409, "group"))

    def test_the_sender_is_started_when_a_draft_is_approved(self):
        from unittest import mock
        app = self.srv.app
        core = app.core(1)
        self.assertFalse(http_api.kick_sender(app, core, now=1000))
        tid = tasks.capture(core, "Reply to Elena")
        tasks.assign(core, tid)
        from fuzz import drafts, scheduler
        scheduler.claim_next(core, tid)
        drafts.save_draft(core, tid, "email.new", "Elena", "Hi")
        card = self.req("GET", "/cards")[1]["cards"][0]
        self.req("POST", f"/cards/{card['id']}/answer", {"option": "approve"})
        cfg = core.config
        cfg["engine"]["client"] = "claude-code"
        core.save_config(cfg)
        with mock.patch("fuzz.engine.run_now") as run:
            self.assertTrue(http_api.kick_sender(app, core, now=1000))
            self.assertFalse(http_api.kick_sender(app, core, now=1060), "not again within two minutes")
            self.assertTrue(http_api.kick_sender(app, core, now=1200))
        self.assertEqual([c.args[1] for c in run.call_args_list], ["sender", "sender"])

    def test_a_capture_starts_the_executor_to_gather(self):
        from unittest import mock
        app, core = self.srv.app, self.srv.app.core(1)
        self.assertEqual(self.req("POST", "/tasks", {"text": "Book the room"})[1]["gathering"], False)
        cfg = core.config
        cfg["engine"]["client"] = "claude-code"
        core.save_config(cfg)
        with mock.patch("fuzz.engine.run_now") as run:
            status, body = self.req("POST", "/tasks", {"text": "Prepare for my 1:1"})
            self.assertEqual((status, body["gathering"]), (201, True))
            self.assertEqual(self.task(body["task_id"], core)["state"], "queued")
            self.assertFalse(http_api.kick_executor(app, core), "not twice in a row")
            from fuzz import runs
            runs.start(core, "executor", "claude-code")
            self.assertFalse(http_api.kick_executor(app, core, now=time.time() + 600), "a run is already going")
        self.assertEqual([c.args[1] for c in run.call_args_list], ["executor"])

    def test_setup_over_http(self):
        import os, tempfile
        out = os.path.join(tempfile.mkdtemp(), "Fuzz")
        status, st = self.req("GET", "/setup?check=0")
        self.assertEqual((status, st["done"], st["folder"]["path"]), (200, False, None))
        self.assertEqual(self.req("PUT", "/setup/folder", {"folder": out})[1], {"path": out})
        status, v = self.req("PUT", "/setup/tools", {"client": "copilot", "read": ["workiq(fetch)"]})
        self.assertEqual((status, v["read"]), (200, ["workiq(fetch)"]))
        self.assertEqual(self.req("PUT", "/setup/tools", {"client": "nope"})[0], 400)
        self.assertEqual(self.req("POST", "/setup/done", {})[1], {"done": True})
        core = self.srv.app.core(1)
        tid = tasks.capture(core, "Make a checklist")
        tasks.assign(core, tid)
        from fuzz import outputs, scheduler
        scheduler.claim_next(core, tid)
        d = tools.get_task(core, tid)["output_dir"]
        with open(os.path.join(d, "list.md"), "w") as f:
            f.write("- [ ] One")
        outputs.record(core, tid)
        sid = outputs.listing(core, tid)[0]["source_id"]
        self.assertEqual(self.req("GET", f"/files/{sid}", raw=True), (200, b"- [ ] One"))
        self.assertEqual(self.req("GET", f"/files/{sid}", token=False)[0], 401)
        self.assertEqual(self.req("GET", "/files/999")[0], 404)

        with open(os.path.join(d, "page.html"), "w") as f:
            f.write("<script>alert(1)</script>")
        outputs.record(core, tid)
        status, body = self.req("GET", "/artifacts")
        self.assertEqual((status, body["folder"]), (200, out))
        self.assertEqual(sorted((a["name"], a["kind"]) for a in body["artifacts"]), [("list.md", "markdown"),
                                                                                       ("page.html", "html")])
        self.assertEqual(body["artifacts"][0]["task"], {"id": tid, "title": "Make a checklist", "state": "working"})
        status, a = self.req("GET", f"/artifacts/{sid}")
        self.assertEqual((status, a["name"], a["source_id"]), (200, "list.md", sid))
        self.assertEqual(self.req("GET", "/artifacts/999")[0], 404)
        hid = [x for x in body["artifacts"] if x["name"] == "page.html"][0]["source_id"]
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}/files/{hid}?token={self.token}")
        with urllib.request.urlopen(r, timeout=10) as resp:
            self.assertEqual(resp.headers["Content-Security-Policy"], "sandbox", "an HTML output can't reach the token")
            self.assertEqual(resp.headers["X-Content-Type-Options"], "nosniff")
        os.remove(os.path.join(d, "page.html"))
        outputs.record(core, tid)
        self.assertEqual([a["name"] for a in self.req("GET", "/artifacts")[1]["artifacts"]], ["list.md"],
                         "a file that's gone leaves the tab")

    def test_settings_edit_who_you_are(self):
        self.assertEqual(self.req("GET", "/me")[1]["emails"], ["jgrover@adobe.com"])
        status, body = self.req("PUT", "/me", {"emails": ["jgrover@adobe.com", "Justin@Home.example"]})
        self.assertEqual((status, body["emails"], body["names"]), (200, ["jgrover@adobe.com", "justin@home.example"],
                                                                   ["Justin"]))
        self.assertEqual(self.req("PUT", "/me", {"emails": []})[1]["field"], "emails")
        self.assertEqual(self.req("PUT", "/me", {"phones": ["1"]})[1]["field"], "phones")

    def test_errors_name_the_field(self):
        status, body = self.req("POST", "/tasks", {})
        self.assertEqual((status, body["field"]), (400, "text"))
        status, body = self.req("GET", "/tasks?state=nope")
        self.assertEqual((status, body["field"]), (400, "state"))
        self.assertEqual(self.req("GET", "/tasks/999")[0], 404)

    def test_events_since_and_stream(self):
        self.req("POST", "/tasks", {"text": "One"})
        evs = self.req("GET", "/events?after=0")[1]["events"]
        self.assertEqual([e["type"] for e in evs], ["task.captured", "card.created"])
        self.assertNotIn("payload", evs[0], "the UI gets facts, not field bookkeeping")
        url = f"http://127.0.0.1:{self.port}/events/stream?token={self.token}&once=1&after={evs[0]['id']}"
        with urllib.request.urlopen(url, timeout=10) as resp:
            text = resp.read().decode()
        self.assertIn("event: card.created", text)
        self.assertIn(f"id: {evs[1]['id']}", text)

    def test_tasks_by_state_and_actions(self):
        tid = self.req("POST", "/tasks", {"text": "Reply to Dana"})[1]["task_id"]
        self.assertEqual(self.req("POST", f"/tasks/{tid}/park", {})[1]["state"], "parked")
        self.assertEqual([t["id"] for t in self.req("GET", "/tasks?state=parked")[1]["tasks"]], [tid])
        self.assertEqual(self.req("POST", f"/tasks/{tid}/reopen", {"where": "front"})[1]["state"], "triage")

    def test_engine_status(self):
        st = self.req("GET", "/engine")[1]
        self.assertEqual({c["client"] for c in st["clients"]}, {"claude-code", "copilot"})
        status, body = self.req("PUT", "/engine", {"client": "copilot"})
        self.assertEqual((status, body["field"]), (409, "client"), "only Ready clients can be picked")


class Isolation(Server):
    """Two users: nothing leaks through HTTP, MCP or the library."""

    def test_two_users(self):
        other = self.make_core(2)
        tok2 = http_api.ensure_token(self.home, 2)
        mine = self.req("POST", "/tasks", {"text": "Justin's task"})[1]["task_id"]
        theirs = self.req("POST", "/tasks", {"text": "Dana's task"}, token=tok2)[1]["task_id"]

        self.assertEqual([t["id"] for t in self.req("GET", "/tasks")[1]["tasks"]], [mine])
        self.assertEqual([t["id"] for t in self.req("GET", "/tasks", token=tok2)[1]["tasks"]], [theirs])
        self.assertEqual(self.req("GET", f"/tasks/{theirs}")[0], 404)
        their_card = self.req("GET", "/cards", token=tok2)[1]["cards"][0]["id"]
        self.assertEqual(self.req("POST", f"/cards/{their_card}/answer", {"option": "done"})[0], 404)
        self.assertTrue(all(e["task_id"] != theirs for e in self.req("GET", "/events")[1]["events"]))

        tasks.assign(other, theirs)
        self.assertIsNone(tools.claim_next_task(self.core)["task"], "user 1's executor can't claim user 2's task")
        self.assertEqual(tools.claim_next_task(other)["task"]["id"], theirs)
        self.assertEqual(tools.whoami(other, "executor")["user_id"], 2)
        mcp_server.build(other, "executor")   # a server is built for one user's Core

        tools.submit_signals(self.core, [{"source": "email", "source_id": "same-id", "ts": "2026-10-20T08:00:00Z",
                                          "quote": "x", "candidates": [{"ask": "Approve the budget"}]}])
        out = tools.submit_signals(other, [{"source": "email", "source_id": "same-id", "ts": "2026-10-20T08:00:00Z",
                                            "quote": "x", "candidates": [{"ask": "Approve the budget"}]}])
        self.assertEqual(out["signals"], 1, "the same message for another user is a new signal")
        self.assertEqual(len(tasks.list_tasks(other)), 2)
        self.assertEqual(len(tasks.list_tasks(self.core)), 2)


if __name__ == "__main__":
    unittest.main()
