"""What the executor gets and can say: the time it works in, renames, results, prep notes and gathering."""

import unittest
from unittest import mock

from helpers import CoreCase

from fuzz import answers, cards, config, events, scheduler, tasks, tools
from fuzz.db import FuzzError


class Claimed(CoreCase):
    def claimed(self, text="Next week I need to send out an update on the launch"):
        tid = tasks.capture(self.core, text)
        tasks.assign(self.core, tid)
        t, why = scheduler.claim_next(self.core, tid)
        self.assertEqual((t or {}).get("id"), tid, why)
        return tid


class Time(Claimed):
    def test_whoami_says_today_and_the_time_zone(self):
        cfg = self.core.config
        cfg["tz"] = "America/Denver"
        self.core.save_config(cfg)
        me = tools.whoami(self.core, "executor")
        self.assertEqual((me["today"], me["tz"]), ("Tuesday 2026-10-20", "America/Denver"))
        self.assertEqual(me["local_time"], "2026-10-20T03:00-06:00")

    def test_the_task_says_when_it_was_captured(self):
        tid = self.claimed()
        self.clock.advance(minutes=5)
        self.assertEqual(tools.get_task(self.core, tid)["created_at"], "2026-10-20T09:00:00Z")

    def test_the_executor_sets_the_due_date(self):
        tid = self.claimed()
        tools.update_brief(self.core, tid, due="2026-10-27")
        self.assertEqual(self.task(tid)["due"], "2026-10-27T17:00:00Z", "a bare date is the end of that working day")
        tools.update_brief(self.core, tid, due="2026-10-27T10:30")
        self.assertEqual(self.task(tid)["due"], "2026-10-27T10:30:00Z")
        with self.assertRaises(FuzzError) as e:
            tools.update_brief(self.core, tid, due="next week")
        self.assertEqual(e.exception.field, "due")


class Rename(Claimed):
    def test_a_rename_is_logged_and_undone_on_its_own(self):
        tid = self.claimed("Can you summarize my last 5 slack threads?")
        r = tools.update_brief(self.core, tid, title="Summarize my last 5 emails", ask="Summarize my last 5 emails",
                               context_md="**Five emails**")
        self.assertEqual(r["updated"], ["ask", "context_md", "title"])
        t = self.task(tid)
        self.assertEqual((t["title"], t["title_history"]), ("Summarize my last 5 emails",
                                                            ["Can you summarize my last 5 slack threads?"]))
        self.assertEqual(events.task_log(self.core, tid, 1)[0]["text"],
                         "Renamed “Can you summarize my last 5 slack threads?” to “Summarize my last 5 emails”.")
        top = events.undo_list(self.core)[0]
        self.assertEqual((top["type"], top["by"]), ("task.retitled", "fuzz:executor"))
        events.undo(self.core, top["group"])
        t = self.task(tid)
        self.assertEqual(t["title"], "Can you summarize my last 5 slack threads?")
        self.assertEqual(t["context_md"], "**Five emails**", "Undo takes back the rename, not the brief")
        self.assertEqual(t["state"], "working", "and leaves the task where it is")
        self.assertEqual(events.check_replay(self.core), [])

    def test_the_same_title_changes_nothing(self):
        tid = self.claimed("Summarize my last 5 emails")
        self.assertEqual(tools.update_brief(self.core, tid, title="Summarize my last 5 emails")["updated"], [])
        self.assertNotEqual(events.undo_list(self.core)[0]["type"], "task.retitled")


class Result(Claimed):
    def test_a_result_leads_with_done(self):
        tid = self.claimed("Summarize the launch thread")
        with self.assertRaises(FuzzError) as e:
            tools.hand_back(self.core, tid, result=True)
        self.assertEqual(e.exception.field, "result", "the brief comes first")
        tools.update_brief(self.core, tid, context_md="**Launch**: moved to the 14th.")
        with self.assertRaises(FuzzError):
            tools.hand_back(self.core, tid, options=["Dig into the date", "Draft a reply"], result=True)
        tools.hand_back(self.core, tid, options=["Dig into the date"], result=True)
        card = self.card_for(tid, "task")
        v = cards.view(self.core, card)
        self.assertEqual((v["suggested"], v["prompt"]), ("done", scheduler.RESULT_PROMPT))
        self.assertIn("result", v["task"]["variant_tags"])
        answers.answer(self.core, card["id"], "done")
        self.assertEqual(self.task(tid)["state"], "done")
        self.assertNotIn("result", self.task(tid)["variant_tags"])


