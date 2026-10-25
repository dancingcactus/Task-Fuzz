"""The log is the source of truth: replay rebuilds the projection, Undo compensates, and AI events say who made them."""

import unittest

from helpers import CoreCase, fixture

from fuzz import answers, events, runs, scheduler, states, tasks, tools
from fuzz.db import FuzzError


class Replay(CoreCase):
    def test_rebuild_matches_after_a_mixed_scenario(self):
        tools.submit_signals(self.core, fixture("day1.json"))
        a = tasks.capture(self.core, "Do the corporate compliance video", docs=["Training link.pdf"])
        answers.answer(self.core, self.card_for(a, "task")["id"], "assign", {"instructions": "Find the deadline"})
        tools.claim_next_task(self.core)
        tools.update_brief(self.core, a, context_md="**Video**", question="Book time?")
        tools.log_step(self.core, a, "research", "Found it")
        tools.save_draft(self.core, a, "note", "", "Plan")
        answers.answer(self.core, self.card_for(a, "draft")["id"], "send_back", "Shorter")
        b = tasks.capture(self.core, "Reply to Dana")
        answers.answer(self.core, self.card_for(b, "task")["id"], "park")
        events.undo(self.core)
        scheduler.tick(self.core)
        self.clock.advance(days=9)
        scheduler.tick(self.core)
        self.assertEqual(events.check_replay(self.core), [])

    def test_every_task_row_records_its_last_event(self):
        a = tasks.capture(self.core, "One")
        last = self.core.one("SELECT MAX(id) m FROM events WHERE task_id=? AND type!='card.created'", (a,))["m"]
        self.assertEqual(self.task(a)["updated_event_id"], last)

    def test_illegal_moves_are_refused(self):
        a = tasks.capture(self.core, "One")
        tasks.done(self.core, a)
        with self.assertRaises(FuzzError):
            tasks.park(self.core, a)
        with self.assertRaises(FuzzError):
            states.check("merged", "triage")


class Undo(CoreCase):
    def test_undo_writes_a_compensating_event_and_never_deletes(self):
        a = tasks.capture(self.core, "One")
        n = self.core.one("SELECT COUNT(*) n FROM events")["n"]
        answers.answer(self.core, self.card_for(a, "task")["id"], "done")
        res = events.undo(self.core)
        self.assertEqual(self.task(a)["state"], "triage")
        self.assertGreater(self.core.one("SELECT COUNT(*) n FROM events")["n"], n + 1)
        restored = self.core.one("SELECT * FROM events WHERE id=?", (res["event_id"],))
        self.assertEqual(restored["type"], "task.restored")

    def test_undo_twice_goes_further_back(self):
        a = tasks.capture(self.core, "One")
        answers.answer(self.core, self.card_for(a, "task")["id"], "assign")
        tasks.done(self.core, a)
        events.undo(self.core)
        self.assertEqual(self.task(a)["state"], "queued")
        events.undo(self.core)
        self.assertEqual(self.task(a)["state"], "triage")

    def test_ai_work_is_not_undone_by_your_undo(self):
        a = tasks.capture(self.core, "One")
        tasks.assign(self.core, a)
        tools.claim_next_task(self.core)
        tools.log_step(self.core, a, "research", "Did a thing")
        events.undo(self.core)   # undoes your assign... which the AI's claim came after
        self.assertEqual([g["type"] for g in events.undo_list(self.core)], ["task.captured"])

    def test_undo_a_merge_splits_it(self):
        from fuzz import cards, matching
        a = tasks.capture(self.core, "Finish the pricing deck review")
        b = tasks.capture(self.core, "Review the Q4 pricing deck")
        self.core.q("INSERT INTO sources (user_id, task_id, role, title) VALUES (1,?,'attachment','deck.pdf')", (a,))
        with self.core.tx("fuzz:extractor"):
            cid = cards.create(self.core, "duplicate", a, other_id=b)
        answers.answer(self.core, cid, "merge")
        self.assertEqual(tasks.live(self.core, a)["id"], b)
        self.assertEqual(self.core.one("SELECT task_id FROM sources WHERE title='deck.pdf'")["task_id"], b)
        events.undo(self.core)
        self.assertEqual(self.task(a)["state"], "triage")
        self.assertEqual(self.core.one("SELECT task_id FROM sources WHERE title='deck.pdf'")["task_id"], a)
        self.assertEqual(self.core.one("SELECT undone FROM merges")["undone"], 1)
        self.assertEqual([r["kind"] for r in self.core.all("SELECT kind FROM feedback ORDER BY id")], ["merge", "split"])
        self.assertEqual(matching.MATCHER_VERSION, "core-0.1")


class WhoMadeIt(CoreCase):
    def test_ai_events_carry_run_model_and_prompt_version(self):
        a = tasks.capture(self.core, "One")
        tasks.assign(self.core, a)
        rid = runs.start(self.core, "executor", "claude-code", "some-model", "executor-0.1")
        runs.attach(self.core, rid)
        tools.claim_next_task(self.core)
        tools.log_step(self.core, a, "action", "Drafted")
        rows = self.core.all("SELECT actor, run_id, model, prompt_version FROM events WHERE type IN ('task.claimed','task.step')")
        self.assertEqual(rows, [{"actor": "fuzz:executor", "run_id": rid, "model": "some-model",
                                 "prompt_version": "executor-0.1"}] * 2)
        runs.finish(self.core, rid, "ok")
        self.assertEqual(runs.get(self.core, rid)["detail"]["tasks"], [a])

    def test_whoami_with_a_prompt_version_starts_a_chat_run(self):
        out = tools.whoami(self.core, "executor", prompt_version="executor-0.1", client="claude-code")
        self.assertEqual(out["names"], ["Justin"])
        self.assertEqual(runs.get(self.core, out["run_id"])["trigger"], "chat")


if __name__ == "__main__":
    unittest.main()
