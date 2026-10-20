"""The time resolver with a fixed clock: each anchor works out to the right time, nothing lands after
the due date, exact is always last, and the AI gets at most two slots."""

import unittest
from datetime import datetime, timezone

from helpers import CoreCase

from fuzz import answers, scheduler, tasks, timeres
from fuzz.db import FuzzError, iso


def at(*a):
    return iso(datetime(*a, tzinfo=timezone.utc))


class Anchors(CoreCase):
    # The clock starts Tuesday 2026-10-20 09:00 UTC, and the store's tz is UTC.
    def resolve(self, anchor, due=None):
        t = timeres.resolve(self.core, anchor, {"due": due})
        return iso(t) if t else None

    def test_each_anchor(self):
        self.assertEqual(self.resolve({"type": "in", "minutes": 30}), at(2026, 10, 20, 9, 30))
        self.assertEqual(self.resolve({"type": "in", "minutes": "2h"}), at(2026, 10, 20, 11, 0))
        self.assertEqual(self.resolve({"type": "later_today"}), at(2026, 10, 20, 16, 0))
        self.assertIsNone(self.resolve({"type": "at_desk"}))
        self.assertEqual(self.resolve({"type": "day_part", "day": "tomorrow", "part": "morning"}), at(2026, 10, 21, 9))
        self.assertEqual(self.resolve({"type": "day_part", "day": "monday", "part": "afternoon"}), at(2026, 10, 26, 13))
        self.assertEqual(self.resolve({"type": "day_part", "day": "tuesday"}), at(2026, 10, 27, 9), "next Tuesday, not today")
        self.assertEqual(self.resolve({"type": "day_part", "day": "next_week"}), at(2026, 10, 27, 9))
        self.assertEqual(self.resolve({"type": "before_due", "lead": "1d"}, due="2026-10-23T17:00:00Z"),
                         at(2026, 10, 22, 17))
        self.assertEqual(self.resolve({"type": "exact", "at": "2026-10-22T14:00:00Z"}), at(2026, 10, 22, 14))

    def test_later_today_late_in_the_day(self):
        self.clock.advance(hours=7)   # 16:00
        self.assertEqual(self.resolve({"type": "later_today"}), at(2026, 10, 20, 17))
        self.clock.advance(hours=6)   # 22:00: nothing left today
        self.assertIsNone(self.resolve({"type": "later_today"}))

    def test_local_time_zone(self):
        cfg = self.core.config
        cfg["tz"] = "America/Los_Angeles"
        self.core.save_config(cfg)
        # 09:00 UTC is 02:00 in Los Angeles; tomorrow morning is 09:00 PDT = 16:00 UTC
        self.assertEqual(self.resolve({"type": "day_part", "day": "tomorrow"}), at(2026, 10, 21, 16))

    def test_bad_anchors_name_the_field(self):
        for anchor, field in (({"type": "soon"}, "anchor.type"), ({"type": "in", "minutes": "a while"}, "anchor.minutes"),
                              ({"type": "day_part", "part": "midnight"}, "anchor.part"),
                              ({"type": "before_due"}, "anchor.type"),
                              ({"type": "before_event", "event_id": "x"}, "anchor.type")):
            with self.assertRaises(FuzzError) as e:
                timeres.resolve(self.core, anchor, {})
            self.assertEqual(e.exception.field, field, anchor)

    def test_labels_come_from_templates(self):
        self.assertEqual(timeres.label(self.core, {"type": "at_desk"}), "When I’m back at my desk")
        self.assertEqual(timeres.label(self.core, {"type": "before_event", "title": "the planning review"}),
                         "Before the planning review")
        self.assertEqual(timeres.label(self.core, {"type": "next_with_person", "name": "Sam Ortiz"}), "Next time I see Sam")
        self.assertEqual(timeres.line(self.core, {"type": "day_part", "day": "monday", "part": "morning"}),
                         "I’ll bring it back monday morning.")


