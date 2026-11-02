"""People on a task: who is involved and what each of them added, worked out from what the task holds."""

import unittest

from helpers import CoreCase

from fuzz import people, tasks, tools

DANA = {"name": "Dana Reyes", "email": "dana@acme.example"}
ME = {"name": "Justin Grover", "email": "jgrover@adobe.com"}


class PeopleOnATask(CoreCase):
    def thread(self, *msgs):
        tools.submit_signals(self.core, [dict({"source": "email", "anchor": "email:conv-T"}, **m) for m in msgs])
        return tasks.list_tasks(self.core)[0]

    def who(self, t):
        return people.for_task(self.core, tasks.get(self.core, t["id"]))

    def test_the_sender_leads_with_what_they_said_and_you_are_left_out(self):
        t = self.thread({"source_id": "m1", "ts": "2026-10-20T08:00:00Z", "from": DANA,
                         "people": [ME, {"name": "Marcus Lee", "email": "marcus@acme.example"}],
                         "quote": "Can you send the Q4 numbers?", "candidates": [{"ask": "Send Dana the Q4 numbers"}]})
        ps = self.who(t)
        self.assertEqual([p["name"] for p in ps], ["Dana Reyes", "Marcus Lee"])
        self.assertEqual([(c["kind"], c["text"], c["via"], c["quote"]) for c in ps[0]["contributions"]],
                         [("sent", "Asked for this", "Email", "Can you send the Q4 numbers?")])
        self.assertEqual([(c["text"], c["quote"]) for c in ps[1]["contributions"]], [("On the email", None)])

    def test_each_message_once_per_person_newest_first(self):
        t = self.thread(
            {"source_id": "m1", "ts": "2026-10-20T08:00:00Z", "from": DANA, "people": [DANA], "quote": "Q4 numbers?",
             "candidates": [{"ask": "Send Dana the Q4 numbers", "people": [{"name": "Dana"}]}]},
            {"source_id": "m2", "ts": "2026-10-20T08:45:00Z", "from": {"name": "Dana", "email": "dana@acme.example"},
             "quote": "Any update?", "candidates": []})
        # "Dana" came before Dana Reyes, so they're two people until you say they're the same
        self.assertEqual([p["name"] for p in self.who(t)], ["Dana Reyes", "Dana"])
        a, b = [r["id"] for r in self.core.all("SELECT id FROM entities WHERE type='person' ORDER BY id")]
        self.core.q("UPDATE entities SET redirect_to=? WHERE id=?", (b, a))   # what answering "Same person" does
        (dana,) = self.who(t)
        self.assertEqual(dana["name"], "Dana Reyes", "the fullest name she went by")
        self.assertEqual([(c["text"], c["quote"]) for c in dana["contributions"]],
                         [("Followed up", "Any update?"), ("Asked for this", "Q4 numbers?")])

    def test_who_you_wait_on_joins_them_and_someone_new_is_added(self):
        t = self.thread({"source_id": "m1", "ts": "2026-10-20T08:00:00Z", "from": DANA, "quote": "Numbers?",
                         "candidates": [{"ask": "Send Dana the Q4 numbers"}]})
        tasks.wait(self.core, t["id"], on="Dana")
        (dana,) = self.who(t)
        self.assertEqual([c["kind"] for c in dana["contributions"]], ["waiting", "sent"])
        tasks.wait(self.core, t["id"], on="Elena")
        self.assertEqual([(p["name"], [c["text"] for c in p["contributions"]]) for p in self.who(t)],
                         [("Dana Reyes", ["Asked for this"]), ("Elena", ["You’re waiting on them"])])

    def test_a_draft_sent_to_a_channel_is_not_a_person(self):
        t = self.thread({"source_id": "m1", "ts": "2026-10-20T08:00:00Z", "from": DANA, "quote": "Numbers?",
                         "candidates": [{"ask": "Send Dana the Q4 numbers"}]})
        for target in ("dana@acme.example", "#offsite-planning"):
            self.core.q("INSERT INTO drafts (user_id, task_id, kind, target, body, status, approved_at) VALUES "
                        "(1,?,?,?,?,?,?)", (t["id"], "email.reply", target, "Here they are", "sent", "2026-10-20T10:00:00Z"))
        ps = self.who(t)
        self.assertEqual([(p["name"], [c["text"] for c in p["contributions"]]) for p in ps],
                         [("Dana Reyes", ["Fuzz sent them a reply", "Asked for this"])])

    def test_slack_without_an_email_and_an_id_alone(self):
        tools.submit_signals(self.core, [
            {"source": "slack", "source_id": "C1:1.0", "anchor": "slack:C1:1.0", "ts": "2026-10-20T08:00:00Z",
             "from": {"name": "Jules Moreau", "slack_id": "U123"}, "quote": "Who owns the filter bug?",
             "candidates": [{"ask": "Find who owns the filter bug"}]},
            {"source": "slack", "source_id": "C1:2.0", "anchor": "slack:C1:1.0", "ts": "2026-10-20T08:30:00Z",
             "from": {"slack_id": "U123"}, "people": [{"slack_id": "U999"}, {"name": "Ines"}],
             "quote": "Any takers?", "candidates": []}])
        ps = self.who(tasks.list_tasks(self.core)[0])
        # Jules's ID alone still finds her; an ID we've never seen a name for has nothing to show
        self.assertEqual([(p["name"], p["email"], [c["text"] for c in p["contributions"]]) for p in ps],
                         [("Jules Moreau", "", ["Followed up", "Asked for this"]), ("Ines", "", ["In the conversation"])])

    def test_your_own_captures_have_no_one(self):
        tid = tasks.capture(self.core, "Renew the car registration")
        self.assertEqual(people.for_task(self.core, tasks.get(self.core, tid)), [])


if __name__ == "__main__":
    unittest.main()
