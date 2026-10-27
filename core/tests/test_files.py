"""Attachments: kept in a folder per task, handed to the executor as paths, readable only there."""

import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from helpers import CoreCase

from fuzz import adapters, cli, events, files, http_api, runner, tasks, tools
from fuzz.db import FuzzError, connect

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class Attach(CoreCase):
    def test_written_to_the_task_folder_and_recorded(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        f = files.attach(self.core, tid, "budget.pdf", PDF)
        self.assertEqual(f["path"], os.path.join(self.home, "files", "u1", f"t{tid}", "budget.pdf"))
        self.assertEqual(Path(f["path"]).read_bytes(), PDF)
        self.assertEqual((f["mime"], f["size"], f["role"]), ("application/pdf", len(PDF), "attachment"))
        self.assertEqual(events.task_log(self.core, tid, 1)[0]["text"], "You attached budget.pdf.")
        self.assertEqual(events.check_replay(self.core), [])

    def test_names_are_cleaned_and_clashes_numbered(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        self.assertEqual(files.attach(self.core, tid, "../../etc/passwd", b"x")["title"], "passwd")
        self.assertEqual(files.attach(self.core, tid, ".hidden.txt", b"x")["title"], "hidden.txt")
        self.assertEqual(files.attach(self.core, tid, "notes.txt", b"a")["title"], "notes.txt")
        self.assertEqual(files.attach(self.core, tid, "notes.txt", b"b")["title"], "notes (2).txt")
        for f in files.listing(self.core, tid):
            self.assertTrue(f["path"].startswith(files.task_dir(self.core, tid) + os.sep))

    def test_limits_name_the_field(self):
        cfg = self.core.config
        cfg["files"] = {"max_mb": 1, "max_per_task": 2}
        self.core.save_config(cfg)
        tid = tasks.capture(self.core, "Summarise the budget")
        with self.assertRaises(FuzzError) as e:
            files.attach(self.core, tid, "big.bin", b"x" * (1024 * 1024 + 1))
        self.assertEqual((e.exception.field, e.exception.status), ("body", 413))
        files.attach(self.core, tid, "a.txt", b"a")
        files.attach(self.core, tid, "b.txt", b"b")
        with self.assertRaises(FuzzError) as e:
            files.attach(self.core, tid, "c.txt", b"c")
        self.assertEqual(e.exception.field, "task_id")
        with self.assertRaises(FuzzError) as e:
            files.attach(self.core, tid, "", b"c")
        self.assertEqual(e.exception.field, "name")

    def test_detach_removes_the_file(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        f = files.attach(self.core, tid, "budget.pdf", PDF)
        files.detach(self.core, tid, f["id"])
        self.assertFalse(os.path.exists(f["path"]))
        self.assertEqual(files.listing(self.core, tid), [])

    def test_an_older_store_gets_the_new_columns(self):
        import sqlite3
        old = os.path.join(self.home, "old")
        os.makedirs(old)
        c = sqlite3.connect(os.path.join(old, "fuzz.db"))
        c.execute("CREATE TABLE sources (id INTEGER PRIMARY KEY, user_id INTEGER, task_id INTEGER, candidate_id INTEGER,"
                  " signal_key TEXT, role TEXT, title TEXT, added_run INTEGER, withdrawn INTEGER DEFAULT 0)")
        c.commit()
        c.close()
        conn = connect(old)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sources)")}
        self.assertLessEqual({"path", "mime", "size"}, cols)
        conn.close()


class Executor(CoreCase):
    def test_the_executor_gets_paths(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        pdf = files.attach(self.core, tid, "budget.pdf", PDF)
        files.attach(self.core, tid, "chart.png", PNG, "image/png")
        tasks.assign(self.core, tid)
        t = tools.claim_next_task(self.core)["task"]
        got = [s for s in t["sources"] if s.get("path")]
        self.assertEqual([(s["title"], s["mime"]) for s in got], [("budget.pdf", "application/pdf"),
                                                                  ("chart.png", "image/png")])
        self.assertEqual(Path(got[0]["path"]).read_bytes(), PDF)
        r = tools.read_source(self.core, pdf["id"])
        self.assertEqual(r["path"], pdf["path"])
        self.assertIn("your own file tools", r["note"])
        self.assertEqual(self.core.one("SELECT COUNT(*) n FROM events WHERE type='source.read'")["n"], 1)

    def test_only_the_lease_holder_gets_paths(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        f = files.attach(self.core, tid, "budget.pdf", PDF)
        with self.assertRaises(FuzzError):
            tools.read_source(self.core, f["id"])

    def test_scripted_run_opens_the_attachment(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        files.attach(self.core, tid, "budget.pdf", PDF)
        tasks.assign(self.core, tid)
        runner.run_role(self.core, "executor", scripted_=True, say=lambda s: None)
        texts = [x["text"] for x in events.task_log(self.core, tid)]
        self.assertIn(f"Opened budget.pdf ({len(PDF)} bytes).", texts)

    def test_merging_keeps_the_path(self):
        from fuzz import matching
        a = tasks.capture(self.core, "Summarise the budget")
        b = tasks.capture(self.core, "Budget summary for Elena")
        f = files.attach(self.core, a, "budget.pdf", PDF)
        matching.merge(self.core, a, b)
        self.assertEqual([x["path"] for x in files.listing(self.core, b)], [f["path"]])


class HeadlessRuns(CoreCase):
    def test_claude_code_may_read_only_the_files_folder(self):
        a = adapters.get("claude-code")
        folder = files.user_dir(self.core)
        argv = a.headless_command("executor", "/tmp/run.json", files_dir=folder)
        self.assertEqual(argv[argv.index("--tools") + 1], "Read", "Read is the only built-in tool")
        i = argv.index("--allowedTools")
        self.assertEqual(argv[i + 1:i + 3], ["mcp__fuzz-executor__*", f"Read(/{folder}/**)"])
        self.assertEqual(argv[argv.index("--add-dir") + 1], folder)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk", "anything else is refused")

    def test_copilot_adds_the_folder_and_still_denies_shell_and_write(self):
        argv = adapters.get("copilot").headless_command("executor", "/tmp/run.json", files_dir="/x/files/u1")
        self.assertEqual(argv[argv.index("--add-dir") + 1], "/x/files/u1")
        self.assertEqual([argv[i + 1] for i, x in enumerate(argv) if x == "--deny-tool"], ["shell", "write"])

    def test_the_sender_loads_your_connectors_but_may_call_only_the_send_tools(self):
        send = ["mcp__claude_ai_Slack__slack_send_message"]
        argv = adapters.get("claude-code").headless_command("sender", "/tmp/run.json", send_tools=send)
        self.assertNotIn("--strict-mcp-config", argv, "the sender sends with your own connectors")
        self.assertEqual(argv[argv.index("--tools") + 1], "", "no built-in tools")
        i = argv.index("--allowedTools")
        self.assertEqual(argv[i + 1:i + 3], ["mcp__fuzz-sender__*"] + send)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertNotIn("--add-dir", argv)
        ex = adapters.get("claude-code").headless_command("executor", "/tmp/run.json", send_tools=send)
        self.assertIn("--strict-mcp-config", ex)
        self.assertNotIn(send[0], ex, "only the sender gets send tools")
        cp = adapters.get("copilot").headless_command("sender", "/tmp/run.json", send_tools=["slack(send_message)"])
        self.assertEqual([cp[i + 1] for i, x in enumerate(cp) if x == "--allow-tool"], ["fuzz-sender", "slack(send_message)"])

    def test_the_executor_may_call_only_the_lookup_tools_you_listed(self):
        read = ["mcp__claude_ai_Glean__search"]
        argv = adapters.get("claude-code").headless_command("executor", "/tmp/run.json", read_tools=read)
        self.assertNotIn("--strict-mcp-config", argv, "it looks things up with your own connectors")
        i = argv.index("--allowedTools")
        self.assertEqual(argv[i + 1:i + 3], ["mcp__fuzz-executor__*"] + read)
        se = adapters.get("claude-code").headless_command("sender", "/tmp/run.json", read_tools=read)
        self.assertNotIn(read[0], se, "only the executor gets lookup tools")
        cp = adapters.get("copilot").headless_command("executor", "/tmp/run.json", read_tools=["Glean"])
        self.assertEqual([cp[i + 1] for i, x in enumerate(cp) if x == "--allow-tool"], ["fuzz-executor", "Glean"])
        self.assertEqual([cp[i + 1] for i, x in enumerate(cp) if x == "--deny-tool"], ["shell", "write"])

    def test_copilot_shows_the_model_only_the_tools_you_listed(self):
        def available(argv):
            i = argv.index("--available-tools")
            return argv[i + 1:argv.index("--add-dir")] if "--add-dir" in argv else argv[i + 1:]

        cp = adapters.get("copilot")
        ex = cp.headless_command("executor", "/tmp/run.json", files_dir="/x/files/u1",
                                 read_tools=["Glean", "Ember MCP(ask_ember)"])
        self.assertEqual(available(ex), ["fuzz-executor", "Glean", "Ember-MCP-ask_ember", "view"])
        self.assertEqual([ex[i + 1] for i, x in enumerate(ex) if x == "--allow-tool"],
                         ["fuzz-executor", "Glean", "Ember MCP(ask_ember)"], "--allow-tool keeps your spelling")
        self.assertEqual(available(cp.headless_command("executor", "/tmp/run.json")), ["fuzz-executor"])
        se = cp.headless_command("sender", "/tmp/run.json", send_tools=["slack(send_message)"], read_tools=["Glean"])
        self.assertEqual(available(se), ["fuzz-sender", "slack-send_message"], "no lookup tools, no files")
        self.assertNotIn("--available-tools", cp.headless_command("extractor", "/tmp/run.json"),
                         "the extractor reads your sources with your own connectors")

    def test_the_extractor_gets_no_files(self):
        argv = adapters.get("claude-code").headless_command("extractor", "/tmp/run.json")
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertNotIn("--add-dir", argv)


class Interfaces(CoreCase):
    def test_http_upload_list_and_remove_per_user(self):
        srv = http_api.make_server(self.home, port=0, clock=self.clock, ticker=False)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        port = srv.server_address[1]
        tok, tok2 = http_api.ensure_token(self.home, 1), http_api.ensure_token(self.home, 2)

        def req(method, path, data=None, token=tok, ctype=None):
            r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
            r.add_header("Authorization", f"Bearer {token}")
            if ctype:
                r.add_header("Content-Type", ctype)
            try:
                with urllib.request.urlopen(r, timeout=10) as resp:
                    return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        tid = tasks.capture(self.core, "Summarise the budget")
        status, body = req("POST", f"/tasks/{tid}/files?name=budget.pdf", PDF, ctype="application/pdf")
        self.assertEqual((status, body["name"], body["size"]), (201, "budget.pdf", len(PDF)))
        self.assertEqual(req("GET", f"/tasks/{tid}")[1]["files"][0]["name"], "budget.pdf")
        self.assertEqual(req("POST", f"/tasks/{tid}/files?name=x.pdf", PDF, token=tok2)[0], 404, "not your task")
        self.assertEqual(req("DELETE", f"/tasks/{tid}/files/{body['source_id']}", token=tok2)[0], 404)
        self.assertEqual(req("DELETE", f"/tasks/{tid}/files/{body['source_id']}")[0], 200)
        self.assertEqual(req("GET", f"/tasks/{tid}")[1]["files"], [])

    def test_cli_capture_with_files_and_attach(self):
        src = Path(self.home, "budget.pdf")
        src.write_bytes(PDF)
        os.environ["FUZZ_HOME"] = self.home
        self.addCleanup(os.environ.pop, "FUZZ_HOME", None)
        cli.main(["capture", "Summarise", "the", "budget", "--file", str(src)])
        tid = self.core.one("SELECT MAX(id) m FROM tasks")["m"]
        cli.main(["attach", str(tid), str(src)])
        self.assertEqual([f["name"] for f in files.listing(self.core, tid)], ["budget.pdf", "budget (2).pdf"])


if __name__ == "__main__":
    unittest.main()