class PrepNote(Claimed):
    def test_a_prep_note_needs_to_know_when(self):
        tid = self.claimed()
        with self.assertRaises(FuzzError) as e:
            tools.save_draft(self.core, tid, "note", "", "Launch update outline", final=False)
        self.assertEqual(e.exception.field, "final")
        with self.assertRaises(FuzzError):
            tools.save_draft(self.core, tid, "email.new", "team@acme.com", "Update", final=False)

    def test_approving_prep_schedules_the_real_step(self):
        tid = self.claimed()
        tools.suggest_schedule(self.core, tid, {"type": "moment", "key": "send-update", "label": "Monday, to send",
                                                "at": "2026-10-26T09:00:00Z"}, "Next week from the capture")
        tools.save_draft(self.core, tid, "note", "", "Launch update outline", final=False)
        card = self.card_for(tid, "draft")
        self.assertEqual(cards.view(self.core, card)["after_approve"],
                         "Filed. Back for the next step: Monday, to send.")
        answers.answer(self.core, card["id"], "approve")
        t = self.task(tid)
        self.assertEqual((t["state"], t["schedule_fire_at"]), ("scheduled", "2026-10-26T09:00:00Z"))
        events.undo(self.core)
        self.assertEqual(self.task(tid)["state"], "review", "Undo takes the approval back")
        answers.answer(self.core, card["id"], "approve")
        self.clock.advance(days=6, hours=1)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["state"], "triage", "it comes back when the step is due")
        self.assertEqual(events.check_replay(self.core), [])

    def test_prep_falls_back_to_the_due_date(self):
        tid = self.claimed()
        tools.update_brief(self.core, tid, due="2026-10-27")
        tools.save_draft(self.core, tid, "note", "", "Launch update outline", final=False)
        answers.answer(self.core, self.card_for(tid, "draft")["id"], "approve")
        self.assertEqual(self.task(tid)["state"], "scheduled")

    def test_a_final_note_still_closes_the_task(self):
        tid = self.claimed("Summarize the launch thread")
        tools.save_draft(self.core, tid, "note", "", "The summary")
        card = self.card_for(tid, "draft")
        self.assertEqual(cards.view(self.core, card)["after_approve"], "Filed, and the task is done.")
        answers.answer(self.core, card["id"], "approve")
        self.assertEqual(self.task(tid)["state"], "done")


class Identities(CoreCase):
    def test_every_address_is_yours(self):
        cfg = self.core.config
        config.update_me(cfg, add={"emails": ["Justin@Home.example", "jgrover@adobe.com"], "slack_ids": ["W2"]})
        self.core.save_config(cfg)
        me = tools.whoami(self.core, "executor")
        self.assertEqual(me["emails"], ["jgrover@adobe.com", "justin@home.example"])
        self.assertEqual(me["slack_ids"], ["W2", "W4R5SVCU9"])
        config.update_me(cfg, remove={"slack_ids": ["W2"]}, replace={"names": ["Justin", " "]})
        self.assertEqual((cfg["me"]["slack_ids"], cfg["me"]["names"]), (["W4R5SVCU9"], ["Justin"]))


