"""Client adapters. Claude Code and GitHub Copilot come first; Codex is a later third adapter."""

from .base import ROLE_SKILLS, SKILLS_SRC, Adapter, skill_version
from .claude_code import ClaudeCode
from .copilot import Copilot

ADAPTERS = {a.name: a for a in (ClaudeCode(), Copilot())}


def get(name):
    from ..db import FuzzError
    if name not in ADAPTERS:
        raise FuzzError(f"client must be one of {', '.join(ADAPTERS)}", "client")
    return ADAPTERS[name]


__all__ = ["ADAPTERS", "ROLE_SKILLS", "SKILLS_SRC", "Adapter", "get", "skill_version"]
