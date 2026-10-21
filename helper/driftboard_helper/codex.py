"""Codex as a card's agent: each turn is one `codex exec --json` in Codex's own sandbox
(workspace-write: the project folder and the card's run folder, no network), resumed with
`codex exec resume <thread>` for the next turn. Codex has no system-prompt flag, so the brief
leads the first prompt, and no settings file, so the environment (stand-ins first on PATH, the
outbox) is given to the process itself. Nothing ever waits for approval: what the sandbox does
not allow fails, and the agent asks the user with driftboard-agent instead."""

import json
import logging
import os
import signal
import subprocess
import time

from .claude import LaunchError

logger = logging.getLogger(__name__)

SANDBOX = ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"']


class CodexLauncher:
    tool = "codex"
    listingsLag = False   # its states are whether its process runs: never behind

    def __init__(self, directory, registry, model=None, command="codex", startTimeout=60):
        """registry: a file that keeps each thread's process and environment, so a restarted
        helper still knows which runs go on (they are in a session of their own) and how to wake them."""
        self.directory = directory
        self.registry = registry
        self.model = model
        self.command = command
        self.startTimeout = startTimeout
        self._children = {}   # pid -> Popen, for the runs this helper started: reaped when they end

    def _threads(self):
        try:
            with open(self.registry) as registry:
                return json.load(registry)
        except (OSError, ValueError):
            return {}

    def _remember(self, thread, pid, environment):
        threads = self._threads()
        threads[thread] = {"pid": pid, "environment": environment}
        descriptor = os.open(self.registry + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as registry:
            json.dump(threads, registry)
        os.replace(self.registry + ".new", self.registry)

    @staticmethod
    def _alive(pid):
        """Whether pid is still a codex process (and not a reused number)."""
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as cmdline:
                command = cmdline.read()
            with open("/proc/%d/stat" % pid) as stat:
                state = stat.read().rsplit(")", 1)[1].split()[0]
        except OSError:
            return False
        return b"codex" in command and state != "Z"   # a zombie has ended

    def _options(self, runFolder):
        options = SANDBOX + ["-c", "sandbox_workspace_write.writable_roots=%s" % json.dumps([runFolder]),
                             "--skip-git-repo-check"]
        return options + (["-m", self.model] if self.model else [])

    def _launch(self, command, environment, runFolder):
        """Start codex in a session of its own (it outlives a helper restart), its output to the run folder."""
        with open(os.path.join(runFolder, "codex.jsonl"), "ab") as log, open(os.path.join(runFolder, "codex.err"), "ab") as errors:
            start = log.tell()
            try:
                process = subprocess.Popen(command, cwd=self.directory, stdin=subprocess.DEVNULL, stdout=log, stderr=errors,
                                           env=dict(os.environ, **environment), start_new_session=True)
            except OSError as error:   # not installed, or not runnable
                raise LaunchError("%s could not be run: %s" % (self.command, error))
        self._children[process.pid] = process
        return process, start

    def _threadOf(self, runFolder, start, process):
        """The thread id Codex announces first ({"type": "thread.started", "thread_id": ...})."""
        deadline = time.time() + self.startTimeout
        while time.time() < deadline:
            with open(os.path.join(runFolder, "codex.jsonl"), "rb") as log:
                log.seek(start)
                for line in log:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get("type") == "thread.started" and event.get("thread_id"):
                        return event["thread_id"]
            if process.poll() is not None:
                break
            time.sleep(0.2)
        raise LaunchError("codex exec did not start a thread (see %s/codex.err)" % runFolder)

    def start(self, name, settingsPath, briefPath, prompt, environment=None):
        environment = environment or {}
        runFolder = environment["DRIFTBOARD_RUN"]
        with open(briefPath) as brief:
            text = brief.read() + "\n\n" + prompt
        process, start = self._launch([self.command, "exec", "--json"] + self._options(runFolder) + [text], environment,
                                      runFolder)
        try:
            thread = self._threadOf(runFolder, start, process)
        except LaunchError:
            self._killGroup(process.pid)   # unregistered, nothing else could stop it
            raise
        self._remember(thread, process.pid, environment)
        return thread

    def resume(self, sessionId, fullSessionId, message):
        known = self._threads().get(sessionId)
        if not known:
            raise LaunchError("no run of codex thread %s is known" % sessionId)
        self.stop(sessionId)
        environment = known["environment"]
        process, _start = self._launch([self.command, "exec", "--json"] + self._options(environment["DRIFTBOARD_RUN"])
                                       + ["resume", sessionId, message], environment, environment["DRIFTBOARD_RUN"])
        self._remember(sessionId, process.pid, environment)
        return sessionId

    def stop(self, sessionId):
        known = self._threads().get(sessionId)
        if not known or not self._alive(known["pid"]):
            return True
        return self._killGroup(known["pid"])

    def _killGroup(self, pid):
        for wanted in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, wanted)
            except OSError:
                return True
            for _ in range(50):
                if pid in self._children:
                    self._children[pid].poll()   # reap our own child, or it lingers as a zombie
                if not self._alive(pid):
                    return True
                time.sleep(0.2)
        return False

    def forget(self, sessionId):
        """A run the helper closed long ago: its thread leaves the registry."""
        threads = self._threads()
        if threads.pop(sessionId, None) is None:
            return
        descriptor = os.open(self.registry + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as registry:
            json.dump(threads, registry)
        os.replace(self.registry + ".new", self.registry)

    def attachCommand(self, run):
        """(argv, why not): Codex's own interactive view of the run's thread, in the same sandbox.
        Only between turns: a turn in flight is a `codex exec` of its own."""
        thread = run.get("session")
        known = self._threads().get(thread) if thread else None
        if not known or run.get("state") == "closed":
            return None, "the agent has no Codex thread yet"
        if self._alive(known["pid"]):
            return None, "Codex is in the middle of a turn: open it once the card says the turn is over"
        runFolder = known["environment"].get("DRIFTBOARD_RUN", "")
        options = SANDBOX + ["-c", "sandbox_workspace_write.writable_roots=%s" % json.dumps([runFolder])]
        return [self.command] + options + (["-m", self.model] if self.model else []) + ["resume", thread], None

    def states(self):
        """{thread id: (state, thread id)}: working while its codex process runs, done once it ended."""
        for pid, process in list(self._children.items()):
            if process.poll() is not None:
                del self._children[pid]
        return {thread: ("working" if self._alive(known["pid"]) else "done", thread)
                for thread, known in self._threads().items()}
