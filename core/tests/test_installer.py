"""The installer and adapters against a fake home folder, with stub `claude` and `copilot` executables.

Install, install again and uninstall leave config files exactly as expected, other entries
untouched, and nothing behind. Headless runs allow only Fuzz's server and tools, and a run
records its run id on every event.
"""

import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import HERE, CoreCase

from fuzz import adapters, doctor, engine, events, files, installer, runner, tasks
from fuzz.db import FuzzError


def tree(root):
    """Every path under root with its content. JSON files compare by value: editing a config in place
    keeps every entry but can't keep the exact formatting."""
    out = {}
    for p in sorted(Path(root).rglob("*")):
        rel = str(p.relative_to(root))
        if p.is_symlink():
            out[rel] = "link"
        elif p.is_dir():
            out[rel] = "dir"
        elif p.suffix == ".json":
            out[rel] = json.loads(p.read_text())
        else:
            out[rel] = p.read_text()
    return out


class FakeHome(CoreCase):
    def setUp(self):
        super().setUp()
        self.fake = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.fake, True)
        self.bin = os.path.join(self.fake, "bin")
        os.makedirs(self.bin)
        for name in ("claude", "copilot"):
            p = os.path.join(self.bin, name)
            with open(p, "w") as f:
                f.write(f"#!{sys.executable}\n" + open(os.path.join(HERE, "stub_client.py")).read())
            os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        # launchd labels are global: the real launchctl would swap your running com.fuzz.* jobs for these
        p = os.path.join(self.bin, "launchctl")
        with open(p, "w") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        env = mock.patch.dict(os.environ, {"HOME": self.fake, "PATH": self.bin + os.pathsep + os.environ["PATH"]})
        env.start()
        self.addCleanup(env.stop)
        doctor.clear_cache()
        # someone else's things that must survive
        Path(self.fake, ".claude").mkdir()
        Path(self.fake, ".claude", "settings.json").write_text('{"theme": "dark"}')
        Path(self.fake, ".copilot").mkdir()
        Path(self.fake, ".copilot", "mcp-config.json").write_text(
            json.dumps({"mcpServers": {"github": {"type": "http", "url": "https://example"}}, "trusted": True}))

    def stub_registry(self, name="claude"):
        p = Path(self.fake, f".stub-{name}.json")
        return json.loads(p.read_text()) if p.exists() else {}


class Install(FakeHome):
    def test_claude_code_install_reinstall_uninstall(self):
        before = tree(self.fake)
        out = installer.install(self.core, "claude-code")
        self.assertTrue(out["engine_set"], "the first client installed becomes the engine")
        self.assertEqual(self.core.config["engine"]["client"], "claude-code")
        skill = Path(self.fake, ".claude", "skills", "fuzz-executor", "SKILL.md")
        self.assertIn("prompt_version: executor-0.11", skill.read_text())
        reg = self.stub_registry()
        self.assertEqual(sorted(reg), ["fuzz-executor", "fuzz-extractor", "fuzz-sender"])
        self.assertEqual(reg["fuzz-executor"]["args"], ["-m", "fuzz", "mcp", "--role", "executor"])
        self.assertEqual(reg["fuzz-executor"]["env"]["FUZZ_HOME"], self.home)

        once = (tree(self.fake), installer.load_manifest(self.core))
        installer.install(self.core, "claude-code")
        self.assertEqual((tree(self.fake), installer.load_manifest(self.core)), once, "safe to run again")

        installer.uninstall(self.core, "claude-code")
        self.assertEqual(tree(self.fake), before, "uninstall leaves exactly what was there")
        self.assertIsNone(self.core.config["engine"]["client"])

    def test_copilot_after_claude_writes_skills_once_and_keeps_other_entries(self):
        before = tree(self.fake)
        installer.install(self.core, "claude-code")
        out = installer.install(self.core, "copilot")
        self.assertEqual((out["skills"], out["skills_via"]), ([], "claude-code"))
        self.assertFalse(Path(self.fake, ".copilot", "skills").exists(), "Copilot reads ~/.claude/skills/")
        cfg = json.loads(Path(self.fake, ".copilot", "mcp-config.json").read_text())
        self.assertEqual(sorted(cfg["mcpServers"]), ["fuzz-executor", "fuzz-extractor", "fuzz-sender", "github"])
        self.assertTrue(cfg["trusted"])
        self.assertEqual(cfg["mcpServers"]["fuzz-executor"]["type"], "local")
        installer.uninstall(self.core, "copilot")
        installer.uninstall(self.core, "claude-code")
        self.assertEqual(tree(self.fake), before)

    def test_copilot_alone_gets_its_own_skills(self):
        installer.install(self.core, "copilot", roles=["executor"])
        self.assertTrue(Path(self.fake, ".copilot", "skills", "fuzz-executor", "SKILL.md").exists())
        self.assertFalse(Path(self.fake, ".copilot", "skills", "fuzz-extract").exists())

    def test_link_symlinks_for_development(self):
        installer.install(self.core, "claude-code", link=True)
        p = Path(self.fake, ".claude", "skills", "fuzz-executor")
        self.assertTrue(p.is_symlink())
        self.assertEqual(p.resolve(), (adapters.SKILLS_SRC / "fuzz-executor").resolve())

    def test_never_overwrites_a_skill_it_did_not_install(self):
        Path(self.fake, ".claude", "skills", "fuzz-executor").mkdir(parents=True)
        with self.assertRaises(FuzzError):
            installer.install(self.core, "claude-code")


