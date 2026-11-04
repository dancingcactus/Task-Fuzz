"""Focus, said per session: the instant pass, the queue and claim order (with a booked block on top), the
card in front never changing, the AI pass (refused on an unknown id, harmless when it fails) and saved
phrases."""

import json
import unittest

from helpers import CoreCase
from test_http import Server

from fuzz import cards, focus, scheduler, tasks, tools
from fuzz.db import FuzzError


class Focus(CoreCase):
    def setUp(self):
        super().setUp()
        self.park = tasks.capture(self.core, "Renew the parking permit")
        self.prep = tasks.capture(self.core, "Prep the Northwind call notes")
        self.reply = tasks.capture(self.core, "Reply to Northwind about pricing")
        self.deck = tasks.capture(self.core, "Update the Q4 deck")

    def front(self, **kw):
        return [t["title"] for _, t in cards.queue(self.core, **kw)]

    def test_the_instant_pass_finds_the_tasks_by_their_words(self):
        m = focus.match(self.core, "prep for the Northwind call")
        self.assertEqual({x["task_id"] for x in m["tasks"]}, {self.prep, self.reply})

    def test_focus_goes_after_deadlines_and_before_everything_else(self):
        tasks.capture(self.core, "Sign the contract", due="2026-10-20T11:00:00Z")
        scheduler.tick(self.core)
        focus.set_focus(self.core, "Northwind call")
        self.assertEqual(self.front()[:3], ["Sign the contract", "Prep the Northwind call notes", "Reply to Northwind about pricing"])

    def test_the_card_in_front_never_changes(self):
        c = cards.queue(self.core)[0][0]
        focus.set_focus(self.core, "Northwind call")
        self.assertEqual(self.front(front=c["id"])[0], "Renew the parking permit")
        self.assertNotEqual(self.front()[0], "Renew the parking permit")

    def test_you_confirm_what_it_matched_minus_not_that_one(self):
        focus.set_focus(self.core, "Northwind", task_ids=[self.prep])
        self.assertEqual(focus.focus_ids(self.core), {self.prep})
        with self.assertRaises(FuzzError):
            focus.set_focus(self.core, "Northwind", task_ids=[999])

    def test_the_ai_pass_refines_and_the_phrase_is_kept(self):
        focus.set_focus(self.core, "the quarterly readout")
        self.assertEqual(focus.focus_ids(self.core), set())   # no words in common
        out = focus.ai_pass(self.core, "the quarterly readout",
                            runner=lambda argv, p: json.dumps({"in": [self.deck], "maybe": [], "terms": ["Q4"]}))
        self.assertEqual(out, [self.deck])
        self.assertEqual(focus.focus_ids(self.core), {self.deck})
        self.assertEqual(self.front()[0], "Update the Q4 deck")
        focus.clear(self.core)
        m = focus.match(self.core, "The quarterly readout")   # saved: instant next time
        self.assertEqual([x["task_id"] for x in m["tasks"]], [self.deck])

    def test_an_unknown_id_is_refused_and_a_failed_pass_changes_nothing(self):
        focus.set_focus(self.core, "Northwind call")
        before = focus.focus_ids(self.core)
        with self.assertRaises(FuzzError):
            focus.refine(self.core, "Northwind call", {"in": [999]})
        self.assertIsNone(focus.ai_pass(self.core, "Northwind call", runner=lambda argv, p: "I can't help with that"))
        self.assertIsNone(focus.ai_pass(self.core, "Northwind call", runner=lambda argv, p: json.dumps({"in": [999]})))

        def slow(argv, p):
            raise focus.subprocess.TimeoutExpired("claude", 45)
        self.assertIsNone(focus.ai_pass(self.core, "Northwind call", runner=slow))
        self.assertEqual(focus.focus_ids(self.core), before)

    def test_the_small_things_means_quick_ones_first(self):
        focus.set_focus(self.core, "clear the small things")
        self.assertEqual(cards.moment(self.core), "quick")

    def test_stepping_away_ends_the_sessions_focus(self):
        focus.set_focus(self.core, "Northwind call")
        scheduler.wake(self.core)
        self.assertIsNone(focus.current(self.core))
        self.assertEqual(focus.focus_ids(self.core), set())

    def test_skip_keeps_the_weeks_focus(self):
        focus.set_focus(self.core, skip=True)
        self.assertEqual(focus.focus_ids(self.core), set())

    def test_fuzz_claims_focus_work_first(self):
        for tid in (self.park, self.prep):
            tasks.assign(self.core, tid)
        focus.set_focus(self.core, "Northwind call")
        self.assertEqual(tools.claim_next_task(self.core)["task"]["id"], self.prep)

    def test_a_booked_block_stays_on_top_of_the_focus(self):
        focus.set_focus(self.core, "Northwind call")
        tasks.do_now(self.core, self.deck, card=self.card_for(self.deck))
        self.assertEqual(self.front()[0], "Update the Q4 deck")


class Api(Server):
    def test_preview_set_and_the_cards(self):
        tasks.capture(self.core, "Renew the parking permit")
        tid = tasks.capture(self.core, "Prep the Northwind call notes")
        status, got = self.req("GET", "/focus/preview?q=Northwind%20call")
        self.assertEqual((status, [x["task_id"] for x in got["tasks"]]), (200, [tid]))
        status, got = self.req("POST", "/focus", {"text": "Northwind call", "task_ids": [tid]})
        self.assertEqual(got["focus"]["task_ids"], [tid])
        cs = self.req("GET", "/cards")[1]
        self.assertEqual((cs["cards"][0]["task"]["id"], cs["focus"]["text"]), (tid, "Northwind call"))
        first = cs["cards"][1]["id"]
        self.assertEqual(self.req("GET", f"/cards?front={first}")[1]["cards"][0]["id"], first)
        chips = self.req("GET", "/focus")[1]["chips"]
        self.assertEqual([c["label"] for c in chips], ["Northwind call", "Whatever’s next"])


if __name__ == "__main__":
    unittest.main()
