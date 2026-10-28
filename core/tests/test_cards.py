"""Every card kind and answer writes exactly the events in the design's "What each answer writes", and
Undo restores the earlier state."""

import unittest

from helpers import CoreCase

from fuzz import answers, cards, checkins, drafts, events, scheduler, tasks, tools
from fuzz.db import FuzzError

IGNORED = {"card.created"}   # bookkeeping that rides along with an answer


ASKS = ["Order the conference badges", "Fix the flaky nightly build", "Renew the design tool licences",
        "Collect receipts for the offsite", "Update the onboarding checklist"]


def extract(core, ask, owner="me", n=[0]):
    n[0] += 1
    tools.submit_signals(core, [{"source": "email", "source_id": f"m{n[0]}", "anchor": f"email:c{n[0]}",
                                 "ts": "2026-10-20T08:00:00Z", "from": {"name": f"Sender {n[0]}"},
                                 "quote": ask, "candidates": [{"ask": ask, "owner": owner}]}])
    return core.one("SELECT id FROM tasks WHERE ask=? ORDER BY id DESC", (ask,))["id"]


class CardTable(CoreCase):
    # ---- making each kind
    def routing(self):
        tid = tasks.capture(self.core, "Book the room for Thursday")
        return tid, self.card_for(tid, "task")

    def claimed(self, text="Reply to Elena about the launch date"):
        tid = tasks.capture(self.core, text)
        tasks.assign(self.core, tid)
        t, why = scheduler.claim_next(self.core, tid)
        self.assertEqual((t or {}).get("id"), tid, why)
        return tid

    def draft(self, kind="email.new"):
        tid = self.claimed()
        drafts.save_draft(self.core, tid, kind, "elena@acme.com", "Hi Elena, the later date works.")
        return tid, self.card_for(tid)

    def permission(self):
        tid = self.claimed()
        res = drafts.request_permission(self.core, tid, "source", "Support training folder", "To confirm notice")
        return tid, cards.get(self.core, res["card_id"])

    def duplicate(self):
        a = tasks.capture(self.core, "Finish the pricing deck review")
        b = tasks.capture(self.core, "Review the Q4 pricing deck")
        with self.core.tx("fuzz:extractor"):
            cid = cards.create(self.core, "duplicate", a, other_id=b, reason="Same deck, two days apart")
        return a, cards.get(self.core, cid)

    def entity(self, kind):
        tid = tasks.capture(self.core, "Ask Sam about the venue")
        q = self.core.q
        e1 = q("INSERT INTO entities (user_id, type, name, provisional) VALUES (1,'person','Sam Ortiz',0)").lastrowid
        e2 = q("INSERT INTO entities (user_id, type, name, provisional) VALUES (1,'person','Sam',1)").lastrowid
        payload = {"entity_a": e1, "entity_b": e2} if kind == "entity_person" else {"entity_id": e2, "term": "Lantern"}
        with self.core.tx("fuzz:extractor"):
            cid = cards.create(self.core, kind, tid, payload=payload)
        return tid, cards.get(self.core, cid)

    # ---- the check
    def check(self, made, option, want_events, want_state=None, value=None):
        tid, card = made
        before_task = dict(self.task(tid)) if tid else None
        before = self.last_event_id()
        answers.answer(self.core, card["id"], option, value)
        got = [t for t in self.types_since(before) if t not in IGNORED]
        self.assertEqual(got, want_events, f"{card['kind']} / {option}")
        if want_state:
            self.assertEqual(self.task(tid)["state"], want_state)
        events.undo(self.core)
        self.assertEqual(cards.get(self.core, card["id"])["status"], "open", "Undo reopens the card")
        if tid:
            self.assertEqual(self.task(tid)["state"], before_task["state"], "Undo restores the task")
        self.assertEqual(events.check_replay(self.core), [])

    def test_task_routing_answers(self):
        self.check(self.routing(), "assign", ["task.assigned"], "queued")
        self.check(self.routing(), "session", ["task.assigned"], "session")
        self.check(self.routing(), "done", ["task.done"], "done")
        self.check(self.routing(), "park", ["task.parked"], "parked")
        self.check(self.routing(), "wait", ["task.waiting"], "waiting", value="Marcus")
        self.check(self.routing(), "drop", ["task.let_go"], "letgo")
        tid, card = self.routing()
        opt = next(o for o in card["schedule_options"] if o["anchor"]["type"] == "at_desk")
        self.check((tid, card), "schedule", ["task.scheduled"], "scheduled", value={"anchor": opt["anchor"]})

    def test_stale_keep_resets_the_clock(self):
        tid, _ = self.routing()
        self.clock.advance(days=8)
        scheduler.tick(self.core)
        card = self.card_for(tid, "task")
        self.assertIn("keep", cards.view(self.core, card)["options"])
        self.check((tid, card), "keep", ["card.answered"], "triage")
        answers.answer(self.core, card["id"], "keep")
        self.assertNotIn("stale", self.task(tid)["variant_tags"])
        self.assertEqual(self.task(tid)["state_changed_at"], self.core.now_iso())

    def test_handed_back_quick_answer_goes_back_to_fuzz_with_the_answer(self):
        tid = self.claimed()
        scheduler.hand_back(self.core, tid, "Ask Ines or Tomas?", ["Ask Ines", "Ask Tomas"])
        card = self.card_for(tid, "task")
        self.assertEqual(cards.view(self.core, card)["prompt"], "Ask Ines or Tomas?")
        self.check((tid, card), "quick", ["card.answered", "task.assigned"], "queued", value="Ask Ines")
        answers.answer(self.core, card["id"], "quick", "Ask Ines")
        self.assertIn("Ask Ines", self.task(tid)["notes"])
        self.assertIsNone(self.task(tid)["question"], "answering clears the question")

    def test_duplicate(self):
        self.check(self.duplicate(), "merge", ["task.merged"], "merged")
        self.check(self.duplicate(), "keep_separate", ["card.answered"], "triage")

    def test_entities(self):
        self.check(self.entity("entity_person"), "same", ["entity.merged"])
        self.check(self.entity("entity_person"), "different", ["entity.kept_separate"])
        self.check(self.entity("entity_term"), "define", ["entity.defined"], value="Our Q4 analytics launch")

    def test_is_task(self):
        self.check(self._is_task(), "mine", ["task.confirmed"], "triage")
        self.check(self._is_task(), "not_task", ["task.let_go"], "letgo")
        self.check(self._is_task(), "someone_else", ["task.let_go"], "letgo", value="Dana")

    def _is_task(self):
        n = self.core.one("SELECT COUNT(*) n FROM tasks")["n"]
        tid = extract(self.core, ASKS[n % len(ASKS)], "unclear")
        return tid, self.card_for(tid, "is_task")

    def test_mine_makes_a_routing_card(self):
        tid, card = self._is_task()
        answers.answer(self.core, card["id"], "mine")
        self.card_for(tid, "task")

    def test_draft(self):
        self.check(self.draft(), "approve", ["task.approved"], "sending")
        self.check(self.draft("note"), "approve", ["task.approved"], "done")
        self.check(self.draft(), "edit", ["task.draft_edited"], "review", value="Hi Elena, new text.")
        self.check(self.draft(), "send_back", ["task.sent_back"], "queued", value="Warmer, please")
        self.check(self.draft(), "done", ["task.done"], "done")

    def test_done_on_a_draft_means_you_sent_it_yourself(self):
        tid, card = self.draft()
        answers.answer(self.core, card["id"], "done")
        self.assertEqual(self.core.one("SELECT status FROM drafts WHERE task_id=?", (tid,))["status"], "withdrawn",
                         "Fuzz's sender never picks it up")
        events.undo(self.core)
        self.assertEqual(self.core.one("SELECT status FROM drafts WHERE task_id=?", (tid,))["status"], "pending")

    def test_not_now_on_a_draft_brings_it_back_for_your_ok(self):
        tid, card = self.draft()
        self.assertIn("schedule", card["options"])
        view = cards.view(self.core, cards.get(self.core, card["id"]))
        self.assertTrue(view["schedule_options"], "the draft card offers the same times as Schedule")
        later = {"anchor": view["schedule_options"][0]["anchor"]}   # Later today
        self.check((tid, card), "schedule", ["task.scheduled"], "scheduled", value=later)   # and Undo
        answers.answer(self.core, card["id"], "schedule", later)
        self.assertEqual(self.core.one("SELECT status FROM drafts WHERE task_id=?", (tid,))["status"], "pending")
        self.clock.advance(hours=8)
        scheduler.tick(self.core)
        self.assertEqual(self.task(tid)["state"], "review", "it comes back to review, not triage")
        self.assertEqual(self.card_for(tid)["kind"], "draft")

    def test_not_now_until_back_at_your_desk(self):
        tid, card = self.draft("nudge.email")
        answers.answer(self.core, card["id"], "schedule", {"anchor": {"type": "at_desk"}})
        self.assertEqual(scheduler.wake(self.core), 1)
        self.assertEqual(self.task(tid)["state"], "review")
        self.assertEqual(self.card_for(tid)["kind"], "nudge")

    def test_nudge(self):
        made = self.draft("nudge.email")
        self.assertEqual(made[1]["kind"], "nudge")
        self.check(made, "approve", ["task.approved"], "sending")
        self.check(self.draft("nudge.slack"), "not_yet", ["card.answered"], "waiting")

    def test_permission(self):
        self.check(self.permission(), "allow_once", ["permission.granted"])
        self.check(self.permission(), "deny", ["permission.denied"])
        tid, card = self.permission()
        self.check((tid, card), "always_allow", ["permission.granted"])
        answers.answer(self.core, card["id"], "always_allow")
        tid2 = self.claimed("Another task needing the folder")
        self.assertEqual(drafts.request_permission(self.core, tid2, "source", "Support training folder", "again"),
                         {"granted": True}, "Always allow isn't asked twice")

    def test_bad_answers_name_the_field(self):
        tid, card = self.routing()
        with self.assertRaises(FuzzError) as e:
            answers.answer(self.core, card["id"], "teleport")
        self.assertEqual(e.exception.field, "option")
        with self.assertRaises(FuzzError) as e:
            answers.answer(self.core, card["id"], "schedule", {"anchor": {"type": "in", "minutes": 7}})
        self.assertEqual(e.exception.field, "value.anchor")


