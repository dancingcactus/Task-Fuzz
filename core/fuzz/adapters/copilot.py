"""GitHub Copilot CLI: skills in ~/.copilot/skills/, MCP in its JSON config, headless runs with `copilot -p`.

The design doc marks two Copilot details "to confirm": the MCP config file and the per-run config
flag. They are the two constants below, so confirming them is a one-line change. FUZZ_RUN_ID is
also passed in the environment, so a run is still stamped if the flag is ignored.
"""

import json
import re
import subprocess

from .base import Adapter, home, read_json, skill_body, write_json

MCP_CONFIG = ".copilot/mcp-config.json"          # to confirm
RUN_CONFIG_FLAG = "--additional-mcp-config"      # to confirm; takes @<file>
ADD_DIR_FLAG = "--add-dir"                       # to confirm: that its file reads stay inside added folders
READ_FILE_TOOL = "view"                          # Copilot's built-in read-only file tool
WRITE_FILE_TOOLS = ("apply_patch", "create", "edit")   # its file-writing tools; which one a model has varies
# write(<folder>/**) allows writes anywhere under the folder and nowhere else; write(<folder>) alone matches
# nothing inside it. Checked against Copilot CLI 1.0.104, with --deny-tool write left off (deny always wins).
# --allow-tool only skips the confirmation prompt: Copilot still loads every server in ~/.copilot/mcp-config.json,
# and some of their tools run without one. --available-tools is what limits the model to the tools listed.
# The sender's send tools (config send.tools.copilot) and the executor's lookup tools (read.tools.copilot) are
# written as --allow-tool takes them: "Glean" for a whole server, "slack(send_message)" for one tool.
# --available-tools names one tool "slack-send_message". Neither flag takes a space: a server's spaces
# become hyphens ("Ember MCP" is "Ember-MCP"), and "Ember MCP(ask_ember)" fails the whole run with
# "Invalid rule format". allow_rule() and available_name() convert. Checked against Copilot CLI 1.0.104.


def available_name(pattern):
    """An --allow-tool pattern as --available-tools names it: "slack(send_message)" -> "slack-send_message"."""
    m = re.fullmatch(r"\s*([^()]+?)\s*(?:\(\s*([^()]*?)\s*\))?\s*", pattern)
    if not m:
        return pattern
    server, tool = m.group(1).replace(" ", "-"), m.group(2)
    return f"{server}-{tool}" if tool else server


def allow_rule(pattern):
    """An --allow-tool pattern as Copilot accepts it: "Ember MCP(ask_ember)" -> "Ember-MCP(ask_ember)"."""
    m = re.fullmatch(r"\s*([^()]+?)\s*(\(.*\))?\s*", pattern)
    return norm_server(m.group(1)) + (m.group(2) or "") if m else pattern


def norm_server(name):
    """A server name as Copilot prefixes its tools: "Ember MCP" -> "Ember-MCP"."""
    return name.replace(" ", "-")


class Copilot(Adapter):
    name = "copilot"
    exe = "copilot"
    label = "GitHub Copilot"

    def skills_dir(self):
        return home() / ".copilot" / "skills"

    def config_path(self):
        return home() / MCP_CONFIG

    def _spec(self, role, fuzz_home=None, run_id=None, user_id=None):
        s = self.mcp_server(role, fuzz_home, run_id, user_id)
        return {"type": "local", "command": s["command"], "args": s["args"], "env": s["env"], "tools": ["*"]}

    def register_mcp(self, role, fuzz_home=None, user_id=None):
        cfg = read_json(self.config_path())
        cfg.setdefault("mcpServers", {})[self.mcp_name(role)] = self._spec(role, fuzz_home, user_id=user_id)
        write_json(self.config_path(), cfg)
        return {"kind": "mcp", "client": self.name, "name": self.mcp_name(role), "file": str(self.config_path())}

    def unregister_mcp(self, role):
        p = self.config_path()
        if not p.exists():
            return
        cfg = read_json(p)
        if (cfg.get("mcpServers") or {}).pop(self.mcp_name(role), None) is not None:
            write_json(p, cfg)

    def mcp_registered(self, role):
        return self.mcp_name(role) in (read_json(self.config_path()).get("mcpServers") or {})

    def write_run_config(self, role, run_id, path, fuzz_home=None, user_id=None):
        write_json(path, {"mcpServers": {self.mcp_name(role): self._spec(role, fuzz_home, run_id, user_id)}})
        return path

    def headless_command(self, role, config_path, model=None, task_id=None, verbose=False, files_dir=None,
                         send_tools=None, read_tools=None, write_dir=None):
        """Allow Fuzz's server, deny the shell and file writes. Deny always wins. The sender may also call
        the send tools you listed, the executor the read tools. With write_dir, file writes are allowed
        inside that folder only, instead of denied.

        The executor and sender see only those tools (--available-tools), plus the read-only file tool
        when files_dir is given: Copilot loads your own MCP servers too, and allowing a tool doesn't
        hide the others. The extractor reads your sources with your connectors, so it sees them all, and
        may call the read tools without asking: with nobody there to approve, any other tool is refused."""
        prompt = skill_body(role) + "\n\n" + self.prompt(role, task_id)
        extra = list((send_tools if role == "sender" else read_tools if role in ("executor", "extractor") else None)
                     or [])
        argv = [self.exe, "-p", prompt, RUN_CONFIG_FLAG, f"@{config_path}",
                "--allow-tool", self.mcp_name(role), "--deny-tool", "shell"]
        argv += ["--allow-tool", f"write({str(write_dir).rstrip('/')}/**)"] if write_dir else ["--deny-tool", "write"]
        for t in extra:
            argv += ["--allow-tool", allow_rule(t)]
        if role in ("executor", "sender"):
            available = [self.mcp_name(role)] + [available_name(t) for t in extra]
            if files_dir or write_dir:
                available.append(READ_FILE_TOOL)
            if write_dir:
                available += list(WRITE_FILE_TOOLS)
            argv += ["--available-tools", *available]
        for d in (files_dir, write_dir):
            if d:
                argv += [ADD_DIR_FLAG, str(d)]
        if model:
            argv += ["--model", model]
        return argv

    def list_servers(self):
        """`copilot mcp list --json`: user, plugin and built-in servers. Only names and on/off are kept; the
        rest can hold secrets."""
        try:
            out = subprocess.run([self.exe, "mcp", "list", "--json"], capture_output=True, text=True, timeout=60).stdout
            servers = (json.loads(out or "{}").get("mcpServers") or {})
        except (OSError, subprocess.TimeoutExpired, ValueError, AttributeError):
            return []
        return [{"name": n, "status": "enabled" if (v or {}).get("enabled", True) else "disabled"}
                for n, v in servers.items() if not n.startswith("fuzz-")]

    def discovery_command(self, prompt, model=None):
        """Every tool visible, no shell and no file writes, nothing allowed: in -p mode it can't run any."""
        argv = [self.exe, "-p", prompt, "-s", "--deny-tool", "shell", "--deny-tool", "write"]
        if model:
            argv += ["--model", model]
        return argv

    def allow_name(self, tool, servers):
        """ "workiq-fetch" -> "workiq(fetch)", matching the longest server name so "Ember-MCP-ask" splits right."""
        for s in sorted((x["name"] for x in servers), key=len, reverse=True):
            pre = norm_server(s) + "-"
            if tool.startswith(pre) and len(tool) > len(pre):
                return f"{s}({tool[len(pre):]})"
        return tool
