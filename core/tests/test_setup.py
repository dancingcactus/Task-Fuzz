"""Setup: the tools Fuzz may use, Always allow that switches them on, and the output folder."""

import json
import os
import tempfile
import unittest
from unittest import mock

from helpers import CoreCase

from fuzz import adapters, answers, connectors, drafts, outputs, scheduler, setup, tasks, tools
from fuzz.db import FuzzError

SERVERS = [{"name": "workiq", "status": "enabled"}, {"name": "Ember MCP", "status": "enabled"},
           {"name": "slack", "status": "enabled"}]
LISTED = [
    {"tool": "workiq-fetch", "server": "workiq", "does": "Fetches an email or file.", "kind": "lookup"},
    {"tool": "workiq-retrieve", "server": "workiq", "does": "Searches mail and files.", "kind": "lookup"},
    {"tool": "workiq-do_action", "server": "workiq", "does": "Runs an action.", "kind": "lookup"},
    {"tool": "Ember-MCP-ask_ember", "server": "Ember MCP", "does": "Answers questions.", "kind": "lookup"},
    {"tool": "slack-send_message", "server": "slack", "does": "Posts a message.", "kind": "send"},
    {"tool": "slack-delete_message", "server": "slack", "does": "Deletes a message.", "kind": "change"},
    {"tool": "fuzz-executor-whoami", "server": "fuzz-executor", "does": "Fuzz.", "kind": "lookup"},
]


def answer_text(rows):
    return "Here you go:\n```json\n" + json.dumps(rows) + "\n```\n"


class Discovery(CoreCase):
    def discover(self, rows=LISTED):
        with mock.patch.object(adapters.get("copilot"), "list_servers", return_value=SERVERS):
            return connectors.discover(self.core, "copilot", runner=lambda argv: answer_text(rows))

    def test_the_answer_is_found_inside_prose(self):
        self.assertEqual(len(connectors.parse(answer_text(LISTED))), len(LISTED))
        with self.assertRaises(FuzzError):
            connectors.parse("I can't see any tools.")

    def test_tools_are_named_the_way_the_config_takes_them(self):
        v = self.discover()
        allow = {t["tool"]: t["allow"] for t in v["tools"]}
        self.assertEqual(allow["workiq-fetch"], "workiq(fetch)")
        self.assertEqual(allow["Ember-MCP-ask_ember"], "Ember MCP(ask_ember)")
        self.assertNotIn("fuzz-executor-whoami", allow, "Fuzz's own tools aren't offered")

    def test_only_tools_that_read_are_suggested(self):
        kinds = {t["allow"]: (t["kind"], t["suggested"]) for t in self.discover()["tools"]}
        self.assertEqual(kinds["workiq(fetch)"], ("lookup", True))
        self.assertEqual(kinds["workiq(do_action)"], ("change", False), "a name that acts wins over the run")
        self.assertEqual(kinds["slack(send_message)"], ("send", False), "a send tool is never pre-selected")
        self.assertEqual(kinds["slack(delete_message)"], ("change", False))

    def test_the_run_is_recorded_and_nothing_is_allowed_yet(self):
        v = self.discover()
        self.assertEqual((v["read"], v["send"]), ([], []))
        r = self.core.one("SELECT * FROM runs ORDER BY id DESC LIMIT 1")
        self.assertEqual((r["role"], r["client"], r["outcome"]), ("setup", "copilot", "ok"))

    def test_choosing_writes_the_config_and_counts_the_cost(self):
        self.discover()
        v = connectors.choose(self.core, "copilot", read=["workiq(fetch)", "workiq(retrieve)"],
                              send=["slack(send_message)"])
        self.assertEqual(self.core.config["read"]["tools"]["copilot"], ["workiq(fetch)", "workiq(retrieve)"])
        self.assertEqual(self.core.config["send"]["tools"]["copilot"], ["slack(send_message)"])
        self.assertEqual(v["cost"]["tools"], 2)
        self.assertEqual([t["allow"] for t in v["tools"] if t["read"]], ["workiq(fetch)", "workiq(retrieve)"])
        with self.assertRaises(FuzzError):
            connectors.choose(self.core, "copilot", read="workiq")

    def test_a_whole_server_covers_its_tools(self):
        self.discover()
        connectors.choose(self.core, "copilot", read=["workiq"])
        self.assertTrue(all(t["read"] for t in connectors.view(self.core, "copilot")["tools"]
                            if t["server"] == "workiq"))

    def test_the_discovery_command_can_call_nothing(self):
        cp = adapters.get("copilot").discovery_command("list")
        self.assertIn("write", cp)
        self.assertNotIn("--allow-tool", cp)
        cc = adapters.get("claude-code").discovery_command("list")
        self.assertEqual(cc[cc.index("--tools") + 1], "")
        self.assertNotIn("--allowedTools", cc)


