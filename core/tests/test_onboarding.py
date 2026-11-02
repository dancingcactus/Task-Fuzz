"""The onboarding: where you are in it, working hours, and the setup cards that come after it."""

import os
import unittest
from unittest import mock

from helpers import CoreCase
from test_http import Server

from fuzz import cli, installer, onboarding, outputs, scheduler, setup, tasks
from fuzz.db import FuzzError


class Progress(CoreCase):
    def test_a_new_store_needs_it_and_starts_at_the_form(self):
        v = onboarding.view(self.core)
        self.assertTrue(v["needed"])
        self.assertEqual(v["step"], "form")
        self.assertIsNone(v["setup_card"])

    def test_people_who_set_up_before_never_see_it(self):
        tasks.capture(self.core, "Already using Fuzz")
        self.assertFalse(onboarding.view(self.core)["needed"])

    def test_the_old_guided_setup_done_counts_too(self):
        setup.finish(self.core)
        self.assertFalse(onboarding.view(self.core)["needed"])

    def test_a_task_captured_during_it_doesnt_end_it(self):
        onboarding.update(self.core, {"step": "capture"})
        tid = tasks.capture(self.core, "Plan the offsite")
        v = onboarding.update(self.core, {"step": "wait", "task_id": tid})
        self.assertTrue(v["needed"])
        self.assertEqual((v["step"], v["task_id"]), ("wait", tid))

    def test_coming_back_resumes_at_the_same_step(self):
        onboarding.update(self.core, {"step": "intro", "name": "Justin"})
        again = self.make_core()
        v = onboarding.view(again)
        self.assertEqual((v["step"], v["name"]), ("intro", "Justin"))

    def test_bad_steps_and_tips_are_refused(self):
        with self.assertRaises(FuzzError):
            onboarding.update(self.core, {"step": "tour"})
        with self.assertRaises(FuzzError):
            onboarding.update(self.core, {"tips": "dictate"})

    def test_tips_are_said_once(self):
        onboarding.update(self.core, {"tips": ["dictate"]})
        v = onboarding.update(self.core, {"tips": ["dictate", "park"]})
        self.assertEqual(v["tips"], ["dictate", "park"])

    def test_skipping_finishes_it_and_the_old_setup_stays_closed(self):
        v = onboarding.update(self.core, {"skipped": True})
        self.assertTrue(v["done"] and v["skipped"])
        self.assertFalse(v["needed"])
        self.assertTrue(self.core.config["setup"]["done"])

    def test_show_me_around_again_starts_at_the_intro_and_keeps_answers(self):
        onboarding.update(self.core, {"name": "Justin", "tips": ["dictate"], "done": True})
        onboarding.answer_setup(self.core, "lookup", "not_now")
        v = onboarding.update(self.core, {"again": True})
        self.assertEqual((v["step"], v["done"], v["tips"], v["name"]), ("intro", False, [], "Justin"))
        self.assertTrue(v["needed"])
        self.assertEqual(v["setup"]["lookup"]["status"], "later")

    def test_a_damaged_file_starts_over(self):
        with open(os.path.join(self.home, "onboarding-u1.json"), "w") as f:
            f.write("{nope")
        self.assertEqual(onboarding.view(self.core)["step"], "form")


class Hours(CoreCase):
    def test_hours_set_when_fuzz_reads(self):
        onboarding.set_hours(self.core, {"hours": [9, 17.5], "weekends": False})
        self.assertEqual(self.core.config["extract"], {"hours": [9, 17.5], "weekends": False})
        # Tuesday 9:00 UTC is inside; Saturday isn't
        self.assertTrue(scheduler.extract_hours(self.core))
        self.clock.advance(days=4)
        self.assertFalse(scheduler.extract_hours(self.core))

    def test_no_fixed_hours_reads_around_the_clock(self):
        h = onboarding.set_hours(self.core, {"hours": None})
        self.assertEqual(h, {"hours": None, "weekends": True})
        self.clock.advance(days=4, hours=14)
        self.assertTrue(scheduler.extract_hours(self.core))
        self.assertTrue(onboarding.view(self.core)["hours_set"])

    def test_bad_hours_are_refused(self):
        for bad in ([17, 9], [9], ["9", "17"], [0, 25], [True, 5]):
            with self.assertRaises(FuzzError, msg=bad):
                onboarding.set_hours(self.core, {"hours": bad})
        with self.assertRaises(FuzzError):
            onboarding.set_hours(self.core, {"hours": [9, 17], "weekends": "yes"})


