"""Working through a group: the cards come back to back, Fuzz holds what you hand it until it has every
answer, then works the group as one claim and writes one reply for the thread."""

import unittest

from helpers import CoreCase
from test_http import Server

from fuzz import answers, cards, drafts, events, groups, scheduler, tasks, tools


def email(n, asks, conv="AAQk1", ts="2026-10-20T09:00:00Z"):
    return {"source": "email", "source_id": f"msg{n}", "anchor": f"email:{conv}", "ts": ts, "title": "Re: Offsite plan",
            "from": {"name": "Dana Reyes", "email": "dana@acme.com"}, "link": f"https://mail/{n}",
            "quote": "Can you take these?", "candidates": [{"ask": a, "owner": "me"} for a in asks]}


ASKS = ["Book the venue for the offsite", "Order lunch for twelve", "Send the agenda to Sam"]


class Runs(CoreCase):
    def send(self, *sigs):
        tools.submit_signals(self.core, list(sigs))
        items = tools.get_pending_judgments(self.core)["items"]
        if items:
            tools.submit_verdicts(self.core, [{"candidate_id": i["candidate_id"], "verdict": "new", "confidence": 0.9}
                                              for i in items])

    def tid(self, words):
        return next(t["id"] for t in tasks.list_tasks(self.core) if words.lower() in t["title"].lower())

    def answer(self, words, option, value=None):
        return answers.answer(self.core, self.card_for(self.tid(words))["id"], option, value)

    def front(self):
        return [t["title"] for c, t in cards.queue(self.core)]

    def tags(self, words):
        return self.task(self.tid(words))["variant_tags"]

    def group(self, n=3):
        self.send(email(1, ASKS[:n]))
        return self.task(self.tid("venue"))["group_id"]

    # ---- back to back
    def test_a_groups_cards_come_back_to_back(self):
        self.send(email(1, ASKS[:2]))
        tasks.capture(self.core, "Renew the parking permit")
        self.clock.advance(hours=1)
        self.send(email(2, ASKS[2:], ts="2026-10-20T10:00:00Z"))   # joins the open group, after the capture
        self.assertEqual(self.front(), ASKS[:2] + ASKS[2:] + ["Renew the parking permit"])

    def test_the_group_youre_working_through_comes_first(self):
        self.group()
        self.answer("venue", "assign")
        self.assertEqual(groups.run(self.core)["group_id"], self.task(self.tid("lunch"))["group_id"])
        rush = tasks.capture(self.core, "Sign the contract", due="2026-10-20T10:00:00Z")
        scheduler.tick(self.core)
        self.assertEqual(self.front(), ASKS[1:] + ["Sign the contract"])
        self.assertTrue(self.task(rush)["deadline_level"])

    # ---- held, then collected
    def test_assigning_waits_for_the_rest_then_fuzz_claims_them_as_one(self):
        self.group()
        self.answer("venue", "assign")
        self.assertIn("held", self.tags("venue"))
        self.assertEqual(tools.claim_next_task(self.core)["task"], None)   # held: nothing to claim yet
        offered = self.card_for(self.tid("agenda"))["schedule_options"][0]["anchor"]
        self.answer("agenda", "schedule", {"anchor": offered})
        self.assertEqual(self.task(self.tid("agenda"))["state"], "scheduled")   # your own answers take effect at once
        out = self.answer("lunch", "assign", "Vegetarian options too")
        self.assertIn("Got all 3. I'll look into the two together and draft one reply to Dana Reyes.", out["collected"])
        self.assertIsNone(groups.run(self.core))
        self.assertEqual((self.tags("venue"), self.tags("lunch")), (["together"], ["together"]))
        got = tools.claim_next_task(self.core)["task"]
        self.assertEqual(got["id"], self.tid("venue"))
        self.assertEqual(self.task(self.tid("lunch"))["state"], "working")
        self.assertEqual(scheduler._slots_used(self.core), 1)   # one claim, one slot
        g = got["group"]
        self.assertEqual(g["together"], [self.tid("lunch")])
        self.assertEqual(g["reply_to"], "Dana Reyes")
        lunch = next(o for o in g["others"] if o["id"] == self.tid("lunch"))
        self.assertEqual(lunch["you_said"], "Fuzz: “Vegetarian options too”")
        agenda = next(o for o in g["others"] if o["id"] == self.tid("agenda"))
        self.assertEqual((agenda["you_said"], agenda.get("together")), ("Later", None))

    def test_one_reply_answers_the_thread_and_closes_every_task(self):
        self.group(2)
        self.answer("venue", "assign")
        self.answer("lunch", "assign")
        main = tools.claim_next_task(self.core)["task"]["id"]
        lunch = self.tid("lunch")
        src = self.core.one("SELECT id FROM sources WHERE task_id=? AND role='origin'", (main,))["id"]
        tools.save_draft(self.core, main, "email.reply", "Dana Reyes", "Venue booked; lunch ordered.", reply_to=src,
                         covers=[lunch])
        self.assertEqual((self.task(main)["state"], self.task(lunch)["state"]), ("review", "review"))
        self.assertEqual([c["kind"] for c, _ in cards.queue(self.core)], ["draft"])   # one card for the reply
        answers.answer(self.core, self.card_for(main, "draft")["id"], "approve")
        tools.claim_next_send(self.core)
        d = drafts.approved_draft(self.core, main)
        tools.mark_sent(self.core, main, d["id"], "Mail")
        self.assertEqual((self.task(main)["state"], self.task(lunch)["state"]), ("done", "done"))
        v = groups.view(self.core, groups.get(self.core, self.task(main)["group_id"]))
        self.assertTrue(v["finished"])
        self.assertEqual(v["closed_line"], "All 2 of Dana Reyes’s asks answered in one reply. That thread's done.")

    def test_covers_only_takes_tasks_in_the_same_claim(self):
        self.group(2)
        tasks.capture(self.core, "Renew the parking permit")
        self.answer("venue", "assign")
        self.answer("lunch", "assign")
        main = tools.claim_next_task(self.core)["task"]["id"]
        with self.assertRaises(Exception):
            tools.save_draft(self.core, main, "note", None, "Notes", covers=[self.tid("parking")])

    def test_sending_a_group_reply_back_claims_them_together_again(self):
        self.group(2)
        self.answer("venue", "assign")
        self.answer("lunch", "assign")
        main = tools.claim_next_task(self.core)["task"]["id"]
        tools.save_draft(self.core, main, "note", None, "Both handled.", covers=[self.tid("lunch")])
        answers.answer(self.core, self.card_for(main, "draft")["id"], "send_back", "Mention the budget")
        self.assertEqual((self.tags("venue"), self.tags("lunch")), (["together"], ["together"]))
        tools.claim_next_task(self.core)
        self.assertEqual(self.task(self.tid("lunch"))["state"], "working")

    def test_undoing_the_last_answer_takes_the_collection_back(self):
        self.group(2)
        self.answer("venue", "assign")
        self.answer("lunch", "done")
        self.assertNotIn("held", self.tags("venue"))
        events.undo(self.core)
        self.assertIn("held", self.tags("venue"))
        self.assertEqual(self.task(self.tid("lunch"))["state"], "triage")
        self.assertIsNotNone(groups.run(self.core))
        self.assertEqual(events.check_replay(self.core), [])

    # ---- stopping partway
    def test_finish_later_goes_ahead_with_the_answers_so_far(self):
        gid = self.group()
        self.answer("venue", "assign")
        line = groups.finish_later(self.core, gid)
        self.assertTrue(line.startswith("Got 1 of 3."), line)
        self.assertIn("The rest come back as ordinary cards.", line)
        self.assertEqual(self.tags("venue"), [])   # one task: an ordinary claim
        self.assertEqual(tools.claim_next_task(self.core)["task"]["id"], self.tid("venue"))
        self.assertEqual(len(self.open_cards()), 2)

    def test_finish_later_undoes_before_fuzz_starts(self):
        gid = self.group()
        self.answer("venue", "assign")
        groups.finish_later(self.core, gid)
        events.undo(self.core)
        self.assertIn("held", self.tags("venue"))
        self.assertEqual(groups.run(self.core)["group_id"], gid)

    def test_a_quiet_run_is_collected_by_the_clock(self):
        self.group()
        self.answer("venue", "assign")
        self.clock.advance(minutes=20)
        self.assertEqual(scheduler.tick(self.core)["groups_collected"], 0)
        self.clock.advance(minutes=11)
        self.assertEqual(scheduler.tick(self.core)["groups_collected"], 1)
        self.assertNotIn("held", self.tags("venue"))

    def test_putting_the_last_card_off_still_collects(self):
        self.group(2)
        self.answer("venue", "assign")
        tasks.to_back(self.core, self.tid("lunch"))   # End of the list
        self.assertNotIn("held", self.tags("venue"))
        self.assertEqual(len(self.open_cards()), 1)

    def test_reopening_a_held_task_lets_you_change_the_answer(self):
        self.group()
        self.answer("venue", "assign")
        tasks.bring_back(self.core, self.tid("venue"), where="front", reason="You brought this back.")
        self.assertEqual(self.task(self.tid("venue"))["state"], "triage")
        self.assertNotIn("held", self.tags("venue"))

    # ---- Fuzz stuck on a group
    def test_a_group_claim_hands_back_once(self):
        self.group(2)
        self.answer("venue", "assign")
        self.answer("lunch", "assign")
        main = tools.claim_next_task(self.core)["task"]["id"]
        tools.hand_back(self.core, main, "Which day?", ["Thursday", "Friday"])
        self.assertEqual([c["task_id"] for c in self.open_cards()], [main])   # one card for the group
        self.assertEqual(self.tags("lunch"), ["held"])
        answers.answer(self.core, self.card_for(main)["id"], "quick", "Thursday")
        self.assertEqual((self.tags("venue"), self.tags("lunch")), (["together"], ["together"]))

    def test_working_on_one_keeps_the_others_leases(self):
        self.group(2)
        self.answer("venue", "assign")
        self.answer("lunch", "assign")
        main = tools.claim_next_task(self.core)["task"]["id"]
        self.clock.advance(minutes=8)
        tools.log_step(self.core, main, "research", "Checked the venue list")
        self.clock.advance(minutes=5)   # past the first lease
        scheduler.expire_leases(self.core)
        self.assertEqual(self.task(self.tid("lunch"))["state"], "working")
        tools.log_step(self.core, self.tid("lunch"), "research", "Found the caterer")

    def test_a_lone_ask_is_an_ordinary_card(self):
        self.send(email(1, ASKS[:1]))
        self.answer("venue", "assign")
        self.assertEqual(self.tags("venue"), [])
        self.assertIsNone(groups.run(self.core))

    def test_the_group_sheet_says_what_you_answered(self):
        gid = self.group(2)
        self.answer("venue", "wait", "Marcus")
        v = groups.view(self.core, groups.get(self.core, gid))
        said = {t["title"]: t["said"] for t in v["tasks"]}
        self.assertEqual(said[ASKS[0]]["text"], "Waiting on Marcus")
        self.assertIsNone(said[ASKS[1]])


class Api(Server):
    def test_cards_say_which_group_youre_in_and_finish_later_ends_it(self):
        tools.submit_signals(self.core, [email(1, ASKS)])
        cs = self.req("GET", "/cards")[1]
        self.assertIsNone(cs["group_run"])
        self.req("POST", f"/cards/{cs['cards'][0]['id']}/answer", {"option": "assign"})
        cs = self.req("GET", "/cards")[1]
        gid = cs["group_run"]["group_id"]
        self.assertEqual(len(cs["group_run"]["tasks"]), 3)
        status, g = self.req("POST", f"/groups/{gid}/finish_later", {})
        self.assertEqual(status, 200)
        self.assertTrue(g["collected"].startswith("Got 1 of 3."))
        self.assertIsNone(self.req("GET", "/cards")[1]["group_run"])
        self.assertEqual(self.req("POST", f"/groups/{gid}/finish_later", {})[0], 409)


if __name__ == "__main__":
    unittest.main()