class QueueRules(CoreCase):
    def test_not_sure_twice_then_the_safe_answer(self):
        a = tasks.capture(self.core, "Finish the pricing deck review")
        b = tasks.capture(self.core, "Review the Q4 pricing deck")
        with self.core.tx("fuzz:extractor"):
            cid = cards.create(self.core, "duplicate", a, other_id=b)
        for i in range(2):
            before = self.last_event_id()
            answers.answer(self.core, cid, "not_sure")
            self.assertEqual(self.types_since(before), ["card.postponed"])
            self.assertEqual(self.open_cards()[-1]["id"], cid, "a postponed card goes to the end")
        answers.answer(self.core, cid, "not_sure")
        c = cards.get(self.core, cid)
        self.assertEqual((c["status"], c["answer"]["option"]), ("expired", "keep_separate"))
        link = self.core.one("SELECT kind FROM task_links WHERE a=? AND b=?", (a, b))
        self.assertEqual(link["kind"], "kept_separate")

    def test_one_card_per_task_questions_first(self):
        tid = extract(self.core, "Someone should order the badges", "unclear")
        self.assertEqual([c["kind"] for c in cards.open_cards(self.core, tid)], ["is_task"])

    def test_triage_order(self):
        plain = tasks.capture(self.core, "Plain")
        urgent = tasks.capture(self.core, "Urgent", due="2026-10-20T11:00:00Z")
        quick = tasks.capture(self.core, "Quick one")
        tasks.update_brief(self.core, quick, effort_mins=2, actor="human")
        back = self.claimed_and_handed_back()
        scheduler.tick(self.core)
        order = [c["task_id"] for c in self.open_cards()]
        self.assertEqual(order[0], urgent, "time-sensitive first")
        self.assertEqual(order[-1], back, "handbacks last")
        checkins.record(self.core, "overloaded")
        order = [c["task_id"] for c in self.open_cards()]
        self.assertEqual(order[:2], [urgent, quick], "overloaded brings quick ones first")
        self.assertLess(order.index(quick), order.index(plain))

    def claimed_and_handed_back(self):
        tid = tasks.capture(self.core, "Handed back one")
        tasks.assign(self.core, tid)
        scheduler.claim_next(self.core)
        scheduler.hand_back(self.core, tid, "Which room?", ["Room 3", "Room 5"])
        return tid



