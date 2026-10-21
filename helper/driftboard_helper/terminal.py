"""A card's agent in a terminal. Two ways in, both to the session the helper started, and the
agent keeps running when the terminal closes:

- a window of the user's own terminal app (↗ Terminal on the card), on any desktop: Linux (the
  one named in [terminal] app, else $TERMINAL, else the system's default terminal, else the
  first one found), macOS (Terminal) and Windows (Windows Terminal, else a console window);
- the board page (⌨ Terminal in the open card): the board relays the page's keys to a private
  socket of the helper's, which runs the same command in a pseudo-terminal. Linux and macOS only.

The socket speaks frames: one byte of kind (0 data, 1 control: JSON), four of length, the
payload. The board's first frame is control {"card", "cols", "rows"}; then data both ways, and
control {"resize": [cols, rows]} from the board, {"started"}, {"error"} or {"exited"} back."""

import json
import logging
import os
import platform
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

DATA, CONTROL = 0, 1
HEADER = struct.Struct(">BI")
MAX_FRAME = 1 << 20
SOCKET_NAME = "terminal.sock"

# Terminal apps and how each runs a command (what follows is the command and its arguments),
# tried in this order on Linux and the BSDs when nothing says which.
LINUX_APPS = (
    ("gnome-terminal", ["--"]), ("kgx", ["--"]), ("konsole", ["-e"]), ("xfce4-terminal", ["-x"]),
    ("terminator", ["-x"]), ("tilix", ["-e"]), ("kitty", []), ("alacritty", ["-e"]),
    ("wezterm", ["start", "--"]), ("foot", []), ("xterm", ["-e"]),
)
KNOWN_FLAGS = dict(LINUX_APPS, **{"gnome-terminal.wrapper": ["--"], "xfce4-terminal.wrapper": ["-x"],
                                  "konsole.wrapper": ["-e"], "terminator.wrapper": ["-x"]})
DESKTOP_APPS = {"GNOME": ("gnome-terminal", "kgx"), "KDE": ("konsole",), "XFCE": ("xfce4-terminal",)}


def known(name, argv):
    """name's own way to run argv, or the usual -e."""
    return [name] + KNOWN_FLAGS.get(os.path.basename(name), ["-e"]) + argv


def appCommand(argv, cwd, app=None, environ=None, which=shutil.which, system=None, realpath=os.path.realpath):
    """The command that opens argv in a terminal window, or None when no terminal app is found.
    app: the user's choice, an app's name ("terminator") or a command with "{command}" where
    argv goes (["kitty", "--hold", "{command}"])."""
    environ = os.environ if environ is None else environ
    system = system or platform.system()
    if isinstance(app, str) and app.strip():
        return known(app.strip(), argv)
    if app:
        return [part for word in app for part in (argv if word == "{command}" else [word])]
    if system == "Darwin":
        line = "cd %s && %s" % (shlex.quote(cwd), shlex.join(argv))
        script = line.replace("\\", "\\\\").replace('"', '\\"')
        return ["osascript", "-e", 'tell application "Terminal" to do script "%s"' % script,
                "-e", 'tell application "Terminal" to activate']
    if system == "Windows":
        if which("wt.exe") or which("wt"):
            return [which("wt.exe") or which("wt"), "-d", cwd] + argv
        return ["cmd", "/c", "start", "", "cmd", "/k", subprocess.list2cmdline(argv)]
    if environ.get("TERMINAL") and which(environ["TERMINAL"]):
        return known(environ["TERMINAL"], argv)
    default = which("x-terminal-emulator")   # the system's default terminal (Debian, Ubuntu and their kin)
    if default and os.path.basename(realpath(default)) in KNOWN_FLAGS:
        return known(os.path.basename(realpath(default)).replace(".wrapper", ""), argv)
    desktop = environ.get("XDG_CURRENT_DESKTOP", "").upper()
    preferred = [name for key, names in DESKTOP_APPS.items() if key in desktop for name in names]
    for name in preferred + [name for name, _flags in LINUX_APPS]:
        if which(name):
            return known(name, argv)
    return None


def openWindow(argv, cwd, app=None, popen=subprocess.Popen, **lookup):
    """Open argv in a terminal window, on its own (it outlives the helper). (True, the app) or (False, why)."""
    command = appCommand(argv, cwd, app, **lookup)
    if not command:
        return False, "no terminal app found (set [terminal] app in the helper's config)"
    try:
        popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
              start_new_session=True)
    except OSError as error:
        return False, "%s did not start: %s" % (command[0], error)
    return True, os.path.basename(command[0])


def boardTerminals():
    """Whether the board page can have a terminal here: it needs a pseudo-terminal."""
    try:
        import pty   # noqa: F401  (not on Windows)
        import termios   # noqa: F401
    except ImportError:
        return False
    return True


def sendFrame(connection, kind, payload):
    if kind == CONTROL:
        payload = json.dumps(payload).encode()
    connection.sendall(HEADER.pack(kind, len(payload)) + payload)


