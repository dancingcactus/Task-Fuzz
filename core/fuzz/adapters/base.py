"""Everything that differs between AI clients lives in one adapter per client.

Nothing else in the core, and nothing in the skills, knows which client is running. Adding a
client means writing an adapter and passing the adapter tests (tests/test_adapters.py).
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROLE_SKILLS = {"executor": "fuzz-executor", "extractor": "fuzz-extract", "sender": "fuzz-send"}
SKILLS_SRC = Path(__file__).resolve().parents[2] / "skills"
PKG_PARENT = str(Path(__file__).resolve().parents[2])   # the folder holding the fuzz package

PROMPTS = {
    "executor": ("Work through the Fuzz queue using the fuzz-executor instructions. Call whoami first, then "
                 "claim_next_task and work each task until there is nothing to claim."),
    "extractor": ("Run Fuzz extraction using the fuzz-extract instructions. Call whoami and get_cursors, read the "
                  "sources, submit signals, judge the pending shortlists and submit verdicts."),
    "sender": ("Send the drafts the human approved, using the fuzz-send instructions. Call whoami, then "
               "claim_next_send and send each one until there is nothing to claim."),
}


def home():
    return Path(os.path.expanduser("~"))


def skill_version(path):
    """prompt_version from a SKILL.md's frontmatter, or None."""
    p = Path(path) / "SKILL.md"
    if not p.exists():
        return None
    text = p.read_text()
    if not text.startswith("---"):
        return None
    for line in text.split("---", 2)[1].splitlines():
        if line.strip().startswith("prompt_version:"):
            return line.split(":", 1)[1].strip().strip("\"'")
    return None


def skill_body(role):
    text = (SKILLS_SRC / ROLE_SKILLS[role] / "SKILL.md").read_text()
    return text.split("---", 2)[2].strip() if text.startswith("---") else text


class Adapter:
    name = None
    exe = None
    label = None

    # ---- the client
    def find(self):
        path = shutil.which(self.exe)
        if not path:
            return {"found": False}
        try:
            out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=20)
            version = (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else None
        except (OSError, subprocess.TimeoutExpired):
            version = None
        return {"found": True, "path": path, "version": version}

    # ---- skills
    def skills_dir(self):
        raise NotImplementedError

    # ---- MCP
    def mcp_name(self, role):
        return f"fuzz-{role}"

    def mcp_server(self, role, fuzz_home=None, run_id=None, user_id=None):
        """How a client starts Fuzz's server: this Python, the fuzz package, the role."""
        args = ["-m", "fuzz", "mcp", "--role", role]
        if run_id:
            args += ["--run", str(run_id)]
        env = {"PYTHONPATH": PKG_PARENT}
        if fuzz_home:
            env["FUZZ_HOME"] = str(fuzz_home)
        if user_id and int(user_id) != 1:
            env["FUZZ_USER"] = str(user_id)
        if run_id:
            env["FUZZ_RUN_ID"] = str(run_id)
        return {"command": sys.executable, "args": args, "env": env}

    def register_mcp(self, role, fuzz_home=None, user_id=None):
        raise NotImplementedError

    def unregister_mcp(self, role):
        raise NotImplementedError

    def mcp_registered(self, role):
        raise NotImplementedError

    # ---- headless runs
    def write_run_config(self, role, run_id, path, fuzz_home=None, user_id=None):
        raise NotImplementedError

    def headless_command(self, role, config_path, model=None, task_id=None, verbose=False, files_dir=None,
                         send_tools=None, read_tools=None):
        """files_dir: the user's attachments folder, the only place the run may read files from.
        send_tools: for the sender, the connector tools it may call to send, as this client names them.
        read_tools: for the executor, the connector tools it may call to look things up."""
        raise NotImplementedError

    def prompt(self, role, task_id=None):
        p = PROMPTS[role]
        if task_id and role == "executor":
            p += f" Work only task {task_id}: pass task_id={task_id} to claim_next_task."
        return p

    def run_ok(self, returncode, output):
        return returncode == 0

    def run_env(self, run_id):
        return dict(os.environ, FUZZ_RUN_ID=str(run_id))


def read_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return {} if default is None else default
    text = p.read_text().strip()
    return json.loads(text) if text else ({} if default is None else default)


def write_json(path, data):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".fuzz-tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, p)
