"""Groups: tasks from the same email thread, meeting notes or Slack burst go together, and only those."""

import unittest

from helpers import CoreCase

from fuzz import events, groups, matching, tasks, tools

MARCUS = {"name": "Marcus Lee", "slack_id": "U0MARCUS"}
ME = {"name": "Justin", "slack_id": "W4R5SVCU9"}


def email(n, asks, conv="AAQk1", title="Re: Offsite plan", ts="2026-10-20T09:00:00Z"):
    return {"source": "email", "source_id": f"msg{n}", "anchor": f"email:{conv}", "ts": ts, "title": title,
            "from": {"name": "Dana Reyes", "email": "dana@acme.com"}, "link": f"https://mail/{n}",
            "quote": "Can you take these?", "candidates": [{"ask": a, "owner": "me"} for a in asks]}


def meeting(row, ask, stem="2026-10-20 Staff sync"):
    return {"source": "meeting", "source_id": f"{stem}#{row}", "anchor": f"meeting:{stem}#{row}",
            "ts": "2026-10-20T10:00:00Z", "from": {"name": "Staff sync"},
            "link": f"file:///notes/{stem}.md#{row}", "quote": ask, "candidates": [{"ask": ask, "owner": "me"}]}


def slack(ts, asks, who=MARCUS, channel="D0MARCUS"):
    return {"source": "slack", "source_id": f"{channel}:{ts}", "anchor": f"slack:{channel}:{ts}",
            "ts": "2026-10-20T" + ts + "Z", "from": who, "quote": "…",
            "candidates": [{"ask": a, "owner": "me"} for a in asks]}


