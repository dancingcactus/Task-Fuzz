"""Working sessions: a size on cards, a big task's four choices, Later vs Book time, Do it now and the working
card, After the others, "What's in the way?", and the screen-time record."""

import unittest

from helpers import CoreCase
from test_http import Server

from fuzz import answers, cards, scheduler, tasks, tools
from fuzz.db import FuzzError, parse_iso


class Sessions(CoreCase):
    def sized(self, title, mins, steps, **kw):
        tid = tasks.capture(self.core, title, **kw)
        tasks.update_brief(self.core, tid, effort_mins=mins, steps=steps, actor="human")
        with self.core.tx("system"):   # its card was made before the size: make it again
            for c in cards.open_cards(self.core, tid):
                self.core.q("UPDATE cards SET status='withdrawn' WHERE id=?", (c["id"],))
            cards.sync(self.core, tid)
        return tid

    def view(self, tid):
        return cards.view(self.core, self.card_for(tid, "task"))

    def front(self):
        return [t["title"] for _, t in cards.queue(self.core)]

    # ---- size and big tasks
    def test_a_big_task_shows_its_size_and_leads_with_the_four_choices(self):
        big = self.sized("Write the Q4 readout", 90, 6)
        v = self.view(big)
        self.assertEqual(v["size"]["label"], "≈ 1½ h · 6 steps")
        self.assertTrue(v["size"]["big"])
        self.assertEqual(v["lead"], ["do_now", "book", "after_others", "first_step"])
        self.assertEqual(v["suggested"], "book")
        self.assertTrue(v["book_options"])
        small = self.sized("Reply to Marcus", 10, 1)
        v = self.view(small)
        self.assertEqual((v["size"]["label"], v.get("lead"), v["suggested"]), ("≈ 10 min · 1 step", None, "assign"))

    # ---- Later and Book time
    def test_later_counts_toward_keeps_coming_back_and_book_time_doesnt(self):
        tid = self.sized("Write the Q4 readout", 90, 6)
        for _ in range(3):
            c = self.card_for(tid, "task")
            answers.answer(self.core, c["id"], "schedule", {"anchor": c["schedule_options"][0]["anchor"]})
            self.clock.t = parse_iso(self.task(tid)["schedule_fire_at"])
            scheduler.tick(self.core)
        self.assertIn("put_off", self.task(tid)["variant_tags"])
        answers.answer(self.core, self.card_for(tid, "task")["id"], "now")
        reschedules = self.task(tid)["reschedules"] or 0
        v = self.view(tid)
        answers.answer(self.core, v["id"], "book", {"anchor": v["book_options"][0]["anchor"]})
        t = self.task(tid)
        self.assertEqual((t["state"], t["schedule_anchor"]["type"]), ("scheduled", "block"))
        self.assertIn("booked", t["variant_tags"])
        self.assertEqual(t["reschedules"] or 0, reschedules)
        self.clock.t = parse_iso(t["schedule_fire_at"])
        scheduler.tick(self.core)
        t = self.task(tid)
        self.assertEqual(t["state"], "triage")
        self.assertIn("doing", t["variant_tags"])
        self.assertNotIn("put_off", t["variant_tags"])
        self.assertEqual(self.card_for(tid, "task")["suggested"], "done")

    def test_during_a_block_its_task_is_first_and_a_deadline_second(self):
        tid = self.sized("Write the Q4 readout", 90, 6)
        v = self.view(tid)
        answers.answer(self.core, v["id"], "book", {"anchor": v["book_options"][0]["anchor"]})
        start = parse_iso(self.task(tid)["schedule_fire_at"])
        self.clock.t = start
        tasks.capture(self.core, "Sign the contract", due=(start.replace(minute=30)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        tasks.capture(self.core, "Renew the parking permit")
        scheduler.tick(self.core)
        self.assertEqual(self.front()[:2], ["Write the Q4 readout", "Sign the contract"])

    def test_book_time_never_double_books(self):
        a, b = self.sized("Write the readout", 90, 6), self.sized("Plan the offsite", 60, 4)
        v = self.view(a)
        slot = v["book_options"][0]["anchor"]
        answers.answer(self.core, v["id"], "book", {"anchor": slot})
        self.assertNotIn(slot["start"], [o["anchor"]["start"] for o in self.view(b)["book_options"]])
        with self.assertRaises(FuzzError):
            answers.answer(self.core, self.view(b)["id"], "book", {"anchor": slot})

    # ---- Do it now and the working card
    def test_do_it_now_opens_the_working_card_first_and_pause_puts_it_back(self):
        tasks.capture(self.core, "Renew the parking permit")
        tid = self.sized("Write the Q4 readout", 90, 6)
        answers.answer(self.core, self.card_for(tid)["id"], "do_now")
        c = self.card_for(tid, "task")
        self.assertEqual(cards.options(c, self.task(tid)), ["done", "pause", "assign", "session", "book", "find_out"])
        self.assertEqual(self.front()[0], "Write the Q4 readout")
        answers.answer(self.core, c["id"], "pause", "Drafted the intro; numbers next")
        t = self.task(tid)
        self.assertNotIn("doing", t["variant_tags"])
        self.assertIn("Where I left off: Drafted the intro; numbers next", t["notes"])
        self.assertEqual(self.front(), ["Renew the parking permit", "Write the Q4 readout"])

    # ---- After the others
    def test_after_the_others_goes_last_and_asks_to_book_next_session(self):
        tid = self.sized("Write the Q4 readout", 90, 6)
        tasks.capture(self.core, "Renew the parking permit")
        answers.answer(self.core, self.card_for(tid)["id"], "after_others")
        self.assertEqual(self.front()[-1], "Write the Q4 readout")
        self.assertEqual(self.task(tid)["pushes"] or 0, 0)   # no penalty
        scheduler.wake(self.core)
        c = self.card_for(tid, "task")
        self.assertEqual(c["suggested"], "book")
        self.assertIn("Book time for it?", self.task(tid)["reason"])

    # ---- Just the first step
    def test_just_the_first_step(self):
        tid = self.sized("Write the Q4 readout", 90, 6)
        answers.answer(self.core, self.card_for(tid)["id"], "first_step")
        got = tools.claim_next_task(self.core)["task"]
        self.assertTrue(got["first_step"])
        self.assertFalse(got["may_finish"])
        tools.update_brief(self.core, tid, context_md="1. Open last quarter's deck (2 min)\n2. …")
        tools.finish_gathering(self.core, tid)
        t = self.task(tid)
        self.assertEqual(t["title"], "Write the Q4 readout")
        self.assertTrue({"doing", "first_step"} <= set(t["variant_tags"]))
        self.assertIn("book", cards.options(self.card_for(tid, "task"), t))

    # ---- What's in the way?
    def test_sent_to_the_end_twice_it_asks_whats_in_the_way(self):
        tid = tasks.capture(self.core, "Write the Q4 readout")
        tasks.to_back(self.core, tid)
        self.assertNotIn("in_the_way", self.task(tid)["variant_tags"])
        tasks.to_back(self.core, tid)
        c = self.card_for(tid, "task")
        self.assertEqual(c["prompt"], "What’s in the way?")
        self.assertEqual(cards.options(c, self.task(tid)), cards.WAY_OPTIONS)
        answers.answer(self.core, c["id"], "decide")
        t = self.task(tid)
        self.assertEqual((t["state"], t["find_out"]), ("queued", tasks.DECIDE))

    def test_i_dont_want_to_write_it(self):
        tid = tasks.capture(self.core, "Write the Q4 readout")
        answers.answer(self.core, self.card_for(tid)["id"], "draft_it")
        self.assertEqual(self.task(tid)["state"], "queued")
        self.assertIn(tasks.DRAFT_IT, self.task(tid)["notes"])


class Api(Server):
    def test_screen_times_are_kept_out_of_the_log(self):
        tid = tasks.capture(self.core, "Write the Q4 readout")
        before = self.core.one("SELECT COUNT(*) n FROM events")["n"]
        status, _ = self.req("POST", "/screen", {"task_id": tid, "mode": "sort", "shown_at": "2026-10-20T09:00:00Z",
                                                 "left_at": "2026-10-20T09:04:00Z", "away_s": 30, "how": "done"})
        self.assertEqual(status, 201)
        self.assertEqual(self.core.one("SELECT COUNT(*) n FROM events")["n"], before)
        self.assertEqual(self.req("GET", "/screen")[1]["times"][0]["away_s"], 30)
        self.assertEqual(self.req("GET", "/cards")[1]["work"]["stuck_minutes"], {"sort": 3, "work": 25})


if __name__ == "__main__":
    unittest.main()
