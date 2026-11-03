"""A task you keep giving a new time: after reschedule.ask_after times it comes back asking what's in the way."""

import unittest

from helpers import CoreCase

from fuzz import answers, cards, events, scheduler, tasks

DESK = {"type": "at_desk"}


class PutOff(CoreCase):
    def put_off(self, tid, times):
        """Schedule it from its card and let it come back, `times` times."""
        for _ in range(times):
            answers.answer(self.core, self.card_for(tid, "task")["id"], "schedule", {"anchor": DESK})
            scheduler.wake(self.core)
        return self.task(tid)

    def test_the_first_two_times_it_comes_back_as_usual(self):
        tid = tasks.capture(self.core, "Update the naming guide")
        t = self.put_off(tid, 2)
        self.assertEqual((t["state"], t["reschedules"]), ("triage", 2))
        self.assertNotIn("put_off", t["variant_tags"])
        self.assertEqual(cards.view(self.core, self.card_for(tid, "task"), t)["options"][0], "assign")

    def test_the_third_time_it_asks_whats_in_the_way(self):
        tid = tasks.capture(self.core, "Update the naming guide")
        before = self.last_event_id()
        t = self.put_off(tid, 3)
        self.assertEqual(t["state"], "triage")
        self.assertIn("put_off", t["variant_tags"])
        self.assertEqual(t["reason"], tasks.PUT_OFF_REASON)
        self.assertIn("task.came_back", self.types_since(before))
        c = self.card_for(tid, "task")
        v = cards.view(self.core, c, t)
        self.assertEqual(v["options"], cards.PUT_OFF_OPTIONS)
        self.assertEqual(v["suggested"], "unclear")
        self.assertEqual(v["prompt"], cards.PUT_OFF_PROMPT)
        self.assertEqual(v["task"]["reschedules"], 3)

    def test_unclear_hands_it_to_fuzz_to_find_the_first_step(self):
        tid = tasks.capture(self.core, "Update the naming guide")
        self.put_off(tid, 3)
        answers.answer(self.core, self.card_for(tid, "task")["id"], "unclear")
        t = self.task(tid)
        self.assertEqual((t["state"], t["assignee"], t["reschedules"]), ("queued", "fuzz", 0))
        self.assertNotIn("put_off", t["variant_tags"])
        self.assertIn("smallest first step", t["notes"])

    def test_it_still_matters_makes_it_an_ordinary_card_and_starts_over(self):
        tid = tasks.capture(self.core, "Update the naming guide")
        self.put_off(tid, 3)
        answers.answer(self.core, self.card_for(tid, "task")["id"], "now")
        t = self.task(tid)
        self.assertEqual((t["state"], t["variant_tags"], t["reschedules"], t["reason"]), ("triage", ["returning"], 0, None))
        self.assertIsNone(t["reviewed_at"])
        self.assertEqual(cards.view(self.core, self.card_for(tid, "task"), t)["options"][0], "assign")
        self.assertEqual(events.task_log(self.core, tid)[0]["text"], "You said this still matters.")

    def test_another_time_from_the_card_starts_the_count_over(self):
        tid = tasks.capture(self.core, "Update the naming guide")
        self.put_off(tid, 3)
        t = self.put_off(tid, 1)
        self.assertEqual((t["reschedules"], "put_off" in t["variant_tags"]), (0, False))
        t = self.put_off(tid, 2)
        self.assertNotIn("put_off", t["variant_tags"])
        t = self.put_off(tid, 1)
        self.assertIn("put_off", t["variant_tags"])

    def test_park_and_let_go_end_it(self):
        for option, state in (("park", "parked"), ("drop", "letgo")):
            tid = tasks.capture(self.core, f"Task to {option}")
            self.put_off(tid, 3)
            answers.answer(self.core, self.card_for(tid, "task")["id"], option)
            t = self.task(tid)
            self.assertEqual((t["state"], t["reschedules"]), (state, 0))
            self.assertNotIn("put_off", t["variant_tags"])

    def test_the_cores_own_scheduling_doesnt_count(self):
        tid = tasks.capture(self.core, "Update the naming guide")   # like "hold the rest until tomorrow"
        tasks.schedule(self.core, tid, DESK, offered_only=False)
        self.assertIsNone(self.task(tid)["reschedules"])

    def test_off_when_ask_after_is_zero(self):
        self.core.config["reschedule"]["ask_after"] = 0
        tid = tasks.capture(self.core, "Update the naming guide")
        t = self.put_off(tid, 4)
        self.assertNotIn("put_off", t["variant_tags"])

    def test_undo_takes_back_the_answer(self):
        tid = tasks.capture(self.core, "Update the naming guide")
        self.put_off(tid, 3)
        answers.answer(self.core, self.card_for(tid, "task")["id"], "now")
        events.undo(self.core)
        t = self.task(tid)
        self.assertIn("put_off", t["variant_tags"])
        self.assertEqual(t["reschedules"], 3)


if __name__ == "__main__":
    unittest.main()
