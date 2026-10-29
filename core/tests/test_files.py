"""Attachments: kept in a folder per task, handed to the executor as paths, readable only there."""

import io
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from helpers import CoreCase

from fuzz import adapters, cli, doctext, events, files, http_api, runner, tasks, tools
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

    def test_assign_points_fuzz_to_the_sources_you_picked(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        f = files.attach(self.core, tid, "budget.pdf", PDF)
        files.attach(self.core, tid, "notes.txt", b"x")
        # by id, and by name for a file the UI added before it knew the id
        tasks.assign(self.core, tid, "Just the totals", refs=[f["id"], "notes.txt"])
        t = tasks.require(self.core, tid)
        self.assertIn("You said: Just the totals\nRead these first: “budget.pdf”, “notes.txt”.", t["notes"])
        self.assertEqual(events.task_log(self.core, tid, 1)[0]["text"],
                         "You said: Just the totals\nRead these first: “budget.pdf”, “notes.txt”.")
        self.assertEqual(events.check_replay(self.core), [])

    def test_assign_refuses_a_source_from_another_task(self):
        tid, other = tasks.capture(self.core, "Summarise the budget"), tasks.capture(self.core, "Something else")
        theirs = files.attach(self.core, other, "budget.pdf", PDF)
        with self.assertRaises(FuzzError) as e:
            tasks.assign(self.core, tid, refs=[theirs["id"]])
        self.assertEqual(e.exception.field, "refs")

    def test_only_a_file_you_added_comes_off(self):
        tid = tasks.capture(self.core, "Summarise the budget")
        src = self.core.q("INSERT INTO sources (user_id, task_id, role, title) VALUES (1,?,?,?)", (tid, "origin", "Budget email")).lastrowid
        with self.assertRaises(FuzzError) as e:
            files.detach(self.core, tid, src)
        self.assertEqual(e.exception.status, 404)

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
        self.assertNotIn(read[0], se, "the sender gets no lookup tools")
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
                         ["fuzz-executor", "Glean", "Ember-MCP(ask_ember)"], "Copilot rejects a space in a rule")
        self.assertEqual(available(cp.headless_command("executor", "/tmp/run.json")), ["fuzz-executor"])
        se = cp.headless_command("sender", "/tmp/run.json", send_tools=["slack(send_message)"], read_tools=["Glean"])
        self.assertEqual(available(se), ["fuzz-sender", "slack-send_message"], "no lookup tools, no files")
        self.assertNotIn("--available-tools", cp.headless_command("extractor", "/tmp/run.json"),
                         "the extractor reads your sources with your own connectors")

    def test_the_extractor_may_call_the_lookup_tools_you_listed(self):
        cc = adapters.get("claude-code").headless_command("extractor", "/tmp/run.json",
                                                          read_tools=["mcp__fluffyjaws__slack_search"])
        i = cc.index("--allowedTools")
        self.assertEqual(cc[i + 1:i + 3], ["mcp__fuzz-extractor__*", "mcp__fluffyjaws__slack_search"])
        self.assertNotIn("--strict-mcp-config", cc, "it reads your sources with your own connectors")
        cp = adapters.get("copilot").headless_command("extractor", "/tmp/run.json",
                                                      read_tools=["fluffyjaws(slack_search)", "Glean"])
        self.assertEqual([cp[i + 1] for i, x in enumerate(cp) if x == "--allow-tool"],
                         ["fuzz-extractor", "fluffyjaws(slack_search)", "Glean"],
                         "nobody is there to approve a tool it wasn't allowed")
        self.assertNotIn("--available-tools", cp)

    def test_the_extractor_gets_no_files(self):
        argv = adapters.get("claude-code").headless_command("extractor", "/tmp/run.json")
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertNotIn("--add-dir", argv)

    def test_an_upload_fills_the_name_you_captured_with(self):
        tid = tasks.capture(self.core, "", docs=["budget.pdf", "notes.txt"], uploading=True)
        self.assertEqual(tasks.get(self.core, tid)["title"], "budget.pdf")
        self.assertEqual(files.waiting(self.core, tasks.get(self.core, tid)), 2)
        f = files.attach(self.core, tid, "budget.pdf", PDF)
        rows = self.core.all("SELECT id, title, path FROM sources WHERE task_id=? AND role='attachment' ORDER BY id", (tid,))
        self.assertEqual([(r["id"], r["title"], r["path"]) for r in rows],
                         [(f["id"], "budget.pdf", f["path"]), (rows[1]["id"], "notes.txt", None)], "one row each, not two")
        self.assertEqual(files.waiting(self.core, tasks.get(self.core, tid)), 1)

    def test_fuzz_waits_for_the_files_then_gives_up_on_them(self):
        from fuzz import scheduler
        named = tasks.capture(self.core, "Do the training", docs=["Training link.pdf"], gather=True)
        self.assertEqual(files.waiting(self.core, tasks.get(self.core, named)), 0, "a name alone isn't a file coming")
        tid = tasks.capture(self.core, "Summarise the budget", docs=["budget.pdf"], gather=True, uploading=True)
        self.assertEqual(scheduler.claim_next(self.core, tid)[0], None, "the file hasn't arrived")
        files.attach(self.core, tid, "budget.pdf", PDF)
        self.assertEqual(scheduler.claim_next(self.core, tid)[0]["id"], tid)
        late = tasks.capture(self.core, "Read the deck", docs=["deck.pptx"], gather=True, uploading=True)
        self.assertEqual(scheduler.claim_next(self.core, late)[0], None)
        self.clock.advance(seconds=files.WAIT_SECONDS + 1)
        self.assertEqual(files.waiting(self.core, tasks.get(self.core, late)), 0, "it never came")
        self.assertEqual(scheduler.claim_next(self.core, late)[0]["id"], late)


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

        # captured with a file: its source links to the viewer only once the file is in
        status, body = req("POST", "/tasks", json.dumps({"text": "Read the deck", "docs": ["deck.pptx"], "uploading": True}).encode(),
                           ctype="application/json")
        tid = body["task_id"]
        self.assertEqual([(s["title"], s["has_file"]) for s in req("GET", f"/tasks/{tid}")[1]["sources"]],
                         [("deck.pptx", 0)])
        req("POST", f"/tasks/{tid}/files?name=deck.pptx", b"PK", ctype="application/octet-stream")
        self.assertEqual([(s["title"], s["has_file"]) for s in req("GET", f"/tasks/{tid}")[1]["sources"]],
                         [("deck.pptx", 1)])

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