class FrameReader:
    def __init__(self, connection):
        self.connection = connection
        self.buffer = b""

    def frames(self):
        """The whole frames received so far; raises EOFError when the other side closed."""
        chunk = self.connection.recv(65536)
        if not chunk:
            raise EOFError
        self.buffer += chunk
        found = []
        while len(self.buffer) >= HEADER.size:
            kind, length = HEADER.unpack_from(self.buffer)
            if length > MAX_FRAME:
                raise EOFError
            if len(self.buffer) < HEADER.size + length:
                break
            payload = self.buffer[HEADER.size:HEADER.size + length]
            self.buffer = self.buffer[HEADER.size + length:]
            found.append((kind, json.loads(payload) if kind == CONTROL else payload))
        return found


class TerminalServer:
    """The helper's end of the board's terminals: a socket only this user can reach."""

    def __init__(self, path, commandFor, opened=None, closed=None):
        """commandFor(card id) -> (argv, cwd) or (None, why not); opened/closed(card id) are told."""
        self.path = path
        self.commandFor = commandFor
        self.opened = opened or (lambda cardId: None)
        self.closed = closed or (lambda cardId: None)
        self.listener = None

    def start(self):
        if os.path.exists(self.path):
            os.unlink(self.path)   # a helper before this one left it
        previous = os.umask(0o177)
        try:
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.listener.bind(self.path)
        finally:
            os.umask(previous)
        os.chmod(self.path, 0o600)
        self.listener.listen(8)
        threading.Thread(target=self._serve, name="terminals", daemon=True).start()
        logger.info("the board's terminals: %s", self.path)
        return self

    def stop(self):
        if self.listener:
            self.listener.close()
            self.listener = None

    def _serve(self):
        while self.listener:
            try:
                connection, _address = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._session, args=(connection,), name="terminal", daemon=True).start()

    def _session(self, connection):
        cardId, process, master = None, None, None
        reader = FrameReader(connection)
        try:
            hello = []
            while not hello:
                hello = reader.frames()
            kind, first = hello[0]
            if kind != CONTROL or not isinstance(first, dict) or not isinstance(first.get("card"), str):
                sendFrame(connection, CONTROL, {"error": "the first frame names the card"})
                return
            cardId = first["card"]
            argv, cwd = self.commandFor(cardId)
            if not argv:
                sendFrame(connection, CONTROL, {"error": cwd})
                return
            process, master = Child.start(argv, cwd, dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor"))
            self._resize(master, first.get("cols"), first.get("rows"))
            self.opened(cardId)
            sendFrame(connection, CONTROL, {"started": True, "command": shlex.join(argv)})
            logger.info("card %s: a terminal on the board runs %s", cardId, shlex.join(argv))
            pending = [frame for frame in hello[1:]]
            while True:
                for kind, payload in pending:
                    if kind == DATA:
                        os.write(master, payload)
                    elif isinstance(payload, dict) and isinstance(payload.get("resize"), list):
                        self._resize(master, *payload["resize"][:2])
                pending = []
                ready, _, _ = select.select([connection, master], [], [], 1.0)
                if master in ready:
                    try:
                        output = os.read(master, 65536)
                    except OSError:   # the program ended
                        output = b""
                    if not output:
                        sendFrame(connection, CONTROL, {"exited": process.wait(5)})
                        return
                    sendFrame(connection, DATA, output)
                if connection in ready:
                    pending = reader.frames()
        except (EOFError, OSError, ValueError, TimeoutError):
            pass   # the page went away, or the board did
        finally:
            if master is not None:
                os.close(master)
            if process is not None and process.poll() is None:
                process.end()
            if cardId and process is not None:
                self.closed(cardId)
            connection.close()

    @staticmethod
    def _resize(master, cols, rows):
        import fcntl
        import termios
        if isinstance(cols, int) and isinstance(rows, int) and 0 < cols < 1000 and 0 < rows < 1000:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))



class Child:
    """A program in a pseudo-terminal that is its controlling terminal (so it hears of resizes),
    in a session of its own."""

    def __init__(self, pid):
        self.pid = pid
        self.code = None

    @classmethod
    def start(cls, argv, cwd, environment):
        pid, master = os.forkpty()
        if pid == 0:   # the child: nothing here may return
            try:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, environment)
            finally:
                os._exit(127)
        return cls(pid), master

    def poll(self):
        if self.code is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.code = os.waitstatus_to_exitcode(status)
        return self.code

    def wait(self, seconds):
        deadline = time.time() + seconds
        while self.poll() is None:
            if time.time() > deadline:
                raise TimeoutError("%d is still running" % self.pid)
            time.sleep(0.05)
        return self.code

    def end(self):
        """Closing the terminal ends the program in it (the attach), never the agent's session."""
        for wanted in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.pid, wanted)
            except OSError:
                return
            try:
                self.wait(2)
                return
            except TimeoutError:
                continue