class Brief(CoreCase):
    def test_context_and_question(self):
        tid = tasks.capture(self.core, "Do the corporate compliance video")
        tasks.assign(self.core, tid)
        scheduler.claim_next(self.core)
        md = "**Compliance video**\n\nDue Friday. [Open the training](https://learn.example/compliance)"
        before = self.last_event_id()
        tools.update_brief(self.core, tid, context_md=md, question="What should the deadline be?")
        self.assertEqual(self.types_since(before), ["task.brief_updated"])
        t = self.task(tid)
        self.assertEqual((t["context_md"], t["question"]), (md, "What should the deadline be?"))
        tools.hand_back(self.core, tid, "Book time for it this week?", ["Yes", "Next week"])
        card = self.card_for(tid, "task")
        self.assertEqual(cards.view(self.core, card)["prompt"], "Book time for it this week?")
        self.assertEqual(cards.view(self.core, card)["task"]["context_md"], md)
        answers.answer(self.core, card["id"], "park")
        self.assertIsNone(self.task(tid)["question"], "answering clears the question")
        self.assertEqual(self.task(tid)["context_md"], md, "the brief stays")

    def test_summary_sits_beside_the_brief(self):
        tid = tasks.capture(self.core, "Prepare for my 1:1")
        tasks.assign(self.core, tid)
        scheduler.claim_next(self.core)
        r = tools.update_brief(self.core, tid, context_md="## Agenda\n\n1. Estimates",
                               summary="  Found three open items.  ")
        self.assertEqual(r["updated"], ["context_md", "summary"])
        self.assertEqual(self.task(tid)["summary"], "Found three open items.")
        self.assertEqual(tools.get_task(self.core, tid)["summary"], "Found three open items.")
        tools.hand_back(self.core, tid, result=True)
        card = self.card_for(tid, "task")
        self.assertEqual(cards.view(self.core, card)["task"]["summary"], "Found three open items.")
        tasks.update_brief(self.core, tid, summary="", actor="human")
        self.assertIsNone(self.task(tid)["summary"], "an empty summary clears it")

    def test_undo_restores_the_brief(self):
        tid = tasks.capture(self.core, "Compliance video")
        tasks.update_brief(self.core, tid, context_md="first", question="Q1?", actor="human")
        tasks.update_brief(self.core, tid, context_md="second", question="Q2?", actor="human")
        events.undo(self.core)
        t = self.task(tid)
        self.assertEqual((t["context_md"], t["question"]), ("first", "Q1?"))

    def test_brief_limits_name_the_field(self):
        tid = tasks.capture(self.core, "Compliance video")
        with self.assertRaises(FuzzError) as e:
            tasks.update_brief(self.core, tid, context_md="x" * (16 * 1024 + 1))
        self.assertEqual(e.exception.field, "context_md")
        with self.assertRaises(FuzzError) as e:
            tasks.update_brief(self.core, tid)
        self.assertEqual(e.exception.field, "context_md")
        with self.assertRaises(FuzzError) as e:
            tasks.update_brief(self.core, tid, summary="x" * 401)
        self.assertEqual(e.exception.field, "summary")


