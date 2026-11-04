"""Find out…: you need to know something first. The task stays yours, Fuzz answers into the brief as a step,
and the card comes back next, right after the card in front, never in place of it."""

import unittest

from helpers import CoreCase
from test_http import Server

from fuzz import answers, cards, scheduler, tasks, tools
from fuzz.db import FuzzError


class FindOut(CoreCase):
    def front(self):
        return [t["title"] for _, t in cards.queue(self.core)]

    def setup_queue(self):
        ids = [tasks.capture(self.core, x) for x in ("Plan the offsite", "Reply to Marcus", "Order lunch")]
        return ids

    def test_the_answer_comes_back_next_without_changing_the_card_in_front(self):
        plan, marcus, lunch = self.setup_queue()
        answers.answer(self.core, self.card_for(marcus)["id"], "find_out", "What did Marcus say about the setup?")
        t = self.task(marcus)
        self.assertEqual((t["state"], t["find_out"]), ("queued", "What did Marcus say about the setup?"))
        self.assertIn("finding_out", t["variant_tags"])
        self.assertEqual(self.front(), ["Plan the offsite", "Order lunch"])   # the card steps aside
        got = tools.claim_next_task(self.core)["task"]
        self.assertEqual((got["id"], got["finding_out"], got["may_finish"]), (marcus, "What did Marcus say about the setup?", False))
        tools.log_step(self.core, marcus, "research", "Read Marcus's thread")
        tools.update_brief(self.core, marcus, context_md="**Marcus**: use the staging setup.", summary="He said staging.",
                           effort_mins=30, steps=3)
        tools.finish_gathering(self.core, marcus, result=True)   # a lookup never finishes the task
        t = self.task(marcus)
        self.assertEqual((t["state"], t["title"]), ("triage", "Reply to Marcus"))
        self.assertIn("found_out", t["variant_tags"])
        self.assertNotIn("result", t["variant_tags"])
        self.assertEqual(self.front(), ["Plan the offsite", "Reply to Marcus", "Order lunch"])   # next, after the front
        answers.answer(self.core, self.card_for(plan)["id"], "done")
        self.assertEqual(self.front()[0], "Reply to Marcus")

    def test_a_find_out_is_never_retitled(self):
        _, marcus, _ = self.setup_queue()
        tasks.find_out(self.core, marcus, "Where are the test accounts?")
        tools.claim_next_task(self.core)
        with self.assertRaises(FuzzError) as e:
            tools.update_brief(self.core, marcus, title="Find the test accounts")
        self.assertEqual(e.exception.status, 409)
        self.assertEqual(self.task(marcus)["title"], "Reply to Marcus")

    def test_it_needs_a_question(self):
        _, marcus, _ = self.setup_queue()
        with self.assertRaises(FuzzError):
            answers.answer(self.core, self.card_for(marcus)["id"], "find_out", "  ")

    def test_gaps_in_the_brief_offer_find_out_first(self):
        tid = tasks.capture(self.core, "Test the plugin", gather=True)
        tools.claim_next_task(self.core)
        tools.update_brief(self.core, tid, context_md="## Setup", effort_mins=60, steps=4, gaps=["the test accounts"])
        tools.finish_gathering(self.core, tid)
        c = self.card_for(tid, "task")
        self.assertEqual(c["suggested"], "find_out")
        self.assertEqual(cards.view(self.core, c)["task"]["gaps"], ["the test accounts"])

    def test_if_fuzz_doesnt_get_to_it_the_card_still_comes_back_next(self):
        plan, marcus, _ = self.setup_queue()
        tasks.find_out(self.core, marcus, "Where are the test accounts?")
        self.clock.advance(minutes=5)
        scheduler.tick(self.core)
        self.assertEqual(self.task(marcus)["state"], "queued")
        self.clock.advance(minutes=6)
        scheduler.tick(self.core)
        self.assertEqual(self.front()[:2], ["Plan the offsite", "Reply to Marcus"])

    def test_sending_it_to_the_end_drops_next(self):
        plan, marcus, _ = self.setup_queue()
        tasks.find_out(self.core, marcus, "Where are the test accounts?")
        tools.claim_next_task(self.core)
        tools.finish_gathering(self.core, marcus)
        tasks.to_back(self.core, marcus)
        self.assertEqual(self.front()[-1], "Reply to Marcus")


class Api(Server):
    def test_find_out_from_task_detail(self):
        tid = tasks.capture(self.core, "Reply to Marcus")
        status, out = self.req("POST", f"/tasks/{tid}/find_out", {"question": "What did he ask for?"})
        self.assertEqual((status, out["state"]), (200, "queued"))
        self.assertEqual(self.req("GET", f"/tasks/{tid}")[1]["find_out"], "What did he ask for?")


if __name__ == "__main__":
    unittest.main()