class AlwaysAllow(Discovery):
    def asking(self, resource):
        tid = tasks.capture(self.core, "Summarize my email from today")
        tasks.assign(self.core, tid)
        scheduler.claim_next(self.core, tid)
        r = tools.request_permission(self.core, tid, "connector", resource, "To read your inbox")
        return tid, r["card_id"]

    def test_always_allow_switches_on_its_lookup_tools(self):
        self.discover()
        self.assertEqual(tools.whoami(self.core, "executor")["can_ask_for"], ["Ember MCP", "workiq"])
        tid, card = self.asking("WorkIQ mail")
        answers.answer(self.core, card, "always_allow")
        self.assertEqual(self.core.config["read"]["tools"]["copilot"], ["workiq(fetch)", "workiq(retrieve)"],
                         "its lookup tools, never the one that acts")
        from fuzz import events
        self.assertEqual(events.task_log(self.core, tid)[0]["text"],
                         "You always allow WorkIQ mail. Fuzz can now use 2 of its lookup tools.")
        self.assertEqual(tools.whoami(self.core, "executor")["can_ask_for"], ["Ember MCP"])

    def test_allow_once_and_unknown_connectors_change_nothing(self):
        self.discover()
        _, card = self.asking("workiq")
        answers.answer(self.core, card, "allow_once")
        self.assertEqual(self.core.config["read"]["tools"]["copilot"], [])
        self.assertEqual(connectors.allow_for_grant(self.core, "Weather"), [])


