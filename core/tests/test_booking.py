"""Booking time: Focus time slots from the calendar (reported by the executor, with a stub here: the core
never reads the calendar), the block anchor, calendar_hold drafts through the sender, prep before the
block, the block first in the list, the end and missed-block cards, and removing holds no longer needed."""

import unittest

from helpers import CoreCase

from fuzz import answers, booking, cards, config, drafts, events, scheduler, tasks, tools
from fuzz.db import FuzzError, parse_iso

# The test clock starts Tue 2026-10-20 09:00 UTC (and tz is UTC)
FOCUS = {"start": "2026-10-21T10:00:00Z", "end": "2026-10-21T12:00:00Z", "title": "Focus time"}
SHORT_FOCUS = {"start": "2026-10-20T15:00:00Z", "end": "2026-10-20T15:30:00Z", "title": "Focus time"}
FREE = {"start": "2026-10-21T13:00:00Z", "end": "2026-10-21T17:00:00Z"}


class Booking(CoreCase):
    def setUp(self):
        super().setUp()
        cfg = config.load(self.home)
        cfg["engine"] = {"client": "claude-code", "model": None}
        cfg["send"]["tools"]["claude-code"] = ["mcp__gcal__create_event", "mcp__gcal__delete_event"]
        config.save(self.home, cfg)
        self.core = self.make_core()

    def task(self, tid, core=None):
        return tasks.get(core or self.core, tid)

    def sized(self, title, mins, steps=3, due=None):
        tid = tasks.capture(self.core, title, due=due)
        tasks.update_brief(self.core, tid, effort_mins=mins, steps=steps, actor="human")
        return tid

    def view(self, tid):
        return cards.view(self.core, next(c for c in cards.open_cards(self.core, tid) if c["kind"] == "task"))

    def report(self, *slots, holds=None):
        return tools.report_calendar(self.core, list(slots), holds)

    def book_first(self, tid):
        v = self.view(tid)
        answers.answer(self.core, v["id"], "book", {"anchor": v["book_options"][0]["anchor"]})
        return self.task(tid)

    # ---- ranking
    def test_focus_slots_first_then_part_of_one_then_other_free_time(self):
        self.report(FOCUS, SHORT_FOCUS, FREE)
        opts = booking.options(self.core, self.task(self.sized("Write the Q4 readout", 90)))
        self.assertEqual([(o["anchor"]["start"], o["anchor"]["end"], o["note"]) for o in opts], [
            ("2026-10-21T10:00:00Z", "2026-10-21T11:30:00Z", "In a Focus time slot"),
            ("2026-10-20T15:00:00Z", "2026-10-20T15:30:00Z", "Block 1 of 3"),
            ("2026-10-21T13:00:00Z", "2026-10-21T14:30:00Z", "Not a focus slot")])

    def test_two_tasks_share_a_slot_but_never_the_same_time(self):
        self.report(FOCUS)
        self.book_first(self.sized("Write the Q4 readout", 90))
        opts = booking.options(self.core, self.task(self.sized("Reply to Marcus", 30)))
        self.assertEqual((opts[0]["anchor"]["start"], opts[0]["anchor"]["end"]), ("2026-10-21T11:30:00Z", "2026-10-21T12:00:00Z"))

    def test_nothing_after_the_due_date(self):
        self.report(FOCUS, FREE)
        tid = self.sized("Write the Q4 readout", 90, due="2026-10-21T12:00:00Z")
        self.assertEqual([o["anchor"]["start"] for o in booking.options(self.core, self.task(tid))], ["2026-10-21T10:00:00Z"])

    def test_without_a_report_fuzz_picks_its_own_times(self):
        self.assertTrue(booking.stale(self.core))
        self.assertEqual(tools.whoami(self.core, "executor")["calendar"]["read_now"], True)
        opts = booking.options(self.core, self.task(self.sized("Write the Q4 readout", 90)))
        self.assertTrue(opts and opts[0]["source"] == "fuzz")
        self.report(FOCUS)
        self.assertFalse(tools.whoami(self.core, "executor")["calendar"]["read_now"])

    # ---- the hold
    def test_booking_makes_a_hold_draft_through_the_sender(self):
        self.report(FOCUS)
        tid = self.sized("Write the Q4 readout", 90)
        t = self.book_first(tid)
        self.assertEqual((t["state"], t["schedule_anchor"]["type"]), ("scheduled", "block"))
        d = self.core.one("SELECT * FROM drafts WHERE task_id=? AND kind='calendar_hold'", (tid,))
        self.assertEqual((d["status"], d["meta"]["title"]), ("pending", "Write the Q4 readout"))
        self.assertIn(f"#tasks/{tid}", d["body"])
        self.assertIn("Done when:", d["body"])
        c = next(c for c in cards.open_cards(self.core, tid) if c["kind"] == "hold")
        self.assertEqual(cards.options(c, t), ["approve", "always_allow", "skip"])
        answers.answer(self.core, c["id"], "approve")
        got = tools.claim_next_send(self.core)["send"]
        self.assertEqual((got["kind"], got["hold"]["start"], got["hold"]["title"]),
                         ("calendar_hold", "2026-10-21T10:00:00Z", "Write the Q4 readout"))
        tools.mark_sent(self.core, tid, got["draft_id"], "Google Calendar", "evt-1")
        t = self.task(tid)
        self.assertEqual((t["state"], t["schedule_anchor"]["event_id"], t["lease_owner"]), ("scheduled", "evt-1", None))

    def test_always_allow_sends_the_next_hold_straight_on(self):
        self.report(FOCUS, FREE)
        a = self.sized("Write the Q4 readout", 90)
        self.book_first(a)
        answers.answer(self.core, next(c for c in cards.open_cards(self.core, a) if c["kind"] == "hold")["id"], "always_allow")
        b = self.sized("Plan the offsite", 30)
        self.book_first(b)
        self.assertEqual([c["kind"] for c in cards.open_cards(self.core, b)], [])
        self.assertEqual(self.core.one("SELECT status FROM drafts WHERE task_id=? AND kind='calendar_hold'", (b,))["status"], "approved")

    def test_without_a_calendar_tool_its_still_booked_in_fuzz(self):
        cfg = config.load(self.home)
        cfg["send"]["tools"]["claude-code"] = []
        config.save(self.home, cfg)
        core = self.make_core()
        tid = tasks.capture(core, "Write the Q4 readout")
        c = next(c for c in cards.open_cards(core, tid) if c["kind"] == "task")
        answers.answer(core, c["id"], "book", {"anchor": cards.view(core, c)["book_options"][0]["anchor"]})
        self.assertEqual(tasks.get(core, tid)["state"], "scheduled")
        self.assertIsNone(core.one("SELECT id FROM drafts WHERE task_id=?", (tid,)))
        self.assertIn("Add it to your calendar yourself", events.task_log(core, tid, 1)[0]["text"])

    # ---- before, during and after the block
    def test_prep_then_the_block_first_in_the_list(self):
        self.report(FOCUS)
        tid = self.sized("Write the Q4 readout", 90)
        self.book_first(tid)
        self.clock.t = parse_iso("2026-10-21T09:35:00Z")
        scheduler.tick(self.core)
        t = self.task(tid)
        self.assertEqual(t["state"], "queued")
        self.assertIn("prep", t["variant_tags"])
        tools.claim_next_task(self.core)
        tools.update_brief(self.core, tid, context_md="1. Open last quarter's deck\n2. …", effort_mins=90, steps=6)
        tools.finish_gathering(self.core, tid)
        t = self.task(tid)
        self.assertEqual(t["state"], "scheduled")
        self.assertIn("prepped", t["variant_tags"])
        tasks.capture(self.core, "Sign the contract", due="2026-10-21T10:30:00Z")
        self.clock.t = parse_iso("2026-10-21T10:00:00Z")
        scheduler.tick(self.core)
        q = [x["title"] for _, x in cards.queue(self.core)]
        self.assertEqual(q[:2], ["Write the Q4 readout", "Sign the contract"])   # the block first, a deadline second
        self.assertIn("doing", self.task(tid)["variant_tags"])

    def _in_block(self):
        self.report(FOCUS, {"start": "2026-10-21T11:30:00Z", "end": "2026-10-21T12:30:00Z"})
        tid = self.sized("Write the Q4 readout", 90)
        self.book_first(tid)
        self.clock.t = parse_iso("2026-10-21T10:00:00Z")
        scheduler.tick(self.core)
        return tid

    def test_at_the_end_how_far_did_you_get(self):
        tid = self._in_block()
        tasks.save_notes(self.core, tid, "Halfway", actor="human")   # you worked on it
        self.clock.t = parse_iso("2026-10-21T11:31:00Z")
        scheduler.tick(self.core)
        c = next(c for c in cards.open_cards(self.core, tid) if c["kind"] == "task")
        self.assertEqual(c["prompt"], "How far did you get?")
        self.assertEqual(cards.options(c, self.task(tid)), ["done", "keep_going", "book", "pause"])
        answers.answer(self.core, c["id"], "keep_going")
        self.assertEqual(self.task(tid)["schedule_anchor"]["end"], "2026-10-21T12:01:00Z")

    def test_a_missed_block_asks_for_another_time_and_two_keep_coming_back(self):
        tid = self._in_block()
        self.clock.t = parse_iso("2026-10-21T11:31:00Z")
        scheduler.tick(self.core)
        c = next(c for c in cards.open_cards(self.core, tid) if c["kind"] == "task")
        self.assertEqual((c["prompt"], c["suggested"]), ("The block for this went by. Find another time?", "book"))
        self.report({"start": "2026-10-22T10:00:00Z", "end": "2026-10-22T12:00:00Z", "title": "Focus time"})
        answers.answer(self.core, c["id"], "book", {"anchor": cards.view(self.core, c)["book_options"][0]["anchor"]})
        self.clock.t = parse_iso("2026-10-22T10:00:00Z")
        scheduler.tick(self.core)
        self.clock.t = parse_iso("2026-10-22T11:31:00Z")
        scheduler.tick(self.core)
        self.assertIn("put_off", self.task(tid)["variant_tags"])

    def test_finished_early_offers_to_remove_the_hold(self):
        self.report(FOCUS)
        tid = self.sized("Write the Q4 readout", 90)
        self.book_first(tid)
        answers.answer(self.core, next(c for c in cards.open_cards(self.core, tid) if c["kind"] == "hold")["id"], "approve")
        got = tools.claim_next_send(self.core)["send"]
        tools.mark_sent(self.core, tid, got["draft_id"], "Google Calendar", "evt-1")
        tasks.done(self.core, tid)
        scheduler.tick(self.core)
        c = next(c for c in cards.open_cards(self.core, tid) if c["kind"] == "hold")
        self.assertIn("Remove the hold", c["prompt"])
        answers.answer(self.core, c["id"], "approve")
        got = tools.claim_next_send(self.core)["send"]
        self.assertEqual((got["kind"], got["hold"]["event_id"]), ("calendar_remove", "evt-1"))

    def test_a_hold_you_move_or_cancel(self):
        self.report(FOCUS)
        tid = self.sized("Write the Q4 readout", 90)
        self.book_first(tid)
        with self.core.tx("system"):   # as if the sender had put it on the calendar
            ch = events.Changes()
            ch.task(tid, schedule_anchor=dict(self.task(tid)["schedule_anchor"], event_id="evt-1"))
            events.emit(self.core, "task.sent", task_id=tid, changes=ch)
        out = self.report(FOCUS, holds=[{"event_id": "evt-1", "start": "2026-10-21T14:00:00Z", "end": "2026-10-21T15:30:00Z"}])
        self.assertEqual(out["moved"], 1)
        self.assertEqual(self.task(tid)["schedule_fire_at"], "2026-10-21T14:00:00Z")
        self.report(FOCUS, holds=[{"event_id": "evt-1", "cancelled": True}])
        self.assertEqual(self.task(tid)["state"], "triage")

    def test_the_executor_reports_the_calendar_through_suggest_schedule(self):
        tid = self.sized("Write the Q4 readout", 90)
        tasks.assign(self.core, tid)
        tools.claim_next_task(self.core)
        out = tools.suggest_schedule(self.core, tid, calendar={"slots": [FOCUS]})
        self.assertEqual(out["calendar"]["slots"], 1)
        self.assertFalse(booking.stale(self.core))
        with self.assertRaises(FuzzError):
            tools.suggest_schedule(self.core, tid, calendar={"slots": [{"start": "x"}]})

    def test_a_block_must_be_in_the_future(self):
        tid = self.sized("Write the Q4 readout", 90)
        with self.assertRaises(FuzzError):
            answers.answer(self.core, self.view(tid)["id"], "book",
                           {"anchor": {"type": "block", "start": "2026-10-20T08:00:00Z", "end": "2026-10-20T09:30:00Z"}})


if __name__ == "__main__":
    unittest.main()
