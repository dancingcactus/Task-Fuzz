"""The parked review: a few parked tasks a day come back to ask "Still want this?", by your energy."""

import unittest
from unittest import mock

from helpers import CoreCase

from fuzz import answers, cards, checkins, review, scheduler, tasks, tools


class Review(CoreCase):
    def setUp(self):
        super().setUp()
        p = mock.patch.object(review.config, "gathers", return_value=False)   # no executor: straight to triage
        p.start()
        self.addCleanup(p.stop)

    def parked(self, n, title="Look into a standing desk"):
        ids = []
        for i in range(n):
            tid = tasks.capture(self.core, f"{title} {i + 1}")
            tasks.park(self.core, tid, card=self.card_for(tid, "task"))
            ids.append(tid)
        self.clock.advance(days=8)   # rested long enough to ask about
        return ids

    def asked(self):
        return [t["id"] for t in tasks.list_tasks(self.core, "triage") if "review" in (t["variant_tags"] or [])]

    def test_nothing_comes_back_before_a_check_in(self):
        self.parked(2)
        self.assertEqual(scheduler.tick(self.core)["review"], 0)

    def test_energy_sets_todays_share(self):
        self.parked(10)
        checkins.record(self.core, "tired")
        self.assertEqual(scheduler.tick(self.core)["review"], 0)
        checkins.record(self.core, "okay")
        self.assertEqual(scheduler.tick(self.core)["review"], 1)
        checkins.record(self.core, "good")   # a better mood later in the day tops it up to three
        self.assertEqual(scheduler.tick(self.core)["review"], 2)
        self.assertEqual(scheduler.tick(self.core)["review"], 0)
        self.assertEqual(len(self.asked()), 3)

    def test_the_week_has_a_cap(self):
        self.parked(12)
        got = []
        for day in range(4):
            checkins.record(self.core, "good")
            got.append(scheduler.tick(self.core)["review"])
            self.clock.advance(days=1)
        self.assertEqual(got, [3, 3, 1, 0])
        self.clock.advance(days=3, minutes=1)   # just over seven days after the first
        checkins.record(self.core, "good")
        self.assertEqual(scheduler.tick(self.core)["review"], 3)

    def test_oldest_first_and_only_rested_and_quiet_ones(self):
        old = self.parked(2)
        fresh = tasks.capture(self.core, "Read the design doc")
        tasks.park(self.core, fresh, card=self.card_for(fresh, "task"))
        woke = old[0]
        t = self.task(woke)
        with self.core.tx("system"):
            from fuzz import events
            ch = events.Changes()
            ch.task(woke, variant_tags=tasks._tags(t, add=("woke",)))
            events.emit(self.core, "task.woke", task_id=woke, changes=ch)
        checkins.record(self.core, "good")
        scheduler.tick(self.core)
        self.assertEqual(self.asked(), [old[1]])

    def test_the_card_asks_and_offers_four_answers(self):
        tid = self.parked(1)[0]
        checkins.record(self.core, "okay")
        scheduler.tick(self.core)
        c = self.card_for(tid, "task")
        view = cards.view(self.core, c, self.task(tid))
        self.assertEqual(view["options"], ["keep_parked", "now", "schedule", "drop"])
        self.assertEqual(c["suggested"], "keep_parked")
        self.assertEqual(self.task(tid)["reason"], "Parked since October 20. Still want this?")

    def test_keep_parked_waits_a_month_before_asking_again(self):
        tid = self.parked(1)[0]
        checkins.record(self.core, "okay")
        scheduler.tick(self.core)
        answers.answer(self.core, self.card_for(tid, "task")["id"], "keep_parked")
        t = self.task(tid)
        self.assertEqual((t["state"], t["reviews"], t["variant_tags"]), ("parked", 1, []))
        for _ in range(3):
            self.clock.advance(days=8)
            checkins.record(self.core, "good")
            self.assertEqual(scheduler.tick(self.core)["review"], 0)
        self.clock.advance(days=5)
        checkins.record(self.core, "good")
        self.assertEqual(scheduler.tick(self.core)["review"], 1)
        self.assertIn("You kept this parked on", self.task(tid)["reason"])

    def test_after_enough_keeps_it_suggests_letting_go(self):
        tid = self.parked(1)[0]
        for _ in range(self.core.config["review"]["let_go_after"]):
            checkins.record(self.core, "good")
            scheduler.tick(self.core)
            answers.answer(self.core, self.card_for(tid, "task")["id"], "keep_parked")
            self.clock.advance(days=29)
        checkins.record(self.core, "good")
        scheduler.tick(self.core)
        self.assertEqual(self.card_for(tid, "task")["suggested"], "drop")
        self.assertIn("Let it go?", self.task(tid)["reason"])
        answers.answer(self.core, self.card_for(tid, "task")["id"], "drop")
        self.assertEqual(self.task(tid)["state"], "letgo")

    def test_bring_it_back_puts_a_fresh_card_first(self):
        other = tasks.capture(self.core, "Reply to Dana")
        tid = self.parked(1)[0]
        checkins.record(self.core, "okay")
        scheduler.tick(self.core)
        answers.answer(self.core, self.card_for(tid, "task")["id"], "now")
        t = self.task(tid)
        self.assertEqual((t["state"], t["variant_tags"], t["reason"]), ("triage", [], None))
        c = self.card_for(tid, "task")
        self.assertEqual(cards.view(self.core, c, t)["options"][0], "assign")
        self.assertEqual([x["task_id"] for x in self.open_cards()][:2], [tid, other])

    def test_schedule_from_a_review_card(self):
        tid = self.parked(1)[0]
        checkins.record(self.core, "okay")
        scheduler.tick(self.core)
        c = self.card_for(tid, "task")
        offered = cards.view(self.core, c, self.task(tid))["schedule_options"][0]["anchor"]
        answers.answer(self.core, c["id"], "schedule", {"anchor": offered})
        t = self.task(tid)
        self.assertEqual((t["state"], t["variant_tags"]), ("scheduled", []))


class ReviewWithFuzz(CoreCase):
    """With an executor, Fuzz checks what changed before the card shows."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(review.config, "gathers", return_value=True)
        p.start()
        self.addCleanup(p.stop)
        self.tid = tasks.capture(self.core, "Book the offsite venue")
        tasks.park(self.core, self.tid, card=self.card_for(self.tid, "task"))
        self.clock.advance(days=8)
        checkins.record(self.core, "okay")
        scheduler.tick(self.core)

    def test_fuzz_looks_first_then_it_asks(self):
        t = self.task(self.tid)
        self.assertEqual((t["state"], sorted(t["variant_tags"])), ("queued", ["gather", "review"]))
        got = tools.claim_next_task(self.core)["task"]
        self.assertEqual((got["id"], got["gathering"], got["reviewing"], got["may_finish"]), (self.tid, True, True, False))
        tools.finish_gathering(self.core, self.tid, result=True)   # an executor without the guidance still only asks
        t = self.task(self.tid)
        self.assertEqual((t["state"], t["variant_tags"]), ("triage", ["review"]))
        self.assertEqual(cards.view(self.core, self.card_for(self.tid, "task"), t)["options"][0], "keep_parked")

    def test_a_stuck_look_still_asks(self):
        self.assertEqual(scheduler.tick(self.core)["gather_timeout"], 0)   # its clock starts when it came back
        self.clock.advance(minutes=11)
        self.assertEqual(scheduler.tick(self.core)["gather_timeout"], 1)
        t = self.task(self.tid)
        self.assertEqual((t["state"], t["variant_tags"]), ("triage", ["review"]))


if __name__ == "__main__":
    unittest.main()
