"""Deliverables: the record and its done-when, report_deliverable_done (closes and undoes; refused for
checked_by = you), part_of verdicts and cards, the Monday review and the weekday cards, list_deliverables,
and the week's active deliverables as the focus."""

import unittest

from helpers import CoreCase
from test_http import Server

from fuzz import answers, cards, checkins, deliverables, events, focus, scheduler, tasks, tools
from fuzz.db import FuzzError, parse_iso

TICKET = "https://jira.example.com/browse/REP-118"


def email(n, ask, links=(), who="Priya Shah"):
    return {"source": "email", "source_id": f"m{n}", "anchor": f"email:T{n}", "ts": f"2026-10-20T08:{n:02d}:00Z",
            "from": {"name": who, "email": f"{who.split()[0].lower()}@example.com"}, "quote": ask, "links": list(links),
            "candidates": [{"ask": ask, "owner": "me"}]}


class Deliverables(CoreCase):
    def new(self, title="The report builder launch", done_when="REP-118 is Done and in the release notes", **kw):
        return deliverables.create(self.core, title, done_when, **kw)

    def kinds(self):
        return [c["kind"] for c, _ in cards.queue(self.core)]

    # ---- the record
    def test_a_done_when_is_a_state_not_an_activity(self):
        with self.assertRaises(FuzzError) as e:
            self.new(done_when="Work on the report builder")
        self.assertEqual(e.exception.field, "done_when")

    def test_tasks_join_and_the_sheet_shows_them(self):
        did = self.new()
        a, b = tasks.capture(self.core, "Write the release note"), tasks.capture(self.core, "Demo it to Priya")
        deliverables.link(self.core, a, did)
        deliverables.link(self.core, b, did)
        tasks.add_link(self.core, a, None, TICKET, actor="human")
        tasks.done(self.core, b)
        v = deliverables.view(self.core, deliverables.get(self.core, did))
        self.assertEqual(([t["id"] for t in v["open"]], [t["id"] for t in v["done"]]), ([a], [b]))
        self.assertEqual(v["links"][0]["link"], TICKET)

    # ---- Fuzz checks the done-when
    def test_a_task_closing_has_fuzz_check_and_report_done_closes_with_undo(self):
        did = self.new()
        tid = tasks.capture(self.core, "Ship the report builder")
        deliverables.link(self.core, tid, did)
        self.assertEqual(tools.whoami(self.core, "executor")["deliverables_to_check"], [])
        tasks.done(self.core, tid)
        self.assertEqual([d["id"] for d in tools.whoami(self.core, "executor")["deliverables_to_check"]], [did])
        tools.report_deliverable_done(self.core, did, "REP-118 is Done and in the release notes")
        d = deliverables.get(self.core, did)
        self.assertEqual((d["state"], d["evidence"]), ("done", "REP-118 is Done and in the release notes"))
        events.undo(self.core)
        self.assertEqual(deliverables.get(self.core, did)["state"], "open")
        self.assertEqual(events.check_replay(self.core), [])

    def test_report_done_is_refused_when_its_checked_by_you(self):
        did = self.new(done_when="I'm happy with how it reads", checked_by="you")
        with self.assertRaises(FuzzError) as e:
            tools.report_deliverable_done(self.core, did, "Looks good")
        self.assertEqual(e.exception.status, 409)

    def test_when_fuzz_cant_check_it_asks_you(self):
        did = self.new()
        tools.report_deliverable_done(self.core, did, cant_check="No Jira tool")
        c = next(c for c, _ in cards.queue(self.core) if c["kind"] == "deliverable")
        self.assertEqual(cards.options(c, {}), ["its_done", "keep_going", "not_sure"])
        answers.answer(self.core, c["id"], "its_done")
        self.assertEqual(deliverables.get(self.core, did)["state"], "done")

    def test_letting_it_go_brings_its_open_tasks_up(self):
        did = self.new()
        tid = tasks.capture(self.core, "Write the release note")
        deliverables.link(self.core, tid, did)
        tasks.park(self.core, tid)
        deliverables._close(self.core, deliverables.get(self.core, did), "dropped", None, "human")
        t = tasks.get(self.core, tid)
        self.assertEqual(t["state"], "triage")
        self.assertIn("Keep this on its own, or let it go?", t["reason"])

    # ---- joining from matching
    def _judge(self, sig, did, conf):
        tools.submit_signals(self.core, [sig])
        items = tools.get_pending_judgments(self.core)["items"]
        self.assertTrue(items and items[0]["deliverables"])
        tools.submit_verdicts(self.core, [{"candidate_id": items[0]["candidate_id"], "verdict": "new", "confidence": conf,
                                           "deliverable_id": did}])
        return [t for t in tasks.list_tasks(self.core) if t["title"] == sig["candidates"][0]["ask"]][0]["id"]

    def test_a_confident_verdict_links_quietly_and_an_unsure_one_asks_for_an_active_one(self):
        tools.submit_signals(self.core, [email(1, "Plan the report builder export work")])   # gives the judge a shortlist
        a = self.new(tier="active")
        tid = self._judge(email(2, "Draft the release note for the report builder", who="Priya Shah"), a, 0.9)
        self.assertEqual(tasks.get(self.core, tid)["deliverable_id"], a)
        tid2 = self._judge(email(3, "Check the builder's export button", who="Priya Shah"), a, 0.6)
        self.assertEqual([c["kind"] for c in cards.open_cards(self.core, tid2)], ["part_of"])
        answers.answer(self.core, cards.open_cards(self.core, tid2)[0]["id"], "yes")
        self.assertEqual(tasks.get(self.core, tid2)["deliverable_id"], a)
        self.assertEqual([c["kind"] for c in cards.open_cards(self.core, tid2)], ["task"])

    def test_an_unsure_one_for_a_background_deliverable_waits_for_its_card(self):
        tools.submit_signals(self.core, [email(1, "Plan the report builder export work")])
        b = self.new()
        tid = self._judge(email(2, "Check the builder's export button", who="Priya Shah"), b, 0.6)
        self.assertEqual([c["kind"] for c in cards.open_cards(self.core, tid)], ["task"])
        self.assertEqual(tasks.get(self.core, tid)["maybe_deliverable_id"], b)
        self.clock.advance(days=7)   # a weekday a week on: its card, and "Is this part of it?"
        checkins.record(self.core, "good")
        scheduler.tick(self.core)
        self.assertIn("part_of", [c["kind"] for c in cards.open_cards(self.core, tid)])

    # ---- Monday and the weekdays
    def monday(self, energy="good"):
        self.clock.t = parse_iso("2026-10-26T09:00:00Z")
        checkins.record(self.core, energy)
        scheduler.tick(self.core)

    def test_the_monday_review_comes_first(self):
        a = self.new(tier="active")
        tid = tasks.capture(self.core, "Write the release note")
        deliverables.link(self.core, tid, a)
        for n, ask in enumerate(["Fix REP-200 export", "Test REP-200 on staging", "Announce REP-200"], 1):
            tasks.capture(self.core, ask)
        tasks.capture(self.core, "Renew the parking permit")
        self.monday()
        kinds = self.kinds()
        self.assertEqual(sorted(kinds[:4]), ["deliverable", "deliverable_new", "week_plan", "week_plan"])
        new = next(c for c, _ in cards.queue(self.core) if c["kind"] == "deliverable_new")
        answers.answer(self.core, new["id"], "track", {"title": "The export fix", "done_when": "REP-200 is Done"})
        d = [x for x in deliverables.open_ones(self.core) if x["title"] == "The export fix"][0]
        self.assertEqual(len(deliverables.tasks_of(self.core, d["id"])), 3)
        self.clock.advance(minutes=5)
        scheduler.tick(self.core)   # once a Monday
        self.assertEqual(self.kinds().count("week_plan"), 2)

    def test_a_rough_monday_only_asks_for_the_pick_and_the_rest_comes_tuesday(self):
        self.new(tier="active")
        self.monday("tired")
        self.assertEqual([k for k in self.kinds() if k != "task"], ["week_plan"])
        self.clock.t = parse_iso("2026-10-27T09:00:00Z")
        checkins.record(self.core, "good")
        scheduler.tick(self.core)
        self.assertIn("deliverable", self.kinds())

    def test_picking_this_weeks_active_ones_makes_their_tasks_the_focus(self):
        a, b = self.new(), self.new("The strategy deck", "The deck is in the Strategy folder and Priya has replied")
        tid = tasks.capture(self.core, "Outline the deck")
        deliverables.link(self.core, tid, b)
        self.monday("tired")
        plan = next(c for c, _ in cards.queue(self.core) if c["kind"] == "week_plan")
        with self.assertRaises(FuzzError):
            answers.answer(self.core, plan["id"], "keep_these", [a, b, a, b])
        answers.answer(self.core, plan["id"], "keep_these", [b])
        self.assertEqual((deliverables.get(self.core, a)["tier"], deliverables.get(self.core, b)["tier"]), ("background", "active"))
        self.assertEqual(focus.focus_ids(self.core), {tid})
        self.assertEqual(focus.chips(self.core)[0]["label"], "The strategy deck")

    def test_weekday_cards_are_sized_by_the_check_in(self):
        for n in range(4):
            self.new(f"Deliverable {n}", f"REP-{n} is Done")
        self.clock.advance(days=7)   # Tuesday a week on: all four unasked for a week
        checkins.record(self.core, "okay")
        scheduler.tick(self.core)
        self.assertEqual(self.kinds().count("deliverable"), 1)

    def test_this_weeks_steps_become_linked_tasks(self):
        a = self.new(tier="active")
        self.monday()
        steps = next(c for c, _ in cards.queue(self.core) if c["kind"] == "week_plan" and c["payload"].get("steps"))
        answers.answer(self.core, steps["id"], "keep_steps", {str(a): ["Book the demo room", "Send the release note"]})
        self.assertEqual(sorted(t["title"] for t in deliverables.tasks_of(self.core, a)), ["Book the demo room", "Send the release note"])

    def test_list_deliverables_says_what_moved(self):
        did = self.new()
        a, b = tasks.capture(self.core, "Write the release note"), tasks.capture(self.core, "Demo it")
        for t in (a, b):
            deliverables.link(self.core, t, did)
        tasks.done(self.core, a)
        got = tools.list_deliverables(self.core)["deliverables"][0]
        self.assertEqual((got["moved"]["done"], [t["title"] for t in got["open"]]), (["Write the release note"], ["Demo it"]))


class Api(Server):
    def test_make_swap_and_part_of(self):
        status, d = self.req("POST", "/deliverables", {"title": "The report builder launch",
                                                       "done_when": "REP-118 is Done and in the release notes"})
        self.assertEqual((status, d["tier"]), (201, "background"))
        tid = tasks.capture(self.core, "Write the release note")
        self.assertEqual(self.req("GET", f"/tasks/{tid}/part_of")[1]["choices"][0]["deliverable_id"], d["id"])
        self.assertEqual(self.req("POST", f"/tasks/{tid}/part_of", {"deliverable_id": d["id"]})[1]["deliverable"]["title"],
                         "The report builder launch")
        self.assertEqual(self.req("POST", f"/deliverables/{d['id']}/tier", {"tier": "active"})[1]["tier"], "active")
        self.assertEqual(self.req("GET", "/deliverables")[1]["deliverables"][0]["open"][0]["id"], tid)
        self.assertEqual(self.req("POST", f"/tasks/{tid}/part_of", {"deliverable_id": None})[0], 200)


if __name__ == "__main__":
    unittest.main()