class SetupCards(CoreCase):
    def setUp(self):
        super().setUp()
        self.folder = os.path.join(self.home, "Documents", "Fuzz")
        p = mock.patch.object(setup, "SUGGESTED_FOLDER", self.folder)
        p.start()
        self.addCleanup(p.stop)

    def card(self):
        c = onboarding.view(self.core)["setup_card"]
        return c and c["name"]

    def test_none_until_the_onboarding_is_over(self):
        self.assertIsNone(self.card())
        onboarding.update(self.core, {"done": True})
        self.assertEqual(self.card(), "lookup")

    def test_in_order_one_at_a_time(self):
        onboarding.update(self.core, {"done": True})
        onboarding.answer_setup(self.core, "lookup", "yes")
        self.assertEqual(self.card(), "folder")
        v = onboarding.answer_setup(self.core, "folder", "yes")
        self.assertEqual(outputs.folder(self.core), self.folder)
        self.assertTrue(os.path.isdir(self.folder))
        self.assertIsNone(v["setup_card"])   # the theme card waits a few days
        self.clock.advance(days=3)
        self.assertEqual(self.card(), "theme")
        onboarding.answer_setup(self.core, "theme", "yes")
        self.assertIsNone(self.card())

    def test_not_now_comes_back_at_most_once(self):
        onboarding.update(self.core, {"done": True})
        onboarding.answer_setup(self.core, "lookup", "not_now")
        self.assertIsNone(self.card())   # it holds its place; nothing jumps ahead of it
        self.clock.advance(days=1)
        c = onboarding.view(self.core)["setup_card"]
        self.assertEqual((c["name"], c["again"]), ("lookup", True))
        onboarding.answer_setup(self.core, "lookup", "not_now")
        self.assertEqual(self.card(), "folder")   # gone for good; the next one's turn

    def test_what_is_already_set_never_asks(self):
        cfg = self.core.config
        cfg["engine"] = {"client": "copilot", "model": None}
        cfg["read"]["tools"]["copilot"] = ["Glean"]
        self.core.save_config(cfg)
        setup.set_folder(self.core, self.folder)
        onboarding.update(self.core, {"done": True})
        self.assertIsNone(self.card())
        self.clock.advance(days=3)
        self.assertEqual(self.card(), "theme")

    def test_unknown_cards_and_answers_are_refused(self):
        with self.assertRaises(FuzzError):
            onboarding.answer_setup(self.core, "slack", "yes")
        with self.assertRaises(FuzzError):
            onboarding.answer_setup(self.core, "folder", "maybe")


class Routes(Server):
    def test_onboarding_hours_and_setup_cards_over_http(self):
        status, v = self.req("GET", "/onboarding")
        self.assertEqual((status, v["step"], v["needed"]), (200, "form", True))
        self.assertEqual(self.req("PUT", "/onboarding", {"step": "intro", "name": "Justin"})[1]["step"], "intro")
        self.assertEqual(self.req("PUT", "/onboarding", {"step": "nope"})[0], 400)
        self.assertEqual(self.req("PUT", "/hours", {"hours": [8, 16], "weekends": True})[1],
                         {"hours": [8, 16], "weekends": True})
        self.assertEqual(self.req("GET", "/hours")[1]["hours"], [8, 16])
        self.req("PUT", "/onboarding", {"done": True})
        status, v = self.req("POST", "/onboarding/setup/lookup", {"answer": "not_now"})
        self.assertEqual((status, v["setup"]["lookup"]["status"]), (200, "later"))
        self.assertEqual(self.req("POST", "/onboarding/setup/nope", {"answer": "yes"})[0], 404)

    def test_the_quick_engine_check_doesnt_start_servers(self):
        with mock.patch("fuzz.doctor._check_start") as starts:
            status, st = self.req("GET", "/engine?start=0")
        self.assertEqual(status, 200)
        self.assertEqual({c["client"] for c in st["clients"]}, {"claude-code", "copilot"})
        starts.assert_not_called()


class Start(CoreCase):
    """`fuzz start`: the bootstrap's last step."""

    def run_start(self, *extra, healthy=(True,)):
        answers = iter(healthy)
        args = cli.parser().parse_args(["--home", self.home, "start", "--no-open", "--wait", "1", *extra])
        with mock.patch.object(cli, "_healthy", side_effect=lambda *a, **k: next(answers, healthy[-1])), \
                mock.patch.object(installer, "start_service", return_value=False) as svc, \
                mock.patch("subprocess.Popen") as popen, mock.patch("webbrowser.open") as browser, \
                mock.patch("builtins.print") as out:
            args.fn(args)
        return svc, popen, browser, out

    def test_already_running_just_prints_the_signed_in_link(self):
        svc, popen, browser, out = self.run_start()
        svc.assert_not_called()
        popen.assert_not_called()
        browser.assert_not_called()   # --no-open
        self.assertIn("?token=", out.call_args[0][0])

    def test_not_running_starts_it_in_the_background_and_waits(self):
        svc, popen, browser, out = self.run_start(healthy=(False, False, True))
        svc.assert_called_once()
        self.assertEqual(popen.call_args[0][0][-3:], ["serve", "--port", "8765"])
        self.assertTrue(os.path.exists(os.path.join(self.home, "serve.pid")))

    def test_a_server_that_never_answers_says_so(self):
        with self.assertRaises(FuzzError):
            self.run_start(healthy=(False,))

    def test_the_mac_job_is_serve_alone_until_a_client_is_installed(self):
        with mock.patch.object(installer.sys, "platform", "darwin"), \
                mock.patch.object(installer.shutil, "which", return_value="/bin/launchctl"), \
                mock.patch.object(installer, "_write_launchd", return_value={"plists": [], "created": []}) as w:
            self.assertTrue(installer.start_service(self.core))
            self.assertEqual(w.call_args.kwargs["roles"], ())
            installer.save_manifest(self.core, dict(installer.load_manifest(self.core), copilot={"roles": []}))
            installer.start_service(self.core)
            self.assertEqual(w.call_args.kwargs["roles"], installer.ROLES)


if __name__ == "__main__":
    unittest.main()