if __name__ == "__main__":
    unittest.main()


class CheckIns(CoreCase):
    """The UI decides when to ask; the core records the answer and what it means for the queue."""

    def test_answers_set_the_moment(self):
        for answer, moment in (("good", "any"), ("okay", "any"), ("tired", "low"), ("overloaded", "quick")):
            before = self.last_event_id()
            self.assertEqual(checkins.record(self.core, answer)["moment"], moment)
            self.assertEqual(self.types_since(before), ["checkin.answered"])
            self.assertEqual(cards.moment(self.core), moment)
        checkins.record(self.core, "tired", "quick_first")
        self.assertEqual(cards.moment(self.core), "quick")

    def test_the_core_never_raises_a_checkin_card(self):
        for i in range(10):
            tid = tasks.capture(self.core, f"Task {i}")
            answers.answer(self.core, self.card_for(tid, "task")["id"], "done")
        self.assertEqual({c["kind"] for c in self.core.all("SELECT kind FROM cards")}, {"task"})

    def test_hold_the_rest_until_tomorrow_and_undo_it_in_one_go(self):
        urgent = tasks.capture(self.core, "Confirm headcount", due="2026-10-20T12:00:00Z")
        rest = [tasks.capture(self.core, f"Task {i}") for i in range(3)]
        scheduler.tick(self.core)
        before = self.last_event_id()
        self.assertEqual(checkins.record(self.core, "overloaded", "hold_rest")["held"], 3)
        self.assertEqual(self.types_since(before), ["checkin.answered"] + ["task.scheduled"] * 3)
        self.assertEqual([c["task_id"] for c in self.open_cards()], [urgent])
        events.undo(self.core)
        self.assertEqual({self.task(t)["state"] for t in rest}, {"triage"})
        self.assertEqual(cards.moment(self.core), "any")

    def test_bad_answers_name_the_field(self):
        with self.assertRaises(FuzzError) as e:
            checkins.record(self.core, "meh")
        self.assertEqual(e.exception.field, "answer")
        with self.assertRaises(FuzzError) as e:
            checkins.record(self.core, "good", "nap")
        self.assertEqual(e.exception.field, "follow_up")


