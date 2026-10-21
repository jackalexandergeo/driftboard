import os
import socket
import sys
import tempfile
import time
import unittest

from driftboard_helper.terminal import CONTROL, DATA, FrameReader, TerminalServer, appCommand, boardTerminals, openWindow, sendFrame

ATTACH = ["claude", "attach", "abc123"]


def which(*present):
    return lambda name: "/usr/bin/%s" % name if name in present else None


class AppCommandTest(unittest.TestCase):
    def testTheUsersChoiceComesFirst(self):
        # The user: "make it so u can configure ur terminal preference too i like terminator".
        self.assertEqual(appCommand(ATTACH, "/w", app="terminator", which=which()), ["terminator", "-x"] + ATTACH)
        self.assertEqual(appCommand(ATTACH, "/w", app=["kitty", "--hold", "{command}"], which=which()),
                         ["kitty", "--hold"] + ATTACH)
        self.assertEqual(appCommand(ATTACH, "/w", app="my-term", which=which()), ["my-term", "-e"] + ATTACH)

    def testWithoutAChoiceTheSystemsDefaultThenTheDesktopsThenAnyFound(self):
        linux = dict(system="Linux", environ={"XDG_CURRENT_DESKTOP": "ubuntu:GNOME"})
        default = which("x-terminal-emulator", "gnome-terminal")
        self.assertEqual(appCommand(ATTACH, "/w", which=default, realpath=lambda path: "/usr/bin/terminator", **linux),
                         ["terminator", "-x"] + ATTACH)
        self.assertEqual(appCommand(ATTACH, "/w", which=which("gnome-terminal", "xterm"), **linux),
                         ["gnome-terminal", "--"] + ATTACH)
        self.assertEqual(appCommand(ATTACH, "/w", which=which("xterm"), system="Linux", environ={}), ["xterm", "-e"] + ATTACH)
        self.assertEqual(appCommand(ATTACH, "/w", which=which("kitty"), system="Linux", environ={"TERMINAL": "kitty"}),
                         ["kitty"] + ATTACH)
        self.assertIsNone(appCommand(ATTACH, "/w", which=which(), system="Linux", environ={}))

    def testMacAndWindowsUseTheirOwn(self):
        mac = appCommand(ATTACH, "/Users/pat/my work", system="Darwin")
        self.assertEqual(mac[0], "osascript")
        self.assertIn("cd '/Users/pat/my work' && claude attach abc123", mac[2])
        self.assertEqual(appCommand(ATTACH, "C:\\work", system="Windows", which=which("wt.exe")),
                         ["/usr/bin/wt.exe", "-d", "C:\\work"] + ATTACH)
        self.assertEqual(appCommand(ATTACH, "C:\\work", system="Windows", which=which()),
                         ["cmd", "/c", "start", "", "cmd", "/k", "claude attach abc123"])

    def testAWindowOutlivesTheHelperAndAFailureSaysWhy(self):
        started = []
        opened = openWindow(ATTACH, "/w", app="terminator", popen=lambda command, **options: started.append((command, options)))
        self.assertEqual(opened, (True, "terminator"))
        self.assertTrue(started[0][1]["start_new_session"])

        def missing(command, **options):
            raise FileNotFoundError(command[0])
        self.assertFalse(openWindow(ATTACH, "/w", app="terminator", popen=missing)[0])
        self.assertIn("no terminal app found", openWindow(ATTACH, "/w", which=which(), system="Linux", environ={})[1])


# A stand-in for `claude attach`: says its size, echoes what it is sent, and says its new size.
PROGRAM = r'''
import os, signal, sys, termios, struct, fcntl
def size(*_):
    rows, cols = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))[:2]
    sys.stdout.write("size %dx%d\n" % (cols, rows)); sys.stdout.flush()
signal.signal(signal.SIGWINCH, size)
size()
for line in sys.stdin:
    sys.stdout.write("got " + line); sys.stdout.flush()
'''


@unittest.skipUnless(boardTerminals(), "the board's terminals need a pseudo-terminal")
class TerminalServerTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.directory.name, "terminal.sock")
        self.opened, self.closed = [], []
        commands = {"card-1": ([sys.executable, "-c", PROGRAM], self.directory.name)}
        self.server = TerminalServer(self.path, lambda cardId: commands.get(cardId, (None, "this card has no agent")),
                                     opened=self.opened.append, closed=self.closed.append).start()

    def tearDown(self):
        self.server.stop()
        self.directory.cleanup()

    def connect(self, card, cols=100, rows=30):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(self.path)
        connection.settimeout(10)
        sendFrame(connection, CONTROL, {"card": card, "cols": cols, "rows": rows})
        return connection, FrameReader(connection)

    def until(self, reader, wanted):
        """Read until the output so far contains wanted; (output, controls)."""
        output, controls, deadline = b"", [], time.time() + 10
        while wanted.encode() not in output and time.time() < deadline:
            for kind, payload in reader.frames():
                if kind == DATA:
                    output += payload
                else:
                    controls.append(payload)
        return output.decode(errors="replace"), controls

    def testTheBoardsTerminalRunsTheSessionAndFollowsItsSize(self):
        connection, reader = self.connect("card-1")
        output, controls = self.until(reader, "size 100x30")
        self.assertIn("size 100x30", output)
        self.assertTrue(controls[0]["started"])
        sendFrame(connection, DATA, b"hello\n")
        self.assertIn("got hello", self.until(reader, "got hello")[0])
        sendFrame(connection, CONTROL, {"resize": [120, 40]})
        self.assertIn("size 120x40", self.until(reader, "size 120x40")[0])
        self.assertEqual(self.opened, ["card-1"])
        connection.close()   # the tab closes: the program in the terminal ends, and the helper hears of it
        deadline = time.time() + 10
        while not self.closed and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual(self.closed, ["card-1"])

    def testACardWithNoAgentSaysSo(self):
        _connection, reader = self.connect("card-2")
        frames = []
        while not frames:
            frames = reader.frames()
        self.assertEqual(frames[0], (CONTROL, {"error": "this card has no agent"}))
        self.assertEqual(self.opened, [])

    def testOnlyThisUserCanReachTheSocket(self):
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
