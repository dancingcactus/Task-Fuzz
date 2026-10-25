"""Choosing the next task: at most five working, deterministic order, leases and the step budget."""

import unittest

from helpers import CoreCase

from fuzz import scheduler, tasks
from fuzz.db import FuzzError


class Claiming(CoreCase):
    def queued(self, n, **kw):
        out = []
        for i in range(n):
            tid = tasks.capture(self.core, f"Task {len(out)} {i}", **kw)
            tasks.assign(self.core, tid)
            out.append(tid)
        return out

    def test_at_most_five_working(self):
        ids = self.queued(6)
        for i in range(5):
            t, why = scheduler.claim_next(self.core)
            self.assertEqual(t["id"], ids[i])
        t, why = scheduler.claim_next(self.core)
        self.assertIsNone(t)
        self.assertIn("5 tasks are already running", why)
        self.assertEqual(self.task(ids[5])["state"], "queued", "the sixth is Next up")

    def test_deadline_first_then_order(self):
        plain = self.queued(1)[0]
        urgent = tasks.capture(self.core, "Urgent", due="2026-10-20T10:00:00Z")
        tasks.assign(self.core, urgent)
        t, _ = scheduler.claim_next(self.core)
        self.assertEqual(t["id"], urgent)
        t, _ = scheduler.claim_next(self.core)
        self.assertEqual(t["id"], plain)

    def test_a_crashed_worker_gives_the_task_back(self):
        tid = self.queued(1)[0]
        scheduler.claim_next(self.core)
        self.clock.advance(minutes=11)
        scheduler.tick(self.core)
        t = self.task(tid)
        self.assertEqual((t["state"], t["lease_owner"]), ("queued", None))

    def test_writes_renew_the_lease(self):
        from fuzz import tools
        tid = self.queued(1)[0]
        tools.claim_next_task(self.core)
        self.clock.advance(minutes=8)
        tools.log_step(self.core, tid, "research", "Read the thread")
        self.clock.advance(minutes=8)
        self.assertEqual(tools.get_task(self.core, tid)["id"], tid, "still held: the step renewed the lease")

    def test_only_the_holder_can_write(self):
        from fuzz import tools
        tid = self.queued(1)[0]
        with self.assertRaises(FuzzError) as e:
            tools.log_step(self.core, tid, "research", "Sneaky")
        self.assertEqual(e.exception.field, "task_id")
        tools.claim_next_task(self.core)
        other = self.make_core()
        other.run = {"id": 999}
        with self.assertRaises(FuzzError):
            tools.save_notes(other, tid, "not mine")

    def test_step_budget_hands_back(self):
        cfg = self.core.config
        cfg["budget"]["max_steps"] = 3
        self.core.save_config(cfg)
        tid = self.queued(1)[0]
        scheduler.claim_next(self.core)
        for i in range(3):
            res = scheduler.log_step(self.core, tid, "research", f"Step {i}")
        self.assertTrue(res["handed_back"])
        t = self.task(tid)
        self.assertEqual(t["state"], "triage")
        self.assertIn("handed_back", t["variant_tags"])
        actor = self.core.one("SELECT actor FROM events WHERE type='task.handed_back'")["actor"]
        self.assertEqual(actor, "system")

    def test_a_run_does_not_get_back_what_it_released(self):
        tid = self.queued(1)[0]
        self.core.run = {"id": 1}
        scheduler.claim_next(self.core)
        scheduler.release(self.core, tid)
        self.assertEqual(scheduler.claim_next(self.core), (None, "Nothing is queued for Fuzz"))
        self.core.run = {"id": 2}
        self.assertEqual(scheduler.claim_next(self.core)[0]["id"], tid, "the next run does")

    def test_claims_without_progress_hand_back(self):
        tid = self.queued(1)[0]
        for run in range(3):   # three runs in a row claim it and give up
            self.core.run = {"id": run + 1}
            scheduler.claim_next(self.core)
            scheduler.release(self.core, tid)
        self.core.run = {"id": 4}
        t, why = scheduler.claim_next(self.core)
        self.assertIsNone(t)
        self.assertEqual(self.task(tid)["state"], "triage")
        self.assertIn("stuck", self.task(tid)["question"])

    def test_permission_blocks_claims_until_answered(self):
        from fuzz import answers, drafts
        tid = self.queued(1)[0]
        scheduler.claim_next(self.core)
        res = drafts.request_permission(self.core, tid, "connector", "Calendar", "To find a free room")
        self.assertEqual(scheduler.claim_next(self.core)[0], None)
        answers.answer(self.core, res["card_id"], "allow_once")
        self.assertEqual(scheduler.claim_next(self.core)[0]["id"], tid)


if __name__ == "__main__":
    unittest.main()
