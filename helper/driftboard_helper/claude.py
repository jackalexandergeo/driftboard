"""Claude Code as a card's agent: one `claude --bg` session per card, woken with each answer.
A woken session reads its --settings file again, so what the helper rewrites there reaches it."""

import json
import logging
import re
import subprocess

logger = logging.getLogger(__name__)

SPAWNED = re.compile(r"backgrounded\s+·\s+([0-9a-f]{6,})\s+·")
ENDED = ("done", "stopped", "failed")
TIMED_OUT = -1


class LaunchError(Exception):
    pass


def runCommand(command, workingDirectory):
    """(exit status, stdout, stderr). Tests replace this."""
    try:
        result = subprocess.run(command, cwd=workingDirectory, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        return TIMED_OUT, error.stdout or "", "timed out after 120 s"
    except (OSError, subprocess.SubprocessError) as error:
        return 1, "", str(error)
    return result.returncode, result.stdout, result.stderr


class ClaudeLauncher:
    tool = "claude"

    def __init__(self, directory, run=runCommand):
        self.directory = directory
        self._run = run

    def start(self, name, settingsPath, briefPath, prompt, environment=None):
        """A new background session; its short id. Raises LaunchError. (environment: in the
        settings file already, for Claude.)"""
        status, output, errors = self._run(
            ["claude", "--bg", "-n", name, "--permission-mode", "auto", "--strict-mcp-config", "--mcp-config",
             json.dumps({"mcpServers": {}}), "--settings", settingsPath, "--append-system-prompt-file", briefPath, prompt],
            self.directory)
        return self._spawned(status, output, errors)

    def resume(self, sessionId, fullSessionId, message):
        """Wake a session that ended its turn, under its own id (flags would start a copy)."""
        self._run(["claude", "stop", sessionId], self.directory)
        status, output, errors = self._run(["claude", "--bg", "--resume", fullSessionId, message], self.directory)
        return self._spawned(status, output, errors)

    def stop(self, sessionId):
        status, _output, _errors = self._run(["claude", "stop", sessionId], self.directory)
        return status == 0

    def states(self):
        """{short id: (state, full id)} for every session `claude agents` knows, or None."""
        status, output, _errors = self._run(["claude", "agents", "--json", "--all"], self.directory)
        if status != 0:
            return None
        try:
            return {agent["id"]: (agent.get("state"), agent.get("sessionId")) for agent in json.loads(output)
                    if isinstance(agent, dict) and agent.get("id")}
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _spawned(status, output, errors):
        printed = (output or "") + (errors or "")
        match = SPAWNED.search(printed)
        if not match:
            raise LaunchError("claude --bg %s: %s" % ("timed out" if status == TIMED_OUT else "exited %d" % status,
                                                     printed.strip()[:300]))
        return match.group(1)