def _zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, xml in entries.items():
            z.writestr(name, xml)
    return buf.getvalue()


def _pdf(*pages):
    """A real PDF with a line of Helvetica text per page, offsets and all."""
    n = len(pages)
    objs = ["<</Type/Catalog/Pages 2 0 R>>",
            f"<</Type/Pages/Kids[{' '.join(f'{4 + 2 * i} 0 R' for i in range(n))}]/Count {n}>>",
            "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]
    for i, text in enumerate(pages):
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
        objs += [f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents {5 + 2 * i} 0 R>>",
                 f"<</Length {len(stream)}>>stream\n{stream}\nendstream"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj{o}endobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    return out + f"trailer<</Size {len(objs) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()


WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
ANS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
DOCX = _zip({"word/document.xml": f'<w:document {WNS}><w:body>'
             '<w:p><w:r><w:t>Budget </w:t></w:r><w:r><w:t>2027</w:t></w:r></w:p>'
             '<w:p><w:r><w:t>Travel</w:t><w:tab/><w:t>$4,000</w:t></w:r></w:p>'
             '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>In a table</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
             '</w:body></w:document>'})
PPTX = _zip({"ppt/slides/slide2.xml": f'<p:sld xmlns:p="x" {ANS}><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>',
             "ppt/slides/slide10.xml": f'<p:sld xmlns:p="x" {ANS}><a:p><a:r><a:t>Appendix</a:t></a:r></a:p></p:sld>',
             "ppt/slides/slide1.xml": f'<p:sld xmlns:p="x" {ANS}><a:p><a:r><a:t>Q3 review</a:t></a:r></a:p></p:sld>',
             "ppt/notesSlides/notesSlide1.xml": f'<p:notes xmlns:p="x" {ANS}><a:p><a:r><a:t>Open with the numbers</a:t></a:r></a:p>'
                                                '<a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>'})


class DocText(CoreCase):
    def test_reads_pdf_pages(self):
        p = self.tmp("budget.pdf", _pdf("Travel is 4000", "Signed off by Dana"))
        got = doctext.read(p, "application/pdf")
        self.assertEqual(got["format"], "pdf")
        self.assertEqual(got["text"], "[Page 1]\nTravel is 4000\n\n[Page 2]\nSigned off by Dana")
        self.assertFalse(got["truncated"])

    def test_reads_docx_paragraphs_tabs_and_tables(self):
        got = doctext.read(self.tmp("plan.docx", DOCX))
        self.assertEqual(got["text"], "Budget 2027\nTravel\t$4,000\nIn a table")

    def test_reads_pptx_slides_in_order_with_notes(self):
        got = doctext.read(self.tmp("deck.pptx", PPTX))
        self.assertEqual(got["text"], "[Slide 1]\nQ3 review\nNotes:\nOpen with the numbers\n\n"
                                      "[Slide 2]\nNext steps\n\n[Slide 10]\nAppendix")

    def test_long_text_is_cut_short(self):
        got = doctext.read(self.tmp("plan.docx", DOCX), max_chars=10)
        self.assertEqual((got["text"], got["truncated"]), ("Budget 202", True))

    def test_a_pdf_with_no_text_says_so(self):
        got = doctext.read(self.tmp("scan.pdf", _pdf("")))
        self.assertIn("scanned", got["note"])

    def test_a_broken_file_is_an_error_not_a_crash(self):
        got = doctext.read(self.tmp("plan.docx", b"not a zip"))
        self.assertEqual(got["format"], "docx")
        self.assertIn("couldn't read", got["error"])

    def test_other_files_are_left_alone(self):
        self.assertIsNone(doctext.read(self.tmp("chart.png", PNG), "image/png"))

    def test_the_executor_gets_the_text(self):
        tid = tasks.capture(self.core, "Summarise the deck")
        f = files.attach(self.core, tid, "deck.pptx", PPTX)
        bad = files.attach(self.core, tid, "plan.docx", b"not a zip")
        tasks.assign(self.core, tid)
        tools.claim_next_task(self.core)
        r = tools.read_source(self.core, f["id"])
        self.assertEqual((r["format"], r["path"]), ("pptx", f["path"]))
        self.assertTrue(r["text"].startswith("[Slide 1]\nQ3 review"))
        self.assertIn("Fuzz read its text", r["note"])
        r = tools.read_source(self.core, bad["id"])
        self.assertNotIn("text", r)
        self.assertIn("couldn't read this DOCX", r["note"])
        self.assertIn("your own file tools", r["note"])

    def tmp(self, name, data):
        p = os.path.join(self.home, name)
        Path(p).write_bytes(data)
        return p
