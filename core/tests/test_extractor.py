"""The spike's two-day scenario, now through the extractor's tools: the same outcomes, as events and cards."""

import unittest

from helpers import CoreCase, fixture

from fuzz import answers, cards, events, tasks, tools
from fuzz.db import FuzzError

# What a judge says about each day-2 ask (the spike's table): ask keyword -> (target title keyword, verdict, conf, new_ask, new_title)
JUDGE = {
    "Comment on the pricing deck": ("pricing", "same", 0.93, False, None),
    "Finish the pricing deck review": ("pricing", "same", 0.75, False, None),
    "travel request": ("PTO", "same", 0.80, True, None),
    "venue deposit": ("venue", "same", 0.90, False, "Book the November offsite venue (deposit due Friday)"),
}


def judge(items):
    out = []
    for item in items:
        for key, (want, verdict, conf, new_ask, new_title) in JUDGE.items():
            if key in item["ask"]:
                target = next(s["task_id"] for s in item["shortlist"] if want.lower() in s["title"].lower())
                out.append({"candidate_id": item["candidate_id"], "task_id": target, "verdict": verdict,
                            "confidence": conf, "new_ask": new_ask, "new_title": new_title, "reason": "test"})
    return out


class TwoDays(CoreCase):
    def day(self, name):
        out = tools.submit_signals(self.core, fixture(name))
        items = tools.get_pending_judgments(self.core)["items"]
        if items:
            out["verdicts"] = tools.submit_verdicts(self.core, judge(items))
        return out

    def by_title(self, words):
        rows = [t for t in tasks.list_tasks(self.core) if words.lower() in t["title"].lower()]
        self.assertEqual(len(rows), 1, f"expected one task matching {words!r}: {[r['title'] for r in rows]}")
        return rows[0]

    def sources(self, tid):
        return self.core.one("SELECT COUNT(*) n FROM sources WHERE task_id=? AND role NOT IN ('ignored','link')",
                             (tid,))["n"]

    def test_the_docs_a_message_links_join_the_sources(self):
        self.day("day1.json")
        deck = self.by_title("Review the Q4 pricing deck")
        links = self.core.all("SELECT title, link FROM sources WHERE task_id=? AND role='link'", (deck["id"],))
        self.assertEqual([(s["title"], s["link"]) for s in links],
                         [("Google Slides", "https://docs.google.com/presentation/d/PRICINGDECK123/edit")])
        self.day("day2.json")
        self.assertEqual(len(self.core.all("SELECT id FROM sources WHERE task_id=? AND role='link'", (deck["id"],))),
                         1, "the same link from a later message is still one source")

    def test_a_link_is_named_from_its_address(self):
        for url, want in [
                ("https://wiki.corp.example.com/spaces/EXO/pages/4041045840/Experimentation+Knowledge+Base+-+Use+Cases+Queries",
                 "Experimentation Knowledge Base - Use Cases Queries"),
                ("https://acme.atlassian.net/browse/TAPER-8461", "TAPER-8461"),
                ("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef/edit", "Google Doc"),
                ("https://example.com/", "example.com")]:
            self.assertEqual(tasks.link_title(url), want)

    def test_day1(self):
        out = self.day("day1.json")
        self.assertEqual(out["signals"], 5)
        self.by_title("vendor contract")
        self.by_title("offsite")
        self.assertFalse([t for t in tasks.list_tasks(self.core) if "dashboard" in t["title"]], "someone else's ask")
        retro = self.by_title("incident retro")
        self.assertEqual(retro["owner"], "unclear")
        self.card_for(retro["id"], "is_task")
        for t in tasks.list_tasks(self.core):
            self.assertIn(t["id"], [c["task_id"] for c in self.open_cards()])

    def test_day2_merge_duplicate_card_and_reopen(self):
        self.day("day1.json")
        pto = self.by_title("PTO")
        answers.answer(self.core, self.card_for(pto["id"], "task")["id"], "done")
        out = self.day("day2.json")
        self.assertEqual(out["skipped"], 0)

        deck = self.by_title("Review the Q4 pricing deck")
        self.assertEqual(self.sources(deck["id"]), 3, "email origin + Slack nudge + forward")
        dup = self.by_title("Finish the pricing deck review")
        card = self.card_for(dup["id"])
        self.assertEqual((card["kind"], card["other_id"]), ("duplicate", deck["id"]), "a question before routing")
        self.assertIn("Same as", cards.view(self.core, card)["prompt"])

        pto = self.task(pto["id"])
        self.assertEqual(pto["state"], "triage")
        self.assertIn("reopened", pto["variant_tags"])
        self.assertIn("asked something new", pto["reason"])

        venue = self.by_title("offsite venue")
        self.assertEqual(venue["title"], "Book the November offsite venue (deposit due Friday)")
        self.assertEqual(venue["due"], "2026-10-17")

    def test_answering_the_duplicate_merges(self):
        self.day("day1.json")
        self.day("day2.json")
        deck = self.by_title("Review the Q4 pricing deck")
        dup = self.by_title("Finish the pricing deck review")
        before = self.sources(deck["id"])
        answers.answer(self.core, self.card_for(dup["id"], "duplicate")["id"], "merge")
        self.assertEqual(self.sources(deck["id"]), before + 1)
        self.assertEqual(tasks.live(self.core, dup["id"])["id"], deck["id"])

    def test_ingest_is_idempotent(self):
        self.day("day1.json")
        n = len(tasks.list_tasks(self.core))
        out = self.day("day1.json")
        self.assertEqual((out["signals"], out["skipped"]), (0, 5))
        self.assertEqual(len(tasks.list_tasks(self.core)), n)

    def test_let_go_stays_let_go(self):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        answers.answer(self.core, self.card_for(contract["id"], "task")["id"], "drop")
        tools.submit_signals(self.core, [{
            "source": "email", "source_id": "msg-b9", "anchor": "email:conv-B", "ts": "2000-01-01T00:00:00Z",
            "from": {"name": "Marco Diaz", "email": "marco@acme.example"}, "quote": "Did the contract go to legal?",
            "candidates": [{"ask": "Send the vendor contract to legal", "owner": "me"}]}])
        item = tools.get_pending_judgments(self.core)["items"][0]
        tools.submit_verdicts(self.core, [{"candidate_id": item["candidate_id"], "task_id": contract["id"],
                                           "verdict": "same", "confidence": 0.95, "new_ask": True, "reason": "t"}])
        self.assertEqual(self.task(contract["id"])["state"], "letgo")

    def theirs_then(self, owner, sid):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        tasks.theirs(self.core, contract["id"], on="Marco Diaz", card=self.card_for(contract["id"], "task"))
        tools.submit_signals(self.core, [{
            "source": "email", "source_id": sid, "anchor": "email:conv-B", "ts": "2026-10-20T09:30:00Z",
            "from": {"name": "Marco Diaz", "email": "marco@acme.example"}, "quote": "Can you sign off on the contract?",
            "candidates": [{"ask": "Sign off on the vendor contract", "owner": owner}]}])
        item = tools.get_pending_judgments(self.core)["items"][0]
        tools.submit_verdicts(self.core, [{"candidate_id": item["candidate_id"], "task_id": contract["id"],
                                           "verdict": "same", "confidence": 0.95, "new_ask": True, "reason": "t"}])
        return self.task(contract["id"])

    def test_someone_elses_task_comes_back_when_it_needs_you(self):
        t = self.theirs_then("me", "msg-b11")
        self.assertEqual((t["state"], t["owner"]), ("triage", "me"))
        self.assertNotIn("theirs", t["variant_tags"])
        self.assertIn("now Marco Diaz needs you", t["reason"])

    def test_someone_elses_task_stays_theirs_while_it_is(self):
        t = self.theirs_then("Marco Diaz", "msg-b12")
        self.assertEqual(t["state"], "letgo")
        self.assertIn("theirs", t["variant_tags"])
        self.assertEqual(self.sources(t["id"]), 2, "kept with it as context")

    def test_a_reply_from_the_person_you_wait_on_comes_back(self):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        answers.answer(self.core, self.card_for(contract["id"], "task")["id"], "wait", "Marco Diaz")
        tools.submit_signals(self.core, [{
            "source": "email", "source_id": "msg-b10", "anchor": "email:conv-B", "ts": "2026-10-20T08:30:00Z",
            "from": {"name": "Marco Diaz", "email": "marco@acme.example"}, "quote": "Signed copy attached.",
            "candidates": []}])
        t = self.task(contract["id"])
        self.assertEqual(t["state"], "triage")
        self.assertIn("Reply came in", t["reason"])
        self.assertEqual(self.open_cards()[0]["task_id"], contract["id"], "a reply comes in at the front")

    def test_parked_wakes_quietly_on_an_fyi(self):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        answers.answer(self.core, self.card_for(contract["id"], "task")["id"], "park")
        tools.submit_signals(self.core, [{
            "source": "email", "source_id": "msg-b11", "anchor": "email:conv-B", "ts": "2026-10-20T08:30:00Z",
            "from": {"name": "Marco Diaz", "email": "marco@acme.example"}, "quote": "FYI legal is out Friday.",
            "candidates": []}])
        t = self.task(contract["id"])
        self.assertEqual(t["state"], "parked")
        self.assertIn("woke", t["variant_tags"])
        self.assertFalse(self.open_cards() and [c for c in self.open_cards() if c["task_id"] == contract["id"]])

    def answer_in_thread(self, frm, sid="msg-b13", **extra):
        tools.submit_signals(self.core, [dict({
            "source": "email", "source_id": sid, "anchor": "email:conv-B", "ts": "2026-10-20T09:30:00Z",
            "from": frm, "quote": "Signed and sent back.", "answers": True, "candidates": []}, **extra)])

    def test_your_own_reply_that_answers_closes_the_task(self):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        self.answer_in_thread({"name": "Justin Grover"})   # Slack gives the full name; me.names has "Justin"
        t = self.task(contract["id"])
        self.assertEqual(t["state"], "done")
        self.assertFalse([c for c in self.open_cards() if c["task_id"] == contract["id"]])
        log = [x["text"] for x in events.task_log(self.core, contract["id"], 1)]
        self.assertIn("You answered in Email", log[0])

    def test_someone_elses_answer_does_not_close_it(self):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        self.answer_in_thread({"name": "Marco Diaz", "email": "marco@acme.example"})
        self.answer_in_thread({"name": "Justin Smith", "email": "jsmith@acme.example"}, sid="msg-b14")
        self.assertEqual(self.task(contract["id"])["state"], "triage")

    def test_your_answer_leaves_a_task_you_wait_on_open(self):
        self.day("day1.json")
        contract = self.by_title("vendor contract")
        answers.answer(self.core, self.card_for(contract["id"], "task")["id"], "wait", "Marco Diaz")
        self.answer_in_thread({"name": "Justin", "email": "jgrover@adobe.com"})
        self.assertEqual(self.task(contract["id"])["state"], "waiting")

    def test_an_answer_carries_no_asks(self):
        with self.assertRaises(FuzzError) as e:
            self.answer_in_thread({"name": "Justin"}, candidates=[{"ask": "Send the deck"}])
        self.assertEqual(e.exception.field, "signals[0].answers")

    def test_an_email_read_again_is_not_new(self):
        msg = {"source": "email", "source_id": "<m1@acme.example>", "version": "2026-10-20T08:00:00Z",
               "anchor": "email:conv-Q", "ts": "2026-10-20T08:00:00Z", "from": {"name": "Dana"},
               "quote": "Can you send the Q4 numbers?", "candidates": [{"ask": "Send Dana the Q4 numbers"}]}
        tools.submit_signals(self.core, [msg])
        out = tools.submit_signals(self.core, [dict(msg, version="2026-10-20T11:30:00Z")])   # opened, so modified
        self.assertEqual(out["skipped"], 1)
        t = self.by_title("Q4 numbers")
        self.assertEqual(self.sources(t["id"]), 1)

    def test_a_candidate_can_carry_a_brief(self):
        tools.submit_signals(self.core, [{
            "source": "email", "source_id": "hr-1", "anchor": "email:hr", "ts": "2026-10-20T08:00:00Z",
            "from": {"name": "HR"}, "quote": "Complete the annual compliance training by Oct 31.",
            "candidates": [{"ask": "Do the corporate compliance video", "due": "2026-10-31",
                            "context_md": "**Annual compliance**\n\n45 minutes. [Start](https://learn.example)",
                            "question": "When should I block time for it?", "effort_mins": 45}]}])
        t = self.by_title("compliance video")
        self.assertIn("45 minutes", t["context_md"])
        card = self.card_for(t["id"], "task")
        self.assertEqual(cards.view(self.core, card)["prompt"], "When should I block time for it?")


if __name__ == "__main__":
    unittest.main()
