"""End-to-end checks over the fixtures, using the hash embedder and a scripted judge.

Run: python3 -m unittest discover spikes/task-matching/tests
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.join(HERE, "..", "skill")
sys.path.insert(0, os.path.join(SKILL, "scripts"))

import matcher  # noqa: E402
import render  # noqa: E402
import store  # noqa: E402
import tasks  # noqa: E402
import vectors  # noqa: E402


def fixture(name):
    with open(os.path.join(SKILL, "fixtures", name)) as f:
        return json.load(f)


# What a judge would say about each day-2 ask: ask keyword -> (target title keyword, verdict, confidence, new_ask, new_title)
JUDGE = {
    "Comment on the pricing deck": ("pricing", "same", 0.93, False, None),
    "Finish the pricing deck review": ("pricing", "same", 0.75, False, None),
    "travel request": ("PTO", "same", 0.80, True, None),
    "venue deposit": ("venue", "same", 0.90, False, "Book the November offsite venue (deposit due Friday)"),
}


def judge(pending):
    out = []
    for item in pending:
        for key, (want, verdict, conf, new_ask, new_title) in JUDGE.items():
            if key in item["ask"]:
                target = next(s["task_id"] for s in item["shortlist"] if want.lower() in s["title"].lower())
                out.append({"candidate_id": item["candidate_id"], "task_id": target, "verdict": verdict,
                            "confidence": conf, "new_ask": new_ask, "new_title": new_title, "reason": "test"})
    return out


class TwoDayRun(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        cfg = store.load_config(self.dir)
        cfg["me"] = {"emails": ["jgrover@adobe.com"], "slack_ids": ["W4R5SVCU9"], "names": ["Justin"]}
        cfg["embedder"] = "hash"
        store.save_config(self.dir, cfg)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def ctx(self, new_run):
        conn = store.connect(self.dir)
        self.addCleanup(conn.close)
        cfg = store.load_config(self.dir)
        emb = vectors.make_embedder(cfg)
        if new_run or store.current_run(conn) is None:
            conn.execute("INSERT INTO runs (started, matcher_version, embedder) VALUES (?,?,?)",
                         (store.now(), matcher.MATCHER_VERSION, emb.model))
            conn.commit()
        return matcher.Context(conn, cfg, emb, store.current_run(conn)["id"])

    def day(self, name, mark_done=None):
        c = self.ctx(True)
        if mark_done:
            report = os.path.join(self.dir, "report.md")
            with open(report) as f:
                text = f.read()
            text = text.replace(f"- [ ] **{mark_done}", f"- [x] **{mark_done}")
            render.sync(c.conn, text)
        counts = matcher.ingest(c, fixture(name))
        stats, pending = matcher.propose(c)
        applied = tasks.apply_verdicts(c, judge(pending))
        with open(os.path.join(self.dir, "report.md"), "w") as f:
            f.write(render.render(c.conn, c.run_id, "test"))
        return c, counts, stats, pending, applied

    def task_by_title(self, conn, words):
        rows = [r for r in conn.execute("SELECT * FROM tasks WHERE state!='merged'") if words.lower() in r["title"].lower()]
        self.assertEqual(len(rows), 1, f"expected one task matching {words!r}")
        return rows[0]

    def sources(self, conn, tid):
        return conn.execute("SELECT COUNT(*) n FROM task_sources WHERE task_id=? AND role!='ignored'", (tid,)).fetchone()["n"]

    def test_day1_two_asks_in_one_thread_stay_separate(self):
        c, *_ = self.day("day1.json")
        self.task_by_title(c.conn, "vendor contract")
        self.task_by_title(c.conn, "offsite")

    def test_day1_ask_for_someone_else_is_discarded_and_unclear_owner_flagged(self):
        c, *_ = self.day("day1.json")
        self.assertEqual(c.conn.execute("SELECT COUNT(*) n FROM tasks WHERE title LIKE '%dashboard%'").fetchone()["n"], 0)
        self.assertEqual(self.task_by_title(c.conn, "incident retro")["owner"], "unclear")

    def test_repeat_across_email_slack_meeting_and_forward(self):
        self.day("day1.json")
        c, counts, stats, pending, applied = self.day("day2.json", mark_done="Approve Sam's PTO")
        deck = self.task_by_title(c.conn, "Review the Q4 pricing deck")
        # email origin + Slack nudge (judge, high) + forward (anchor via Message-ID)
        self.assertEqual(self.sources(c.conn, deck["id"]), 3)
        fwd = c.conn.execute("SELECT stage, outcome FROM decisions d JOIN candidates c ON c.id=d.candidate_id "
                             "WHERE c.signal_key LIKE 'email:msg-d1%'").fetchone()
        self.assertEqual((fwd["stage"], fwd["outcome"]), ("anchor", "merged"))
        # meeting restatement at medium confidence becomes a possible duplicate, not a silent merge
        dup = self.task_by_title(c.conn, "Finish the pricing deck review")
        link = c.conn.execute("SELECT * FROM task_links WHERE a=?", (dup["id"],)).fetchone()
        self.assertEqual((link["b"], link["kind"]), (deck["id"], "possible_duplicate"))
        # Slack identity joined to the email identity by full name
        n = c.conn.execute("SELECT COUNT(*) n FROM entities WHERE type='person' AND name='Priya Shah'").fetchone()["n"]
        self.assertEqual(n, 1)

    def test_done_task_ignores_thanks_and_reopens_on_new_ask(self):
        self.day("day1.json")
        c, *_ = self.day("day2.json", mark_done="Approve Sam's PTO")
        thanks = c.conn.execute("SELECT outcome FROM decisions d JOIN candidates c ON c.id=d.candidate_id "
                                "WHERE c.signal_key LIKE 'email:msg-c2%'").fetchone()
        self.assertEqual(thanks["outcome"], "ignored")
        pto = self.task_by_title(c.conn, "PTO")
        self.assertEqual(pto["state"], "open")
        self.assertIn("asked something new", pto["reopened_reason"])

    def test_thread_with_two_tasks_goes_to_judge_and_retitles(self):
        self.day("day1.json")
        c, *_ = self.day("day2.json", mark_done="Approve Sam's PTO")
        venue = self.task_by_title(c.conn, "offsite venue")
        self.assertEqual(venue["title"], "Book the November offsite venue (deposit due Friday)")
        self.assertEqual(venue["due"], "2026-10-17")
        self.assertIn("Book a venue for the November offsite", json.loads(venue["title_history"]))

    def test_ingest_is_idempotent(self):
        self.day("day1.json")
        c = self.ctx(True)
        before = c.conn.execute("SELECT COUNT(*) n FROM tasks").fetchone()["n"]
        counts = matcher.ingest(c, fixture("day1.json"))
        stats, pending = matcher.propose(c)
        self.assertEqual(counts["signals"], 0)
        self.assertEqual(counts["skipped"], 5)
        self.assertEqual(stats, {})
        self.assertEqual(c.conn.execute("SELECT COUNT(*) n FROM tasks").fetchone()["n"], before)

    def test_dropped_task_stays_suppressed(self):
        c, *_ = self.day("day1.json")
        contract = self.task_by_title(c.conn, "vendor contract")
        tasks.set_state(c.conn, contract["id"], "dropped")
        c.conn.commit()
        c = self.ctx(True)
        matcher.ingest(c, [{
            "source": "email", "source_id": "msg-b9", "anchor": "email:conv-B", "ts": "2000-01-01T00:00:00Z",
            "from": {"name": "Marco Diaz", "email": "marco@acme.example"}, "quote": "Did the contract go to legal?",
            "candidates": [{"ask": "Send the vendor contract to legal", "owner": "me"}]}])
        stats, pending = matcher.propose(c)
        item = pending[0]
        tasks.apply_verdicts(c, [{"candidate_id": item["candidate_id"], "task_id": contract["id"],
                                  "verdict": "same", "confidence": 0.95, "new_ask": True, "reason": "test"}])
        self.assertEqual(store.live_task(c.conn, contract["id"])["state"], "dropped")

    def test_merge_and_split_round_trip(self):
        self.day("day1.json")
        c, *_ = self.day("day2.json", mark_done="Approve Sam's PTO")
        deck = self.task_by_title(c.conn, "Review the Q4 pricing deck")
        dup = self.task_by_title(c.conn, "Finish the pricing deck review")
        before = self.sources(c.conn, deck["id"])
        mid = tasks.merge(c.conn, dup["id"], deck["id"])
        self.assertEqual(self.sources(c.conn, deck["id"]), before + 1)
        self.assertEqual(store.live_task(c.conn, dup["id"])["id"], deck["id"])  # redirect
        tasks.split(c.conn, mid)
        self.assertEqual(self.sources(c.conn, deck["id"]), before)
        self.assertEqual(store.live_task(c.conn, dup["id"])["state"], "open")
        fb = [r["kind"] for r in c.conn.execute("SELECT kind FROM feedback ORDER BY id")]
        self.assertEqual(fb, ["merge", "split"])

    def test_report_round_trips_through_sync(self):
        self.day("day1.json")
        c, *_ = self.day("day2.json", mark_done="Approve Sam's PTO")
        with open(os.path.join(self.dir, "report.md")) as f:
            text = f.read()
        # every open task has a line sync can find, including the possible duplicate
        open_ids = {r["id"] for r in c.conn.execute("SELECT id FROM tasks WHERE state IN ('open','scheduled')")}
        found = {int(m.group(3)) for m in map(render.LINE_RE.match, text.splitlines()) if m}
        self.assertEqual(open_ids, found)
        text = text.replace("- [ ] **Send the vendor contract to legal**", "- [-] **Send the vendor contract to legal** ⏰ 2026-11-01")
        text = text.replace("- [ ] **Write up the incident retro", "- [ ] **Write up the incident retro ⏰ 2026-10-30")
        changes = render.sync(c.conn, text)
        self.assertEqual(len(changes), 2)
        self.assertEqual(self.task_by_title(c.conn, "vendor contract")["state"], "dropped")
        self.assertEqual(self.task_by_title(c.conn, "incident retro")["scheduled_for"], "2026-10-30")
        self.assertEqual(render.sync(c.conn, text), [])  # idempotent


class Embedders(unittest.TestCase):
    def test_python_and_sqlite_vec_cosine_agree(self):
        d = tempfile.mkdtemp()
        try:
            conn = store.connect(d)
            self.addCleanup(conn.close)
            emb = vectors.HashEmbedder()
            a, b = emb.embed(["review the pricing deck", "pricing deck review comments"])
            vectors.put(conn, "candidate", 1, emb.model, b)
            py = vectors.similarities(conn, a, "candidate", [1], emb.model, use_sql=False)[1]
            if vectors.load_sqlite_vec(conn) is None:
                self.skipTest("sqlite-vec not installed")
            sql = vectors.similarities(conn, a, "candidate", [1], emb.model, use_sql=True)[1]
            self.assertAlmostEqual(py, sql, places=4)
            self.assertGreater(py, 0.3)
        finally:
            shutil.rmtree(d)

    def test_ollama_unavailable_degrades(self):
        d = tempfile.mkdtemp()
        try:
            conn = store.connect(d)
            self.addCleanup(conn.close)
            conn.execute("INSERT INTO runs (started) VALUES (?)", (store.now(),))
            emb = vectors.OllamaEmbedder("http://127.0.0.1:9", "nomic-embed-text")
            ctx = matcher.Context(conn, {"me": {}}, emb, 1)
            matcher.ingest(ctx, fixture("day1.json"))
            stats, _ = matcher.propose(ctx)
            self.assertFalse(ctx.embed_ok)
            self.assertEqual(stats.get("new"), 5)
            notes = json.loads(conn.execute("SELECT notes FROM runs WHERE id=1").fetchone()["notes"])
            self.assertTrue(any("Stage 3" in n for n in notes))
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
