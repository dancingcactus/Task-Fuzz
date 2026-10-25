"""Moments: up to two described dates a task carries ("Before the leadership meeting", Thu 9:00).
The core checks them, offers them first, and moves or brings back a task scheduled on one when a
later run hands it in again with a new time or as cancelled. Also: back-at-desk detection."""

import threading
import unittest

from helpers import CoreCase

from fuzz import answers, cards, events, http_api, presence, scheduler, tasks, timeres, tools
from fuzz.db import FuzzError

LEADERSHIP = {"type": "moment", "key": "leadership-1030", "label": "Before the leadership meeting",
              "at": "2026-10-30T09:00:00Z"}


def moment(**kw):
    return dict(LEADERSHIP, **kw)


class Shape(CoreCase):
    def test_resolves_to_its_time_with_its_own_label(self):
        self.assertEqual(timeres.iso(timeres.resolve(self.core, LEADERSHIP)), "2026-10-30T09:00:00Z")
        self.assertEqual(timeres.label(self.core, moment(label="after Sam's 1:1")), "After Sam's 1:1")
        self.assertEqual(timeres.line(self.core, LEADERSHIP), "I’ll bring it back before the leadership meeting.")

    def test_bad_moments_name_the_field(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers", due="2026-10-31")
        cases = ((moment(at="next thursday"), "anchor.at"), (moment(label=""), "anchor.label"),
                 (moment(label="x" * 61), "anchor.label"), (moment(label="two\nlines"), "anchor.label"),
                 (moment(at="2026-10-19T09:00:00Z"), "anchor.at"),     # past
                 (moment(at="2026-11-02T09:00:00Z"), "anchor.at"))     # after due
        for m, field in cases:
            with self.assertRaises(FuzzError, msg=m) as e:
                scheduler.suggest_schedule(self.core, tid, m, "")
            self.assertEqual(e.exception.field, field, m)

    def test_a_key_is_made_from_the_label_when_missing(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers")
        m = {k: v for k, v in LEADERSHIP.items() if k != "key"}
        scheduler.suggest_schedule(self.core, tid, m, "")
        self.assertEqual(self.task(tid)["schedule_hints"][0]["key"], "before-the-leadership-meeting")


class Options(CoreCase):
    def test_moments_first_at_most_two_same_key_replaces(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers", due="2026-11-06")
        scheduler.suggest_schedule(self.core, tid, LEADERSHIP, "")
        scheduler.suggest_schedule(self.core, tid, moment(key="sam", label="Next time I see Sam",
                                                          at="2026-10-22T14:00:00Z"), "")
        scheduler.suggest_schedule(self.core, tid, moment(at="2026-10-29T09:00:00Z"), "moved up")
        hints = self.task(tid)["schedule_hints"]
        self.assertEqual([h["key"] for h in hints], ["leadership-1030", "sam"], "the same key replaced, not added")
        scheduler.suggest_schedule(self.core, tid, moment(key="board", label="Before the board call",
                                                          at="2026-10-28T09:00:00Z"), "")
        self.assertEqual(len(self.task(tid)["schedule_hints"]), 2, "never more than two")
        opts = self.card_for(tid, "task")["schedule_options"]
        self.assertEqual([o["label"] for o in opts[:2]], ["Before the board call", "Before the leadership meeting"])
        self.assertEqual(opts[0]["source"], "ai")
        self.assertEqual(opts[-1]["label"], "Pick an exact time")

    def test_past_or_cancelled_moments_drop_out(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers")
        scheduler.suggest_schedule(self.core, tid, moment(at="2026-10-20T12:00:00Z"), "")
        self.assertIn("Before the leadership meeting", [o["label"] for o in timeres.build_options(self.core, self.task(tid))])
        self.clock.advance(hours=4)
        self.assertNotIn("Before the leadership meeting", [o["label"] for o in timeres.build_options(self.core, self.task(tid))])
        scheduler.suggest_schedule(self.core, tid, moment(cancelled=True), "")
        self.assertNotIn("Before the leadership meeting",
                         [o["label"] for o in self.card_for(tid, "task")["schedule_options"]])


class WhenItChanges(CoreCase):
    def scheduled(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers")
        scheduler.suggest_schedule(self.core, tid, LEADERSHIP, "found on the calendar")
        card = self.card_for(tid, "task")
        answers.answer(self.core, card["id"], "schedule", {"anchor": card["schedule_options"][0]["anchor"]})
        self.assertEqual(self.task(tid)["schedule_fire_at"], "2026-10-30T09:00:00Z")
        return tid

    def test_a_moved_moment_moves_the_task(self):
        tid = self.scheduled()
        before = self.last_event_id()
        tools_moved = moment(at="2026-10-29T15:00:00Z")
        scheduler.suggest_schedule(self.core, tid, tools_moved, "rescheduled")
        self.assertEqual(self.types_since(before), ["task.schedule_suggested", "task.anchor_moved"])
        t = self.task(tid)
        self.assertEqual((t["state"], t["schedule_fire_at"]), ("scheduled", "2026-10-29T15:00:00Z"))
        self.assertEqual(events.task_log(self.core, tid, 1)[0]["text"],
                         "Before the leadership meeting moved to Thu 3:00 PM.")
        self.clock.advance(days=9, hours=6)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["state"], "triage")

    def test_a_cancelled_moment_brings_the_task_back(self):
        tid = self.scheduled()
        before = self.last_event_id()
        scheduler.suggest_schedule(self.core, tid, moment(cancelled=True), "")
        self.assertIn("task.anchor_lost", self.types_since(before))
        t = self.task(tid)
        self.assertEqual(t["state"], "triage")
        self.assertIn("returning", t["variant_tags"])
        self.assertEqual(t["reason"], "Before the leadership meeting was cancelled.")
        self.card_for(tid, "task")

    def test_picking_uses_the_moment_as_it_stands(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers")
        scheduler.suggest_schedule(self.core, tid, LEADERSHIP, "")
        card = self.card_for(tid, "task")
        stale = card["schedule_options"][0]["anchor"]
        scheduler.suggest_schedule(self.core, tid, moment(at="2026-10-29T15:00:00Z"), "moved")
        answers.answer(self.core, card["id"], "schedule", {"anchor": stale})
        self.assertEqual(self.task(tid)["schedule_fire_at"], "2026-10-29T15:00:00Z")

    def test_undo_and_replay(self):
        tid = self.scheduled()
        scheduler.suggest_schedule(self.core, tid, moment(cancelled=True), "")
        self.assertEqual(events.check_replay(self.core), [])
        answers.answer(self.core, self.card_for(tid, "task")["id"], "park")
        events.undo(self.core)
        self.assertEqual(self.task(tid)["state"], "triage")


class HandingIn(CoreCase):
    def test_extracted_ask_carries_moments(self):
        tools.submit_signals(self.core, [{
            "source": "email", "source_id": "q4", "anchor": "email:q4", "ts": "2026-10-20T08:00:00Z",
            "from": {"name": "Elena Park"}, "quote": "Can you have the Q4 numbers before leadership?",
            "candidates": [{"ask": "Prep the Q4 numbers", "moments": [
                {"label": "Before the leadership meeting", "at": "2026-10-30T09:00:00Z"},
                {"label": "Already over", "at": "2026-10-01T09:00:00Z"}]}]}])
        t = self.core.one("SELECT * FROM tasks")
        self.assertEqual([h["label"] for h in t["schedule_hints"]], ["Before the leadership meeting"],
                         "a moment that fails the check is dropped without a word")
        self.assertEqual(cards.view(self.core, self.card_for(t["id"], "task"))["schedule_options"][0]["label"],
                         "Before the leadership meeting")

    def test_three_moments_on_an_ask_is_a_schema_error(self):
        m = {"label": "x", "at": "2026-10-30T09:00:00Z"}
        with self.assertRaises(FuzzError) as e:
            tools.submit_signals(self.core, [{"source": "email", "source_id": "1", "candidates": [
                {"ask": "Prep", "moments": [m, m, m]}]}])
        self.assertEqual(e.exception.field, "signals[0].candidates[0].moments")

    def test_executor_hands_in_a_moment(self):
        tid = tasks.capture(self.core, "Prep the Q4 numbers")
        tasks.assign(self.core, tid)
        tools.claim_next_task(self.core)
        self.assertEqual(tools.suggest_schedule(self.core, tid, LEADERSHIP, "on your calendar")["label"],
                         "Before the leadership meeting")


class OverHttp(CoreCase):
    def test_you_hand_in_a_moment_in_your_time_zone(self):
        cfg = self.core.config
        cfg["tz"] = "America/Los_Angeles"
        self.core.save_config(cfg)
        srv = http_api.make_server(self.home, port=0, clock=self.clock, ticker=False)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        app = srv.app
        tid = tasks.capture(self.core, "Prep the Q4 numbers")
        core = app.core(1)
        res = app.add_moment(core, _M(tid), {"label": "Before the leadership meeting", "at": "2026-10-30T09:00"}, {})
        self.assertEqual(res[1], 201)
        self.assertEqual(self.task(tid)["schedule_hints"][0]["at"], "2026-10-30T16:00:00Z", "9 AM Pacific")
        other = self.make_core(2)
        with self.assertRaises(FuzzError):
            app.add_moment(app.core(2), _M(tid), {"label": "x", "at": "2026-10-30T09:00"}, {})
        self.assertEqual(tasks.list_tasks(other), [])


class _M:
    def __init__(self, tid):
        self.tid = tid

    def group(self, i):
        return str(self.tid)


class AtDesk(CoreCase):
    def test_watcher_fires_once_after_time_away(self):
        w = presence.Watcher(away_minutes=15)
        readings = [5, 300, 600, 30, 2, 800, 20, 5]   # seconds idle, every 30 s or so
        self.assertEqual([w.check(x) for x in readings], [False] * 8, "short breaks don't count")
        w = presence.Watcher(away_minutes=15)
        readings = [5, 600, 901, 1500, 3, 2, 10]
        self.assertEqual([w.check(x) for x in readings], [False, False, False, False, True, False, False])
        self.assertFalse(presence.Watcher().check(None), "no idle time, nothing happens")

    def test_back_at_desk_brings_at_desk_tasks_back(self):
        tid = tasks.capture(self.core, "Call the venue")
        card = self.card_for(tid, "task")
        answers.answer(self.core, card["id"], "schedule", {"anchor": {"type": "at_desk"}})
        app = http_api.App(self.home, self.clock)
        http_api.ensure_token(self.home, 1)
        w = presence.Watcher(15)
        self.assertEqual(http_api.presence_check(app, w, 1200), 0)
        self.assertEqual(http_api.presence_check(app, w, 4), 1)
        self.assertEqual(self.task(tid)["state"], "triage")


if __name__ == "__main__":
    unittest.main()
