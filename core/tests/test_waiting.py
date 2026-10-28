"""Waiting on others: only when you're blocked on someone, always with a who and a time to check back."""

import unittest

from helpers import CoreCase

from fuzz import answers, cards, scheduler, tasks, tools
from fuzz.db import FuzzError


class Waiting(CoreCase):
    def captured(self, text="Get the signed SOW back"):
        tid = tasks.capture(self.core, text)
        return tid, self.card_for(tid, "task")

    def test_waiting_needs_a_who(self):
        tid, card = self.captured()
        with self.assertRaises(FuzzError) as e:
            answers.answer(self.core, card["id"], "wait")
        self.assertEqual(e.exception.field, "value")
        self.assertEqual(self.task(tid)["state"], "triage")

    def test_it_checks_back_in_three_business_days(self):
        tid, card = self.captured()   # Tuesday 9am
        answers.answer(self.core, card["id"], "wait", "Dana")
        t = self.task(tid)
        self.assertEqual((t["state"], t["waiting_on"], t["schedule_fire_at"]), ("waiting", "Dana", "2026-10-23T09:00:00Z"))
        self.clock.advance(days=2, hours=23)
        self.assertEqual(scheduler.tick(self.core).get("checked_back", 0), 0)
        self.clock.advance(hours=1)
        self.assertEqual(scheduler.tick(self.core)["checked_back"], 1)
        t = self.task(tid)
        self.assertEqual((t["state"], t["variant_tags"], t["reason"]), ("triage", ["check_back"], "Did Dana get back to you?"))
        c = self.card_for(tid, "task")
        self.assertEqual(cards.view(self.core, c, t)["options"], ["got_it", "nudge", "keep_waiting", "drop"])
        self.assertEqual(c["suggested"], "nudge")
        self.assertEqual(self.open_cards()[0]["task_id"], tid)

    def check_back_card(self):
        tid, card = self.captured()
        answers.answer(self.core, card["id"], "wait", "Dana")
        self.clock.advance(days=4)
        scheduler.tick(self.core)
        return tid, self.card_for(tid, "task")

    def test_got_it_makes_it_yours_again_first_in_line(self):
        other = tasks.capture(self.core, "Reply to Sam")
        tid, card = self.check_back_card()
        answers.answer(self.core, card["id"], "got_it")
        t = self.task(tid)
        self.assertEqual((t["state"], t["variant_tags"]), ("triage", []))
        self.assertEqual(cards.view(self.core, self.card_for(tid, "task"), t)["options"][0], "assign")
        self.assertEqual([c["task_id"] for c in self.open_cards()][:2], [tid, other])

    def test_keep_waiting_sets_a_new_check_back(self):
        tid, card = self.check_back_card()
        answers.answer(self.core, card["id"], "keep_waiting")
        t = self.task(tid)
        self.assertEqual((t["state"], t["waiting_on"]), ("waiting", "Dana"))
        self.assertGreater(t["schedule_fire_at"], self.core.now_iso())

    def test_nudge_hands_it_to_fuzz_to_draft(self):
        tid, card = self.check_back_card()
        answers.answer(self.core, card["id"], "nudge")
        t = self.task(tid)
        self.assertEqual(t["state"], "queued")
        self.assertIn("nudge to Dana", t["notes"])

    def test_someone_elses_task_is_let_go_not_tracked(self):
        tid, card = self.captured("Ship the Q4 dashboard")
        tasks.theirs(self.core, tid, on="Priya", card=card)   # "It's someone else's" on an is_task card
        t = self.task(tid)
        self.assertEqual((t["state"], t["owner"], t["variant_tags"]), ("letgo", "Priya", ["theirs"]))
        self.assertEqual(t["reason"], "You said this is Priya's, not yours.")
        self.assertEqual(tasks.list_tasks(self.core, "waiting"), [])


class FuzzPicksWhen(CoreCase):
    """With an executor, Fuzz reads the context and picks when to check back."""

    def setUp(self):
        super().setUp()
        self.tid = tasks.capture(self.core, "Get the signed SOW back")
        tasks.wait(self.core, self.tid, on="Dana", plan=True)

    def claim(self):
        got = tools.claim_next_task(self.core)["task"]
        self.assertEqual(got["id"], self.tid)
        return got

    def test_it_plans_before_it_waits(self):
        t = self.task(self.tid)
        self.assertEqual((t["state"], sorted(t["variant_tags"])), ("queued", ["gather", "plan_wait"]))
        got = self.claim()
        self.assertEqual((got["planning_wait"]["on"], got["may_finish"]), ("Dana", False))
        tools.finish_gathering(self.core, self.tid, check_back={"at": "2026-10-22T14:00", "reason": "She said Wednesday."})
        t = self.task(self.tid)
        self.assertEqual((t["state"], t["variant_tags"], t["schedule_fire_at"]), ("waiting", [], "2026-10-22T14:00:00Z"))

    def test_more_than_a_week_needs_a_reason(self):
        self.claim()
        with self.assertRaises(FuzzError):
            tools.finish_gathering(self.core, self.tid, check_back={"at": "2026-11-02T09:00", "reason": "Later."})
        with self.assertRaises(FuzzError):
            tools.finish_gathering(self.core, self.tid, check_back={"at": "2026-12-01T09:00", "reason": "Much later.",
                                                                     "beyond_a_week_because": "She's out."})
        tools.finish_gathering(self.core, self.tid, check_back={"at": "2026-11-09T09:00", "reason": "After she's back.",
                                                                 "beyond_a_week_because": "Out of office until Nov 6."})
        self.assertEqual(self.task(self.tid)["schedule_fire_at"], "2026-11-09T09:00:00Z")

    def test_without_a_pick_the_default_stands(self):
        self.claim()
        tools.finish_gathering(self.core, self.tid)
        self.assertEqual(self.task(self.tid)["schedule_fire_at"], "2026-10-23T09:00:00Z")

    def test_if_fuzz_never_gets_to_it_it_still_waits(self):
        self.clock.advance(minutes=11)
        self.assertEqual(scheduler.tick(self.core)["gather_timeout"], 1)
        t = self.task(self.tid)
        self.assertEqual((t["state"], t["schedule_fire_at"]), ("waiting", "2026-10-23T09:00:00Z"))


if __name__ == "__main__":
    unittest.main()
