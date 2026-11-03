"""Catching duplicates: a task you capture, two asks in one run, and a ticket or document two tasks share."""

import unittest

from helpers import CoreCase
from test_http import Server

from fuzz import answers, cards, events, scheduler, tasks, tools
from fuzz.matching import dupes, entities

TICKET = "https://jira.example.com/browse/PLAT-302241"
GUIDE = "https://wiki.example.com/spaces/EXO/pages/4104299860/Testing-Setup-Guide"
WIKI = {"name": "Team Wiki", "email": "wiki@example.com"}


def slack(n, ask, links=(), who=None):
    return {"source": "slack", "source_id": f"C1:{n}", "anchor": f"slack:C1:{n}", "ts": f"2026-10-20T08:0{n}:00Z",
            "from": who or {"name": "Sanjeev P", "slack_id": "U0SANJ"}, "quote": ask, "links": list(links),
            "candidates": [{"ask": ask, "owner": "me", "links": list(links)}]}


def email(n, asks, links=(), conv=None):
    return {"source": "email", "source_id": f"m{n}", "anchor": f"email:{conv or 'T' + str(n)}",
            "ts": f"2026-10-20T08:{n:02d}:00Z", "from": WIKI, "title": "Goal Service design", "quote": asks[0],
            "links": list(links), "candidates": [{"ask": a, "owner": "me"} for a in asks]}


