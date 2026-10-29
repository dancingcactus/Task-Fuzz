"""Claude Code: skills in ~/.claude/skills/, MCP through `claude mcp`, headless runs with `claude -p`."""

import json
import re
import subprocess

from .base import Adapter, home, skill_body, write_json


class ClaudeCode(Adapter):
    name = "claude-code"
    exe = "claude"
    label = "Claude Code"

    def skills_dir(self):
        return home() / ".claude" / "skills"

    def _claude(self, *args):
        return subprocess.run([self.exe, *args], capture_output=True, text=True, timeout=60)

    def register_mcp(self, role, fuzz_home=None, user_id=None):
        spec = dict(self.mcp_server(role, fuzz_home, user_id=user_id), type="stdio")
        self._claude("mcp", "remove", "--scope", "user", self.mcp_name(role))   # make add idempotent
        r = self._claude("mcp", "add-json", "--scope", "user", self.mcp_name(role), json.dumps(spec))
        if r.returncode != 0:
            raise RuntimeError(f"claude mcp add-json failed: {(r.stderr or r.stdout).strip()}")
        return {"kind": "mcp", "client": self.name, "name": self.mcp_name(role), "scope": "user"}

    def unregister_mcp(self, role):
        self._claude("mcp", "remove", "--scope", "user", self.mcp_name(role))

    def mcp_registered(self, role):
        try:
            return self._claude("mcp", "get", self.mcp_name(role)).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    def write_run_config(self, role, run_id, path, fuzz_home=None, user_id=None):
        spec = dict(self.mcp_server(role, fuzz_home, run_id, user_id), type="stdio")
        write_json(path, {"mcpServers": {self.mcp_name(role): spec}})
        return path

    def headless_command(self, role, config_path, model=None, task_id=None, verbose=False, files_dir=None,
                         send_tools=None, read_tools=None, write_dir=None):
        """Only Fuzz's server and its tools, nothing else allowed, nobody to ask. With files_dir, Read is the
        one built-in tool, allowed only inside that folder (`//` makes the rule's path absolute). With
        write_dir, Write and Edit join it, allowed only inside the output folder.

        The sender loads your own MCP servers and connectors (no --strict-mcp-config), since it sends with
        them. It may still call only Fuzz's sender tools and the send_tools you listed. The executor and the
        extractor load them too when you listed read_tools, and may call only those."""
        allowed = [f"mcp__{self.mcp_name(role)}__*"]
        extra = list((send_tools if role == "sender" else read_tools if role in ("executor", "extractor") else None)
                     or [])
        allowed += extra
        tools = []
        for d in (files_dir, write_dir):
            if d:
                tools = ["Read"]
                allowed.append(f"Read(/{str(d).rstrip('/')}/**)")
        if write_dir:
            tools += ["Write", "Edit"]
            allowed += [f"Write(/{str(write_dir).rstrip('/')}/**)", f"Edit(/{str(write_dir).rstrip('/')}/**)"]
        argv = [self.exe, "-p", self.prompt(role, task_id),
                "--mcp-config", str(config_path), *([] if extra or role == "sender" else ["--strict-mcp-config"]),
                "--tools", ",".join(tools),
                "--allowedTools", *allowed,
                "--permission-mode", "dontAsk",
                "--append-system-prompt", skill_body(role),
                "--no-session-persistence"]
        for d in (files_dir, write_dir):
            if d:
                argv += ["--add-dir", str(d)]
        if model:
            argv += ["--model", model]
        if verbose:
            argv += ["--output-format", "stream-json", "--verbose"]
        return argv

    def list_servers(self):
        """`claude mcp list` prints "claude.ai Gmail: https://... - ✔ Connected", one server a line."""
        try:
            out = subprocess.run([self.exe, "mcp", "list"], capture_output=True, text=True, timeout=120).stdout
        except (OSError, subprocess.TimeoutExpired):
            return []
        names = []
        for line in out.splitlines():
            m = re.match(r"^(.+?): \S.* - (.+)$", line.strip())
            if m and not m.group(1).startswith("fuzz-"):
                names.append({"name": m.group(1), "status": m.group(2).strip("✔✗! ").strip()})
        return names

    def discovery_command(self, prompt, model=None):
        """Your own servers loaded, no built-in tools, nothing allowed and nobody to ask: it can only answer."""
        return [self.exe, "-p", prompt, "--tools", "", "--permission-mode", "dontAsk", "--no-session-persistence",
                "--model", model or "haiku"]

    def run_ok(self, returncode, output):
        if returncode != 0:
            return False
        # stream-json ends with a result message; a plain run just exits 0
        for line in reversed((output or "").strip().splitlines()):
            try:
                msg = json.loads(line)
            except ValueError:
                return True
            if msg.get("type") == "result":
                return not msg.get("is_error")
        return True