class Groups(CoreCase):
    def send(self, *sigs):
        """Submit signals; anything the matcher can't decide on its own the judge calls new."""
        tools.submit_signals(self.core, list(sigs))
        items = tools.get_pending_judgments(self.core)["items"]
        if items:
            tools.submit_verdicts(self.core, [{"candidate_id": i["candidate_id"], "verdict": "new", "confidence": 0.9}
                                              for i in items])

    def tid(self, words):
        rows = [t for t in tasks.list_tasks(self.core) if words.lower() in t["title"].lower()]
        self.assertEqual(len(rows), 1, [t["title"] for t in tasks.list_tasks(self.core)])
        return rows[0]["id"]

    def group_of(self, words):
        return tasks.get(self.core, self.tid(words))["group_id"]

    def test_one_email_with_several_asks_is_one_group(self):
        self.send(email(1, ["Book the venue for the offsite", "Order lunch for twelve", "Send the agenda to Sam"]))
        gid = self.group_of("venue")
        self.assertIsNotNone(gid)
        self.assertEqual(self.group_of("lunch"), gid)
        self.assertEqual(self.group_of("agenda"), gid)
        v = groups.view(self.core, groups.get(self.core, gid))
        self.assertEqual(v["title"], "Offsite plan")
        self.assertEqual((v["source"], v["link"], v["total"], v["done"]), ("email", "https://mail/1", 3, 0))

    def test_a_single_ask_has_no_group(self):
        self.send(email(1, ["Book the venue for the offsite"]))
        self.assertIsNone(self.group_of("venue"))
        self.assertEqual(groups.list_groups(self.core), [])

    def test_a_reply_with_a_new_ask_joins_while_the_group_is_open(self):
        self.send(email(1, ["Book the venue for the offsite", "Order lunch for twelve"]))
        self.clock.advance(hours=3)
        self.send(email(2, ["Print name badges for everyone"], ts="2026-10-20T12:00:00Z"))
        self.assertEqual(self.group_of("badges"), self.group_of("venue"))

    def test_a_finished_group_takes_no_new_ask(self):
        self.send(email(1, ["Book the venue for the offsite", "Order lunch for twelve"]))
        gid = self.group_of("venue")
        tasks.done(self.core, self.tid("venue"))
        tasks.done(self.core, self.tid("lunch"))
        self.assertTrue(groups.view(self.core, groups.get(self.core, gid))["finished"])
        self.send(email(2, ["Print name badges for everyone"], ts="2026-10-21T12:00:00Z"))
        self.assertIsNone(self.group_of("badges"))

    def test_meeting_rows_group_by_summary_file(self):
        self.send(meeting("book-room", "Book the room for Thursday's workshop"),
                  meeting("find-time-sam", "Find time with Sam for 1:1 prep"),
                  meeting("send-notes", "Send the retro notes to the team", stem="2026-10-20 Team retro"))
        gid = self.group_of("room")
        self.assertEqual(self.group_of("Sam"), gid)
        self.assertIsNone(self.group_of("retro"))
        g = groups.get(self.core, gid)
        self.assertEqual((g["title"], g["link"]), ("Staff sync", "file:///notes/2026-10-20 Staff sync.md"))

    def test_slack_burst_groups_quick_messages_from_one_person(self):
        self.send(slack("10:00:00", ["Send me the Q4 deck"]),
                  slack("10:04:00", ["Book a room for Thursday"]),
                  slack("10:12:00", ["Ping Sam about the budget"]))
        gid = self.group_of("deck")
        self.assertIsNotNone(gid)
        self.assertEqual({self.group_of("room"), self.group_of("Sam")}, {gid})
        self.assertEqual(groups.get(self.core, gid)["title"], "Marcus Lee on Slack")

    def test_slack_gap_your_reply_or_another_dm_ends_a_burst(self):
        self.send(slack("10:00:00", ["Send me the Q4 deck"]),
                  slack("10:30:00", ["Book a room for Thursday"]))                 # 30 minutes later
        self.assertIsNone(self.group_of("deck"))
        self.assertIsNone(self.group_of("room"))
        self.send(slack("11:00:00", ["Draft the launch email"]),
                  slack("11:02:00", [], who=ME),                                   # you answered
                  slack("11:03:00", ["Check the pricing page"]))
        self.assertIsNone(self.group_of("launch"))
        self.send(slack("12:00:00", ["Review the hiring plan"]),
                  slack("12:01:00", ["Approve the travel request"], channel="D0OTHER"))
        self.assertIsNone(self.group_of("hiring"))

    def test_slack_messages_ingested_out_of_order_still_group(self):
        self.send(slack("10:05:00", ["Book a room for Thursday"]))
        self.send(slack("10:00:00", ["Send me the Q4 deck"]))
        self.assertIsNotNone(self.group_of("deck"))
        self.assertEqual(self.group_of("deck"), self.group_of("room"))

    def test_one_slack_message_with_several_asks(self):
        self.send(slack("10:00:00", ["Send me the Q4 deck", "Book a room for Thursday"]))
        self.assertIsNotNone(self.group_of("deck"))
        self.assertEqual(self.group_of("deck"), self.group_of("room"))

    def test_captured_tasks_are_never_grouped(self):
        tasks.capture(self.core, "Renew the car registration")
        tasks.capture(self.core, "Call the dentist")
        self.assertEqual(groups.list_groups(self.core), [])

    def test_a_split_off_task_joins_its_parents_group(self):
        self.send(email(1, ["Book the venue for the offsite", "Order lunch for twelve"]))
        parent = self.tid("Book the venue")
        with self.core.tx("fuzz:executor"):
            out = matching.create_from_ask(matching.Context(self.core), "Pay the venue deposit", parent_id=parent)
        self.assertEqual(tasks.get(self.core, out["task_id"])["group_id"], self.group_of("Book the venue"))

    def test_take_out_rename_wrap_and_undo(self):
        self.send(email(1, ["Book the venue for the offsite", "Order lunch for twelve", "Send the agenda to Sam"]))
        gid = self.group_of("venue")
        groups.rename(self.core, gid, "Team offsite next week")
        self.assertEqual(groups.get(self.core, gid)["title"], "Team offsite next week")
        events.undo(self.core)
        self.assertEqual(groups.get(self.core, gid)["title"], "Offsite plan")

        self.assertEqual(groups.take_out(self.core, gid, self.tid("agenda")), [self.tid("agenda")])
        self.assertIsNone(self.group_of("agenda"))
        # taking out the second to last leaves one, which stands on its own
        self.assertEqual(sorted(groups.take_out(self.core, gid, self.tid("lunch"))),
                         sorted([self.tid("lunch"), self.tid("venue")]))
        self.assertIsNone(self.group_of("venue"))
        self.assertEqual(groups.list_groups(self.core), [])
        events.undo(self.core)
        self.assertEqual({self.group_of("venue"), self.group_of("lunch")}, {gid})
        self.assertEqual(groups.get(self.core, gid)["state"], "open")

        groups.wrap(self.core, gid)
        self.assertTrue(groups.view(self.core, groups.get(self.core, gid))["wrapped"])
        self.send(email(2, ["Print name badges for everyone"], ts="2026-10-20T12:00:00Z"))
        self.assertIsNone(self.group_of("badges"), "a wrapped group takes no new ask")
        self.assertEqual(events.check_replay(self.core), [])

    def test_get_task_lists_the_others_in_the_group(self):
        self.send(email(1, ["Book the venue for the offsite", "Order lunch for twelve"]))
        t = tasks.get(self.core, self.tid("venue"))
        b = groups.brief(self.core, t)
        self.assertEqual(b["title"], "Offsite plan")
        self.assertEqual([o["title"] for o in b["others"]], ["Order lunch for twelve"])


if __name__ == "__main__":
    unittest.main()