class Doctor(FakeHome):
    def test_ready_after_install_and_out_of_date_skills(self):
        st = {c["client"]: c for c in doctor.status(self.core, refresh=True)["clients"]}
        self.assertEqual(st["claude-code"]["summary"], "not_installed")
        installer.install(self.core, "claude-code")
        st = {c["client"]: c for c in doctor.status(self.core, refresh=True)["clients"]}
        c = st["claude-code"]
        self.assertEqual(c["summary"], "ready", c["fixes"])
        self.assertEqual([m["tools"] for m in c["mcp"]], [14, 5, 4], "each role's server starts with its tools")
        skill = Path(self.fake, ".claude", "skills", "fuzz-extract", "SKILL.md")
        skill.write_text(skill.read_text().replace("extract-0.2", "extract-0.0"))
        c = {c["client"]: c for c in doctor.status(self.core, refresh=True, check_start=False)["clients"]}["claude-code"]
        self.assertEqual(c["summary"], "needs_attention")
        self.assertIn("extract-0.0 → extract-0.2", c["first_fix"])
        engine.action(self.core, "claude-code", "update")
        c = {c["client"]: c for c in doctor.status(self.core, refresh=True, check_start=False)["clients"]}["claude-code"]
        self.assertEqual(c["summary"], "ready")

    def test_switching_only_offers_ready_clients_and_undo_switches_back(self):
        installer.install(self.core, "claude-code")
        installer.install(self.core, "copilot")
        engine.select(self.core, "copilot", "some-model")
        self.assertEqual(self.core.config["engine"], {"client": "copilot", "model": "some-model"})
        events.undo(self.core)
        self.assertEqual(self.core.config["engine"]["client"], "claude-code")
        installer.uninstall(self.core, "copilot")
        with self.assertRaises(FuzzError):
            engine.select(self.core, "copilot")


class Adapters(FakeHome):
    """The same checks for every client: a new client is supported when it passes these."""

    def argv(self, client, role="executor"):
        a = adapters.get(client)
        cfg = Path(self.home, "run.json")
        a.write_run_config(role, 42, cfg, self.home)
        return a, a.headless_command(role, cfg, "model-x", None, False), json.loads(cfg.read_text())

    def test_headless_runs_allow_only_fuzz(self):
        for client in adapters.ADAPTERS:
            a, argv, cfg = self.argv(client)
            self.assertEqual(list(cfg["mcpServers"]), ["fuzz-executor"], "the run sees Fuzz's server and no other")
            spec = cfg["mcpServers"]["fuzz-executor"]
            self.assertEqual(spec["args"][-2:], ["--run", "42"])
            self.assertIn("--model", argv)
            self.assertEqual(argv[argv.index("--model") + 1], "model-x")
            if client == "claude-code":
                self.assertIn("--strict-mcp-config", argv)
                self.assertEqual(argv[argv.index("--tools") + 1], "", "no built-in tools: no shell, no file writes")
                self.assertEqual(argv[argv.index("--allowedTools") + 1], "mcp__fuzz-executor__*")
            else:
                self.assertEqual(argv[argv.index("--allow-tool") + 1], "fuzz-executor")
                denied = [argv[i + 1] for i, x in enumerate(argv) if x == "--deny-tool"]
                self.assertEqual(denied, ["shell", "write"])

    def test_a_headless_run_records_its_run_on_every_event(self):
        for client in adapters.ADAPTERS:
            tid = tasks.capture(self.core, f"Reply to Elena ({client})")
            files.attach(self.core, tid, "thread.txt", b"Elena: can we move launch?")
            tasks.assign(self.core, tid)
            res = runner.run_role(self.core, "executor", client=client, model="model-x", say=lambda s: None)
            self.assertEqual(res["outcome"], "ok", res)
            self.assertEqual(self.task(tid)["state"], "review")
            self.assertIn("opened thread.txt: 26", [x["text"] for x in events.task_log(self.core, tid)])
            argv = json.loads(Path(self.home, "runs", str(res["run_id"]), "argv.json").read_text())
            self.assertIn(files.user_dir(self.core), argv, "the run is given the files folder")
            rows = self.core.all("SELECT DISTINCT run_id, model FROM events WHERE task_id=? AND actor='fuzz:executor'",
                                 (tid,))
            self.assertEqual(rows, [{"run_id": res["run_id"], "model": "model-x"}], client)
            runs_ = json.loads(Path(self.fake, f".stub-{adapters.get(client).exe}-runs.json").read_text())
            self.assertEqual(runs_[-1]["env_run"], str(res["run_id"]), "the run id is also in the environment")


if __name__ == "__main__":
    unittest.main()
