import copy
import os
import subprocess
import tempfile
import unittest

from driftboard_helper.board import BoardClient
from driftboard_helper.checks import checks, report
from driftboard_helper.config import DEFAULTS

from .boards import NODE, Board

HELPER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "driftboard-helper")


@unittest.skipUnless(NODE, "needs node for the board")
class CheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.board = Board()

    @classmethod
    def tearDownClass(cls):
        cls.board.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = copy.deepcopy(DEFAULTS)
        self.config["agent"]["directory"] = self.directory.name
        self.config["board"].update(url=self.board.url, tokenFile=self.board.tokenFile)

    def tearDown(self):
        self.directory.cleanup()

    def check(self, which=lambda tool: "/usr/bin/" + tool, run=lambda command: (0, "1.0.0 (Claude Code)"), client=None):
        return report(checks(self.config, run, which, client))

    def testAWorkingSetupIsAllTicks(self):
        self.board.call("POST", "/api/items", {"source": "test", "title": "first"})   # makes Inbox
        lines, fine = self.check()
        self.assertTrue(fine, lines)
        self.assertTrue(all(line.startswith("✓") for line in lines))

    def testEachProblemSaysHowToFixIt(self):
        self.config["agent"]["tool"] = "codex"
        self.config["board"]["workspaces"] = ["Inbox", "Not there"]
        self.board.call("POST", "/api/items", {"source": "test", "title": "first"})
        lines, fine = self.check(which=lambda tool: None)
        self.assertFalse(fine)
        text = "\n".join(lines)
        self.assertIn("✗ codex is installed: codex is not on PATH: install Codex", text)
        self.assertIn("✗ the board 'Not there' exists: it is made by the first item posted to it", text)
        lines, _fine = self.check(run=lambda command: (1, "Not logged in"))
        self.assertIn("✗ codex is signed in: Not logged in", "\n".join(lines))

    def testABoardWithoutTheAgentsColumnsIsNamed(self):
        self.config["board"]["workspaces"] = ["My Board"]
        self.board.call("POST", "/api/items", {"source": "test", "title": "x", "workspace": "Bare", "column": "New"})
        workspace = next(summary for summary in self.board.call("GET", "/api/state")["workspaces"] if summary["name"] == "Bare")
        for binder in self.board.call("GET", "/api/workspaces/%s" % workspace["id"])["binders"]:
            if binder["title"] in ("Working", "Review"):
                self.board.call("DELETE", "/api/binders/%s" % binder["id"])
        self.config["board"]["workspaces"] = ["Bare"]
        lines, fine = self.check()
        self.assertIn("✗ the board 'Bare' has the agent's columns: add a column named 'Working' and 'Review'", "\n".join(lines))

    def testNoTokenOrNoBoardIsSaid(self):
        self.config["board"]["tokenFile"] = os.path.join(self.directory.name, "no-token")
        lines, _fine = self.check()
        self.assertIn("✗ the board's token is readable", "\n".join(lines))
        self.config["board"].update(tokenFile=self.board.tokenFile, url="http://127.0.0.1:9")
        lines, _fine = self.check()
        self.assertIn("is the board running?", "\n".join(lines))


class PythonVersionTest(unittest.TestCase):
    def testAnOldPythonIsNamedPlainly(self):
        with tempfile.TemporaryDirectory() as folder:
            fake = os.path.join(folder, "python3")
            with open(fake, "w") as script:
                script.write('#!/bin/sh\ncase "$1" in --version) echo "Python 3.10.12";; *) exit 1;; esac\n')
            os.chmod(fake, 0o755)
            ran = subprocess.run(["sh", HELPER, "check"], capture_output=True, text=True,
                                 env=dict(os.environ, PATH="%s:%s" % (folder, os.environ["PATH"])))
        self.assertEqual(ran.returncode, 1)
        self.assertIn("needs Python 3.11 or newer; python3 here is Python 3.10.12", ran.stderr)


if __name__ == "__main__":
    unittest.main()