class Dupes(CoreCase):
    def send(self, *sigs, verdict="new"):
        tools.submit_signals(self.core, list(sigs))
        items = tools.get_pending_judgments(self.core)["items"]
        if items:
            tools.submit_verdicts(self.core, [{"candidate_id": i["candidate_id"], "verdict": verdict, "confidence": 0.6}
                                              for i in items])

    def tid(self, words):
        rows = [t for t in tasks.list_tasks(self.core) if words.lower() in t["title"].lower()]
        self.assertEqual(len(rows), 1, [t["title"] for t in tasks.list_tasks(self.core)])
        return rows[0]["id"]

    def kinds(self, tid):
        return [c["kind"] for c in cards.open_cards(self.core, tid)]

    # ---- a task you capture
    def test_a_captured_task_and_the_same_ask_from_slack_share_a_ticket(self):
        self.send(slack(1, "Find the thread explaining how to test the plugin", [TICKET, GUIDE]))
        old = self.tid("thread explaining")
        new = tasks.capture(self.core, "Set up the plugin from PLAT-302241")
        self.assertEqual(self.kinds(new), ["duplicate"])   # the question first; the routing card waits
        c = self.card_for(new, "duplicate")
        self.assertEqual(c["other_id"], old)
        self.assertIn("PLAT-302241", c["reason"])
        answers.answer(self.core, c["id"], "keep_separate")
        self.assertEqual(self.kinds(new), ["task"])
        self.assertIsNone(dupes.check_captured(self.core, new))   # you said they differ: not asked again

    def test_merging_it_moves_the_capture_into_the_older_task(self):
        self.send(slack(1, "Find the thread explaining how to test the plugin", [TICKET]))
        old = self.tid("thread explaining")
        new = tasks.capture(self.core, "Check PLAT-302241 test setup")
        answers.answer(self.core, self.card_for(new, "duplicate")["id"], "merge")
        self.assertEqual((self.task(new)["state"], self.task(new)["merged_into"]), ("merged", old))
        events.undo(self.core)
        self.assertEqual(self.task(new)["state"], "triage")

    def test_with_gathering_it_is_matched_once_fuzz_has_looked(self):
        self.send(slack(1, "Find the thread explaining how to test the plugin", [GUIDE]))
        old = self.tid("thread explaining")
        new = tasks.capture(self.core, "Find setup instructions for testing the plugin", gather=True)
        self.assertEqual(self.kinds(new), [])   # with Fuzz, nothing to ask yet
        tasks.add_link(self.core, new, None, GUIDE)   # what Fuzz found
        scheduler.finish_gathering(self.core, new, actor="system")
        self.assertEqual(self.card_for(new, "duplicate")["other_id"], old)

    def test_a_result_found_while_gathering_is_matched_too(self):
        self.send(slack(1, "Find the thread explaining how to test the plugin", [GUIDE]))
        new = tasks.capture(self.core, "Summarize the plugin test setup", gather=True)
        tasks.add_link(self.core, new, None, GUIDE)
        tasks.update_brief(self.core, new, context_md="The guide says…")
        scheduler.finish_gathering(self.core, new, actor="system", result=True)
        self.assertEqual(self.kinds(new), ["duplicate"])
        answers.answer(self.core, self.card_for(new)["id"], "keep_separate")
        self.assertEqual(self.card_for(new, "task")["suggested"], "done")   # still the result, asking if it's done

    def test_an_unrelated_capture_is_left_alone(self):
        self.send(slack(1, "Find the thread explaining how to test the plugin", [TICKET]))
        new = tasks.capture(self.core, "Book the dentist")
        self.assertEqual(self.kinds(new), ["task"])

    def test_a_link_on_many_tasks_doesnt_count(self):
        home = "https://wiki.example.com/spaces/EXO/overview"
        for n, ask in enumerate(["Order lunch", "Print badges", "Call the venue", "Send the agenda"], 1):
            self.send(slack(n, ask, [home]))
        new = tasks.capture(self.core, "Plan the retro")
        tasks.add_link(self.core, new, None, home, actor="human")
        self.assertIsNone(dupes.check_captured(self.core, new))
        self.assertEqual(self.kinds(new), ["task"])

    def test_a_later_signal_can_find_a_captured_task(self):
        new = tasks.capture(self.core, "Review the rollout plan in PLAT-302241")
        out = tools.submit_signals(self.core, [slack(1, "Can you look at PLAT-302241 before Thursday?", [TICKET])])
        merged = out["outcomes"].get("merged")
        pending = tools.get_pending_judgments(self.core)["items"]
        self.assertTrue(merged or any(s["task_id"] == new for p in pending for s in p["shortlist"]), out)

    def test_fuzz_capturing_a_task_is_not_checked(self):
        self.send(slack(1, "Find the thread explaining how to test the plugin", [TICKET]))
        new = tasks.capture(self.core, "Check PLAT-302241", actor="fuzz:onboarding")
        self.assertNotIn("duplicate", self.kinds(new))

    # ---- two asks in one run
    def _pend(self):
        """An open task from the same sender, so the asks below go to the judge instead of straight to new."""
        self.send(email(1, ["Decide which goals the Target activities track"]))

    def test_two_asks_in_one_run_about_the_same_page(self):
        self._pend()
        page = "https://wiki.example.com/pages/viewpage.action?pageId=4106173941"
        tools.submit_signals(self.core, [email(2, ["Confirm whether activities may link to one goal or many goals"], [page]),
                                         email(3, ["Confirm whether activities may link to one goal or many goals"], [page])])
        items = tools.get_pending_judgments(self.core)["items"]
        self.assertEqual(len(items), 2)
        tools.submit_verdicts(self.core, [{"candidate_id": i["candidate_id"], "verdict": "new", "confidence": 0.6}
                                          for i in items])
        rows = [t for t in tasks.list_tasks(self.core) if "one goal or many" in t["title"]]
        first, second = sorted(t["id"] for t in rows)
        self.assertEqual(self.card_for(second, "duplicate")["other_id"], first)
        self.assertIn("same run", self.card_for(second, "duplicate")["reason"])
        self.assertNotIn("duplicate", self.kinds(first))

    def test_asks_from_the_same_message_never_match(self):
        self._pend()
        tools.submit_signals(self.core, [email(2, ["Confirm the goals for activities", "Confirm the goals for activities too"],
                                               [GUIDE])])
        items = tools.get_pending_judgments(self.core)["items"]
        tools.submit_verdicts(self.core, [{"candidate_id": i["candidate_id"], "verdict": "new", "confidence": 0.6}
                                          for i in items])
        for t in tasks.list_tasks(self.core):
            self.assertNotIn("duplicate", self.kinds(t["id"]))

    def test_a_wiki_page_by_id_is_its_own_document(self):
        a = entities.normalize_url("https://wiki.example.com/pages/viewpage.action?pageId=1")
        b = entities.normalize_url("https://wiki.example.com/pages/viewpage.action?pageId=2")
        self.assertNotEqual(a, b)
        self.assertIsNone(dupes.ident("https://wiki.example.com/"))   # a site's home says nothing


class SameAs(Server):
    def test_same_as_offers_likely_tasks_and_merges_with_undo(self):
        tools.submit_signals(self.core, [slack(1, "Find the thread explaining how to test the plugin", [TICKET])])
        old = [t for t in tasks.list_tasks(self.core)][0]["id"]
        status, body = self.req("POST", "/tasks", {"text": "Find how to test the plugin"})
        new = body["task_id"]
        status, got = self.req("GET", f"/tasks/{new}/same_as")
        self.assertEqual(status, 200)
        self.assertEqual(got["choices"][0]["task_id"], old)
        status, out = self.req("POST", f"/tasks/{new}/same_as", {"other_id": old})
        self.assertEqual((status, out["into"]), (200, old))
        self.assertEqual(self.req("GET", f"/tasks/{new}")[1]["state"], "merged")
        self.assertEqual(self.req("POST", "/undo", {})[0], 200)
        self.assertEqual(self.req("GET", f"/tasks/{new}")[1]["state"], "triage")
        self.assertEqual(self.req("POST", f"/tasks/{new}/same_as", {})[0], 400)


if __name__ == "__main__":
    unittest.main()