class Options(CoreCase):
    def labels(self, due=None, hints=None):
        return [o["label"] for o in timeres.build_options(self.core, {"due": due, "schedule_hints": hints or []})]

    def test_timeline_by_time_left(self):
        self.assertEqual(self.labels(None), ["Later today", "When I’m back at my desk", "Monday morning",
                                             "Sometime next week", "Pick an exact time"])
        self.assertEqual(self.labels("2026-10-20T12:00:00Z"), ["In 30 minutes", "An hour before it’s due",
                                                               "Pick an exact time"])
        self.assertEqual(self.labels("2026-10-21T15:00:00Z"), ["Later today", "When I’m back at my desk",
                                                               "First thing tomorrow", "A few hours before it’s due",
                                                               "Pick an exact time"])
        self.assertEqual(self.labels("2026-10-24T17:00:00Z"), ["First thing tomorrow", "The day before it’s due",
                                                               "Pick an exact time"])
        self.assertEqual(self.labels("2026-11-20"), ["Sometime next week", "A week before it’s due", "Pick an exact time"])

    def test_nothing_after_the_due_date_and_exact_last(self):
        for due in ("2026-10-20T10:00:00Z", "2026-10-20T20:00:00Z", "2026-10-21T08:00:00Z", "2026-10-22", None):
            opts = timeres.build_options(self.core, {"due": due})
            self.assertEqual(opts[-1]["label"], "Pick an exact time")
            for o in opts:
                if o["fire_at"] and due:
                    self.assertLessEqual(o["fire_at"], timeres.iso(timeres.parse_iso(due)), (due, o))

    def test_ai_suggestions_go_first_at_most_two(self):
        hints = [{"type": "day_part", "day": "thursday", "part": "afternoon", "reason": "after the review"},
                 {"type": "in", "minutes": "3h"}, {"type": "day_part", "day": "wednesday"}]
        labels = self.labels("2026-10-24T17:00:00Z", hints)
        self.assertEqual(labels[:2], ["Thursday afternoon", "In 3 hours"])
        self.assertNotIn("Wednesday morning", labels)

    def test_a_suggestion_after_the_due_date_is_dropped(self):
        labels = self.labels("2026-10-21T17:00:00Z", [{"type": "day_part", "day": "friday"}])
        self.assertNotIn("Friday morning", labels)

    def test_suggest_schedule_is_checked_by_the_core(self):
        tid = tasks.capture(self.core, "Prep the planning review", due="2026-10-24T17:00:00Z")
        self.assertEqual(scheduler.suggest_schedule(self.core, tid, {"type": "day_part", "day": "thursday"}, "quiet day"),
                         "Thursday morning")
        with self.assertRaises(FuzzError):
            scheduler.suggest_schedule(self.core, tid, {"type": "day_part", "day": "2026-11-01"}, "too late")
        card = self.card_for(tid, "task")
        self.assertEqual(card["schedule_options"][0]["label"], "Thursday morning", "the open card's options refresh")


class ComingBack(CoreCase):
    def schedule(self, anchor, due=None):
        tid = tasks.capture(self.core, "Look at the dashboard spike", due=due)
        card = self.card_for(tid, "task")
        answers.answer(self.core, card["id"], "schedule", {"anchor": anchor})
        return tid

    def test_scheduled_task_comes_back_as_returning(self):
        tid = self.schedule({"type": "day_part", "day": "monday", "part": "morning"})
        self.assertEqual(self.task(tid)["schedule_fire_at"], "2026-10-26T09:00:00Z")
        self.clock.advance(days=5, hours=23)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["state"], "scheduled")
        self.clock.advance(hours=1)
        before = self.last_event_id()
        scheduler.tick(self.core)
        t = self.task(tid)
        self.assertEqual(t["state"], "triage")
        self.assertIn("returning", t["variant_tags"])
        self.assertIn("task.came_back", self.types_since(before))
        self.card_for(tid, "task")

    def test_at_desk_waits_for_wake(self):
        tid = self.schedule({"type": "at_desk"})
        self.clock.advance(days=3)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["state"], "scheduled")
        self.assertEqual(scheduler.wake(self.core), 1)
        self.assertEqual(self.task(tid)["state"], "triage")

    def test_exact_time_is_accepted_but_not_in_the_past(self):
        tid = tasks.capture(self.core, "Call the venue")
        card = self.card_for(tid, "task")
        with self.assertRaises(FuzzError):
            answers.answer(self.core, card["id"], "schedule", {"anchor": {"type": "exact", "at": "2026-10-19T09:00:00Z"}})
        answers.answer(self.core, card["id"], "schedule", {"anchor": {"type": "exact", "at": "2026-10-22T14:00:00Z"}})
        self.assertEqual(self.task(tid)["schedule_fire_at"], "2026-10-22T14:00:00Z")

    def test_picks_are_logged_for_learning(self):
        self.schedule({"type": "at_desk"})
        fb = self.core.one("SELECT kind, note FROM feedback ORDER BY id DESC LIMIT 1")
        self.assertEqual((fb["kind"], fb["note"]), ("schedule", "at_desk:core"))

    def test_deadline_levels_and_time_sensitive(self):
        tid = tasks.capture(self.core, "Confirm headcount", due="2026-10-20T15:00:00Z")
        scheduler.tick(self.core)
        t = self.task(tid)
        self.assertEqual(t["deadline_level"], 1)
        self.assertIn("time_sensitive", t["variant_tags"])
        self.clock.advance(hours=3)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["deadline_level"], 2)
        self.clock.advance(hours=3)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["deadline_level"], 3)


if __name__ == "__main__":
    unittest.main()