class Sending(CoreCase):
    """Approving hands the draft to Fuzz's sender, which sends it with its own connector."""

    def approved(self, kind="email.new"):
        tid = tasks.capture(self.core, "Reply to Elena")
        tasks.assign(self.core, tid)
        scheduler.claim_next(self.core, tid)
        did = drafts.save_draft(self.core, tid, kind, "Elena Park", "Hi Elena, the later date works.")
        answers.answer(self.core, self.card_for(tid)["id"], "approve")
        return tid, did

    def test_sent_once_and_never_undone(self):
        tid, did = self.approved()
        s = tools.claim_next_send(self.core)["send"]
        self.assertEqual((s["task_id"], s["draft_id"], s["body"]), (tid, did, "Hi Elena, the later date works."))
        tools.mark_sent(self.core, tid, did, "Email reply", "https://mail/123")
        self.assertEqual(self.task(tid)["state"], "done")
        self.assertEqual(events.task_log(self.core, tid, 1)[0]["kind"], "sent")
        self.assertEqual(tools.claim_next_send(self.core)["send"], None)
        self.assertNotIn("task.approved", [g["type"] for g in events.undo_list(self.core) if not g["blocked"]])
        with self.assertRaises(FuzzError):
            events.undo(self.core)
        self.assertEqual(self.task(tid)["state"], "done")

    def test_a_nudge_goes_back_to_waiting(self):
        tid, did = self.approved("nudge.slack")
        tools.claim_next_send(self.core)
        tools.mark_sent(self.core, tid, did, "Slack thread")
        self.assertEqual(self.task(tid)["state"], "waiting")

    def test_undo_takes_the_approval_back_until_fuzz_claims_it(self):
        tid, did = self.approved()
        events.undo(self.core)
        self.assertEqual(self.task(tid)["state"], "review")
        self.assertEqual([c["kind"] for c in self.open_cards()], ["draft"])
        answers.answer(self.core, self.card_for(tid)["id"], "approve")
        tools.claim_next_send(self.core)
        with self.assertRaises(FuzzError) as e:
            events.undo(self.core)
        self.assertEqual(e.exception.status, 409)

    def test_send_failed_comes_back_to_review(self):
        tid, did = self.approved()
        tools.claim_next_send(self.core)
        tools.send_failed(self.core, tid, did, "There's no email tool connected.")
        t = self.task(tid)
        self.assertEqual((t["state"], t["question"]), ("review", "There's no email tool connected. Send it again?"))
        card = cards.view(self.core, self.card_for(tid))
        self.assertEqual((card["kind"], card["prompt"]), ("draft", t["question"]))
        answers.answer(self.core, card["id"], "approve")
        self.assertEqual(self.task(tid)["state"], "sending")

    def test_a_send_run_that_stops_partway_is_never_retried(self):
        tid, did = self.approved()
        tools.claim_next_send(self.core)
        self.clock.advance(minutes=30)
        self.assertEqual(tools.claim_next_send(self.core)["send"], None)
        t = self.task(tid)
        self.assertEqual(t["state"], "review")
        self.assertIn("may or may not have gone out", t["question"])

    def test_only_the_approved_draft_and_only_with_the_lease(self):
        tid, did = self.approved()
        with self.assertRaises(FuzzError):
            tools.mark_sent(self.core, tid, did, "Email reply")   # not claimed
        tools.claim_next_send(self.core)
        with self.assertRaises(FuzzError) as e:
            tools.mark_sent(self.core, tid, did + 1, "Email reply")
        self.assertEqual(e.exception.field, "draft_id")

    def test_scripted_sender_and_nothing_to_do(self):
        from fuzz import runner
        self.assertEqual(runner.run_role(self.core, "sender", scripted_=True, say=lambda s: None)["run_id"], None)
        tid, _ = self.approved()
        res = runner.run_role(self.core, "sender", scripted_=True, say=lambda s: None)
        self.assertEqual((res["outcome"], self.task(tid)["state"]), ("ok", "done"))
        self.assertEqual(events.check_replay(self.core), [])