class Folder(CoreCase):
    def setUp(self):
        super().setUp()
        self.out = tempfile.mkdtemp()
        self.addCleanup(__import__("shutil").rmtree, self.out, True)
        setup.set_folder(self.core, os.path.join(self.out, "Fuzz"))

    def claimed(self, text="Make me a launch checklist"):
        tid = tasks.capture(self.core, text)
        tasks.assign(self.core, tid)
        scheduler.claim_next(self.core, tid)
        return tid

    def test_each_task_gets_its_own_folder(self):
        tid = self.claimed("Make me a launch checklist: v2/final")
        d = tools.get_task(self.core, tid)["output_dir"]
        self.assertEqual(d, os.path.join(self.out, "Fuzz", f"{tid} Make me a launch checklist v2 final"))
        self.assertTrue(os.path.isdir(d))
        tasks.rename(self.core, tid, title="Launch checklist")
        self.assertEqual(outputs.task_dir(self.core, tid), d, "a rename keeps the folder")
        self.assertTrue(tools.whoami(self.core, "executor")["output_folder"].endswith("Fuzz"))

    def test_what_a_run_writes_is_recorded_and_overwritten_in_place(self):
        tid = self.claimed()
        d = tools.get_task(self.core, tid)["output_dir"]
        with open(os.path.join(d, "checklist.md"), "w") as f:
            f.write("- [ ] Docs")
        tools.release(self.core, tid)
        self.assertEqual([f["name"] for f in outputs.listing(self.core, tid)], ["checklist.md"])
        from fuzz import events
        self.assertEqual(events.task_log(self.core, tid)[0]["text"], "Saved checklist.md in your Fuzz folder.")
        with open(os.path.join(d, "checklist.md"), "w") as f:
            f.write("- [ ] Docs\n- [ ] Blog")
        self.assertEqual(outputs.record(self.core, tid), ["checklist.md"])
        self.assertEqual(len(outputs.listing(self.core, tid)), 1, "one file, updated")
        self.assertEqual(outputs.record(self.core, tid), [], "nothing changed, nothing new")

    def test_a_result_and_an_approved_note_are_saved_as_markdown(self):
        tid = self.claimed("Summarize the launch thread")
        tools.update_brief(self.core, tid, context_md="## Launch\n\nMoved to the 14th.")
        tools.hand_back(self.core, tid, result=True)
        with open(os.path.join(outputs.task_dir(self.core, tid), "Result.md")) as f:
            self.assertIn("Moved to the 14th.", f.read())
        nid = self.claimed("Write up the retro")
        drafts.save_draft(self.core, nid, "note", "", "## Retro\n\nShip smaller.")
        answers.answer(self.core, self.card_for(nid, "draft")["id"], "approve")
        with open(os.path.join(outputs.task_dir(self.core, nid), "Note.md")) as f:
            self.assertEqual(f.read(), "## Retro\n\nShip smaller.\n")

    def test_the_sender_gets_the_files_a_draft_attaches(self):
        tid = self.claimed("Send Priya the launch checklist")
        d = tools.get_task(self.core, tid)["output_dir"]
        with self.assertRaises(FuzzError) as e:
            tools.save_draft(self.core, tid, "email.new", "Priya", "Here it is.", attach=["checklist.md"])
        self.assertEqual(e.exception.field, "attach")
        with open(os.path.join(d, "checklist.md"), "w") as f:
            f.write("- [ ] Docs")
        tools.save_draft(self.core, tid, "email.new", "Priya", "Here it is.", attach=["checklist.md"])
        answers.answer(self.core, self.card_for(tid, "draft")["id"], "approve")
        s = tools.claim_next_send(self.core)["send"]
        self.assertEqual(s["attachments"], [{"name": "checklist.md", "path": os.path.join(d, "checklist.md")}])

    def test_no_folder_no_writing(self):
        setup.set_folder(self.core, None)
        tid = self.claimed()
        self.assertIsNone(tools.get_task(self.core, tid)["output_dir"])
        with self.assertRaises(FuzzError):
            tools.save_draft(self.core, tid, "email.new", "Priya", "Hi", attach=["x.md"])

    def test_runs_may_write_only_inside_the_folder(self):
        cc = adapters.get("claude-code").headless_command("executor", "/tmp/run.json", files_dir="/x/files",
                                                          write_dir="/o/Fuzz")
        self.assertEqual(cc[cc.index("--tools") + 1], "Read,Write,Edit")
        self.assertIn("Write(//o/Fuzz/**)", cc)
        self.assertIn("Edit(//o/Fuzz/**)", cc)
        self.assertIn("/o/Fuzz", cc)
        cp = adapters.get("copilot").headless_command("executor", "/tmp/run.json", write_dir="/o/Fuzz")
        self.assertIn("write(/o/Fuzz/**)", cp)
        self.assertNotIn("write", cp, "file writes aren't denied, or the allow would never apply")
        avail = cp[cp.index("--available-tools") + 1:]
        self.assertTrue({"view", "apply_patch", "create", "edit"} <= set(avail))
        plain = adapters.get("copilot").headless_command("executor", "/tmp/run.json")
        self.assertEqual(plain[plain.index("--deny-tool", plain.index("shell")) + 1], "write")

    def test_setup_state_and_done(self):
        st = setup.state(self.core, check=False)
        self.assertFalse(st["done"])
        self.assertTrue(st["folder"]["path"].endswith("Fuzz"))
        setup.finish(self.core)
        self.assertTrue(setup.state(self.core, check=False)["done"])
        with open(os.path.join(self.out, "file"), "w") as f:
            f.write("x")
        with self.assertRaises(FuzzError):
            setup.set_folder(self.core, os.path.join(self.out, "file"))



class ChooseFolder(unittest.TestCase):
    """The Mac's folder chooser, faked: osascript's answers, not a window."""

    def run_with(self, *answers, platform="darwin"):
        import subprocess
        results = [subprocess.CompletedProcess([], code, out, err) for code, out, err in answers]
        with mock.patch.object(setup.sys, "platform", platform), \
                mock.patch.object(setup.subprocess, "run", side_effect=results) as run:
            return setup.choose_folder("~/Documents/Fuzz"), run

    def test_picking_a_folder_gives_its_path(self):
        path, run = self.run_with((0, "/Users/me/Notes/Fuzz/\n", ""))
        self.assertEqual(path, "/Users/me/Notes/Fuzz")
        script = " ".join(run.call_args[0][0])
        self.assertIn('tell application "System Events"', script)
        self.assertIn("default location (POSIX file", script)

    def test_cancel_changes_nothing(self):
        self.assertIsNone(self.run_with((1, "", "execution error: User canceled. (-128)"))[0])

    def test_without_automation_it_opens_plainly(self):
        path, run = self.run_with((1, "", "Not authorized to send Apple events to System Events. (-1743)"),
                                  (0, "/Users/me/Fuzz/\n", ""))
        self.assertEqual(path, "/Users/me/Fuzz")
        self.assertNotIn("System Events", " ".join(run.call_args[0][0]))

    def test_a_mac_only(self):
        with self.assertRaises(FuzzError) as e:
            self.run_with(platform="linux")
        self.assertEqual(e.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
