"""What an agent reports, as JSON lines in a file the helper reads: the agent needs no network
and no token (Codex's sandbox blocks the network), and the helper checks each report before it
reaches the board. The limits are the board's own."""

import fcntl
import json
import logging
import os
import time

logger = logging.getLogger(__name__)

TEXT_LIMITS = {"progress": 300, "say": 8000, "note": 20000, "ask": 2000, "result": 20000}
AGENT_COLUMNS = ("Working", "Coding", "Needs you", "Review")   # Coding: the agent is changing code
KINDS = tuple(TEXT_LIMITS) + ("move",)


def entryProblem(entry):
    """Why a report cannot go to the board, or None."""
    kind = entry.get("kind") if isinstance(entry, dict) else None
    if kind not in KINDS:
        return "a report is one of %s" % ", ".join(KINDS)
    if kind == "move":
        return None if entry.get("column") in AGENT_COLUMNS else "move to %s only" % ", ".join(AGENT_COLUMNS)
    text = entry.get("text")
    if not isinstance(text, str) or not text.strip():
        return "%s needs some text" % kind
    if len(text) > TEXT_LIMITS[kind]:
        return "%s is longer than %d characters" % (kind, TEXT_LIMITS[kind])
    return None


def append(path, entry):
    """Add one report (raises ValueError when it is not one the board would take)."""
    problem = entryProblem(entry)
    if problem:
        raise ValueError(problem)
    line = json.dumps(dict(entry, at=int(time.time() * 1000))) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a") as outbox:
        fcntl.flock(outbox, fcntl.LOCK_EX)   # two reports at once stay two whole lines
        outbox.write(line)


class OutboxReader:
    """Reads the reports added since its offset; a line still being written waits for the next read."""

    def __init__(self, path, offset=0):
        self.path = path
        self.offset = offset

    def read(self):
        """[(entry, offsetAfterIt)]: whole lines only, malformed ones logged and skipped."""
        try:
            with open(self.path, "rb") as outbox:
                outbox.seek(self.offset)
                data = outbox.read()
        except FileNotFoundError:
            return []
        entries, offset = [], self.offset
        for raw in data.splitlines(keepends=True):
            if not raw.endswith(b"\n"):
                break
            offset += len(raw)
            try:
                entry = json.loads(raw)
            except ValueError:
                logger.warning("%s: a line that is not JSON, skipped", self.path)
                continue
            problem = entryProblem(entry)
            if problem:
                logger.warning("%s: a report skipped: %s", self.path, problem)
                continue
            entries.append((entry, offset))
        return entries
