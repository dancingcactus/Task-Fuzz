"""Are you back at your desk? On a Mac, the HID idle time says how long since you last touched the
keyboard or mouse. Coming back after a while away fires the "When I'm back at my desk" tasks."""

import re
import subprocess
import sys

IDLE_RE = re.compile(r'"HIDIdleTime"\s*=\s*(\d+)')
ACTIVE_SECONDS = 60     # touched the machine in the last minute: you're here


def idle_seconds():
    """Seconds since the last keyboard or mouse input, or None where it can't be read."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem", "-d", "4"], capture_output=True, text=True,
                             timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = IDLE_RE.search(out)
    return int(m.group(1)) / 1e9 if m else None


class Watcher:
    """Reports "back" once each time you return after at least away_minutes away."""

    def __init__(self, away_minutes=15):
        self.away = away_minutes * 60
        self.was_away = False

    def check(self, idle):
        if idle is None:
            return False
        if idle >= self.away:
            self.was_away = True
            return False
        if self.was_away and idle < ACTIVE_SECONDS:
            self.was_away = False
            return True
        return False
