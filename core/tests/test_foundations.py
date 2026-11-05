"""Step 12: a size on every brief and ask, the same-run duplicate check on the rule-made path, a late ask
joining a group reply that waits for your OK, and covered tasks following their draft when it's put off."""

import unittest

from helpers import CoreCase

from fuzz import answers, cards, config, scheduler, tasks, tools
from fuzz.db import FuzzError


def email(n, asks, conv="AAQk1", ts="2026-10-20T09:00:00Z", **extra):
    return {"source": "email", "source_id": f"msg{n}", "anchor": f"email:{conv}", "ts": ts, "title": "Re: Offsite plan",
            "from": {"name": "Dana Reyes", "email": "dana@acme.com"}, "link": f"https://mail/{n}",
            "quote": "Can you take these?", "candidates": [dict({"ask": a, "owner": "me"}, **extra) for a in asks]}


class Foundations(CoreCase):
    def tid(self, words):
        return next(t["id"] for t in tasks.list_tasks(self.core) if words.lower() in t["title"].lower())

    # ---- size
    def test_a_brief_from_fuzz_comes_with_its_size(self):
        tid = tasks.capture(self.core, "Plan the offsite")
        tasks.assign(self.core, tid)
        tools.claim_next_task(self.core)
        with self.assertRaises(FuzzError) as e:
            tools.update_brief(self.core, tid, context_md="## Plan")
        self.assertEqual(e.exception.field, "effort_mins")
        tools.update_brief(self.core, tid, context_md="## Plan", effort_mins=90, steps=6)
        t = self.task(tid)
        self.assertEqual((t["effort_mins"], t["step_count"]), (90, 6))
        tools.update_brief(self.core, tid, context_md="## Plan, again")   # the size is already on the task
        self.assertEqual(cards.task_summary(self.task(tid))["step_count"], 6)

    def test_an_extracted_ask_carries_its_estimate(self):
        tools.submit_signals(self.core, [email(1, ["Book the venue for the offsite"], effort_mins=30, steps=3)])
        t = self.task(self.tid("venue"))
        self.assertEqual((t["effort_mins"], t["step_count"]), (30, 3))

    # ---- the same run, on the rule-made path
    def test_two_same_asks_in_one_run_with_nothing_older_to_judge_against(self):
        cfg = config.load(self.home)
        cfg["embedder"], cfg["ollama_url"] = "ollama", "http://127.0.0.1:9"   # Ollama down: no meaning to measure
        config.save(self.home, cfg)
        core = self.make_core()
        a = email(1, ["Confirm whether activities may link to one goal or many"], conv="A")
        b = dict(email(2, ["Confirm whether activities may link to one goal or many"], conv="B"),
                 **{"from": {"name": "Wiki", "email": "wiki@example.com"}})   # nothing in common but the words
        out = tools.submit_signals(core, [a, b])
        self.assertEqual(out["outcomes"], {"new": 1, "possible_duplicate": 1})
        first, second = sorted(t["id"] for t in tasks.list_tasks(core))
        self.assertEqual(self.card_for(second, "duplicate", core=core)["other_id"], first)

    # ---- step 11 leftovers
    def _group_reply(self):
        tools.submit_signals(self.core, [email(1, ["Book the venue for the offsite", "Order lunch for twelve"])])
        for w in ("venue", "lunch"):
            answers.answer(self.core, self.card_for(self.tid(w))["id"], "assign")
        main = tools.claim_next_task(self.core)["task"]["id"]
        tools.save_draft(self.core, main, "note", None, "Venue and lunch, both sorted.", covers=[self.tid("lunch")])
        return main

    def test_a_late_ask_can_join_the_reply_waiting_for_your_ok(self):
        main = self._group_reply()
        self.clock.advance(hours=1)
        tools.submit_signals(self.core, [email(2, ["Print name badges for everyone"], ts="2026-10-20T10:00:00Z")])
        tools.submit_verdicts(self.core, [{"candidate_id": i["candidate_id"], "verdict": "new", "confidence": 0.9}
                                          for i in tools.get_pending_judgments(self.core)["items"]])
        late = self.tid("badges")
        c = self.card_for(late, "task")
        self.assertEqual(c["suggested"], "add_to_reply")
        self.assertIn("add_to_reply", cards.options(c, self.task(late)))
        self.assertIn("waiting for your OK", c["reason"])
        answers.answer(self.core, c["id"], "add_to_reply")
        self.assertEqual({self.task(i)["state"] for i in (main, self.tid("lunch"), late)}, {"queued"})
        self.assertEqual(self.core.one("SELECT status FROM drafts WHERE task_id=?", (main,))["status"], "sent_back")
        tools.claim_next_task(self.core)
        self.assertEqual({self.task(i)["state"] for i in (main, self.tid("lunch"), late)}, {"working"})

    def test_covered_tasks_follow_their_draft_when_its_put_off(self):
        main = self._group_reply()
        c = self.card_for(main, "draft")
        anchor = c["schedule_options"][0]["anchor"]
        answers.answer(self.core, c["id"], "schedule", {"anchor": anchor})
        lunch = self.task(self.tid("lunch"))
        self.assertEqual((self.task(main)["state"], lunch["state"]), ("scheduled", "scheduled"))
        self.clock.t = scheduler.parse_iso(lunch["schedule_fire_at"])
        scheduler.tick(self.core)
        self.assertEqual((self.task(main)["state"], self.task(self.tid("lunch"))["state"]), ("review", "review"))
        self.assertEqual([x["kind"] for x in self.open_cards()], ["draft"])


if __name__ == "__main__":
    unittest.main()