class Gathering(CoreCase):
    def gathered(self, text="Prepare for my 1:1 with Sydnee"):
        tid = tasks.capture(self.core, text, gather=True)
        t, why = scheduler.claim_next(self.core)
        self.assertEqual((t or {}).get("id"), tid, why)
        return tid

    def test_a_capture_waits_for_fuzz_before_triage(self):
        tid = tasks.capture(self.core, "Prepare for my 1:1 with Sydnee", gather=True)
        t = self.task(tid)
        self.assertEqual((t["state"], t["assignee"], t["variant_tags"]), ("queued", "fuzz", ["gather"]))
        self.assertEqual(cards.open_cards(self.core, tid), [], "nothing is asked yet")

    def test_gathering_goes_first(self):
        old = tasks.capture(self.core, "Book the room")
        tasks.assign(self.core, old)
        self.clock.advance(minutes=1)
        tid = self.gathered()
        self.assertTrue(tools.get_task(self.core, tid)["gathering"])
        self.assertEqual(self.task(old)["state"], "queued")

    def test_the_brief_reaches_triage_with_the_card(self):
        tid = self.gathered()
        tools.log_step(self.core, tid, "research", "Found three open items with Sydnee in Glean.")
        tools.update_brief(self.core, tid, context_md="## Open items\n\n1. Estimates", summary="Three open items.")
        self.assertEqual(tools.finish_gathering(self.core, tid), {"state": "triage"})
        t = self.task(tid)
        self.assertEqual((t["state"], t["assignee"], t["variant_tags"]), ("triage", "human", []))
        self.assertEqual((t["summary"], t["lease_owner"]), ("Three open items.", None))
        self.assertEqual(self.card_for(tid, "task")["suggested"], "assign")
        log = events.task_log(self.core, tid)
        self.assertEqual(log[0]["text"], "Fuzz gathered what it could find.")
        self.assertEqual(log[-2]["text"], "Fuzz is gathering context.")
        tasks.assign(self.core, tid)
        t, _ = scheduler.claim_next(self.core, tid)
        self.assertFalse(tools.get_task(self.core, tid)["gathering"], "once assigned it's ordinary work")

    def test_gathering_asks_nothing_and_sends_nothing(self):
        tid = self.gathered()
        for call in (lambda: tools.hand_back(self.core, tid, "Which Sydnee?"),
                     lambda: tools.save_draft(self.core, tid, "note", "", "Agenda"),
                     lambda: tools.request_permission(self.core, tid, "connector", "Glean", "To look her up"),
                     lambda: tools.create_task(self.core, "Book a room", parent_task_id=tid)):
            with self.assertRaises(FuzzError) as e:
                call()
            self.assertEqual(e.exception.status, 409)
        self.assertEqual(self.task(tid)["state"], "working")
        with self.assertRaises(FuzzError):
            tools.finish_gathering(self.core, tasks.capture(self.core, "Not gathered"))

    def test_a_stuck_gather_comes_to_you_as_captured(self):
        tid = self.gathered()
        self.clock.advance(minutes=11)   # the run died: the lease ran out
        out = scheduler.tick(self.core)
        self.assertEqual((out["released"], out["gather_timeout"]), (1, 1))
        t = self.task(tid)
        self.assertEqual((t["state"], t["variant_tags"]), ("triage", []))
        self.assertEqual(events.task_log(self.core, tid)[0]["text"],
                         "Fuzz didn't get to this in time, so it came to you as captured.")
        self.card_for(tid, "task")

    def test_too_many_tries_comes_to_you_without_a_question(self):
        tid = tasks.capture(self.core, "Prepare for my 1:1", gather=True)
        for run in range(self.core.config["budget"]["max_attempts"] + 1):
            with mock.patch.object(scheduler, "SESSION_OWNER", f"session:run{run}"):   # each try a new run
                t, _ = scheduler.claim_next(self.core)
                if t:
                    tools.release(self.core, tid)
        self.assertIsNone(t)
        t = self.task(tid)
        self.assertEqual((t["state"], t["question"]), ("triage", None))
        self.assertNotIn("handed_back", t["variant_tags"])

    def test_you_can_take_it_back_while_fuzz_gathers(self):
        tid = self.gathered()
        tasks.done(self.core, tid)
        self.assertEqual(self.task(tid)["variant_tags"], [])

    def test_gathers_only_with_an_executor_to_run_it(self):
        cfg = self.core.config
        self.assertFalse(config.gathers(cfg))
        cfg["engine"]["client"] = "copilot"
        self.assertTrue(config.gathers(cfg))
        cfg["gather"]["enabled"] = False
        self.assertFalse(config.gathers(cfg))


if __name__ == "__main__":
    unittest.main()
