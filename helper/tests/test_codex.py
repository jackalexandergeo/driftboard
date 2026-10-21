import copy
import json
import os
import stat
import tempfile
import time
import unittest

from driftboard_helper.board import BoardClient
from driftboard_helper.codex import CodexLauncher
from driftboard_helper.config import DEFAULTS
from driftboard_helper.helper import Helper

from .boards import NODE, Board

# `codex exec --json` as far as the helper can tell: it announces its thread, plays one scripted
# turn through the real driftboard-agent (found on the PATH the helper gives it), and exits.
FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, subprocess, sys, uuid
arguments = sys.argv[1:]
log = json.load(open(os.environ["FAKE_CODEX_LOG"])) if os.path.exists(os.environ["FAKE_CODEX_LOG"]) else []
if "resume" in arguments:
    thread, message = arguments[arguments.index("resume") + 1], arguments[-1]
else:
    thread, message = str(uuid.uuid4()), arguments[-1]
turn = len([entry for entry in log if entry["thread"] == thread])
log.append({"thread": thread, "arguments": arguments, "message": message, "path": os.environ["PATH"]})
json.dump(log, open(os.environ["FAKE_CODEX_LOG"], "w"))
print(json.dumps({"type": "thread.started", "thread_id": thread}), flush=True)
for kind, text in json.load(open(os.environ["FAKE_CODEX_TURNS"]))[turn]:
    subprocess.run(["driftboard-agent", kind, text], check=True, capture_output=True)
print(json.dumps({"type": "turn.completed"}), flush=True)
'''


@unittest.skipUnless(NODE, "needs node for the board")
class CodexTest(unittest.TestCase):
    def setUp(self):
        self.board = Board()
        self.directory = tempfile.TemporaryDirectory()
        root = self.directory.name
        self.project, self.state = os.path.join(root, "project"), os.path.join(root, "state")
        os.makedirs(self.project)
        os.makedirs(self.state)
        self.fake = os.path.join(root, "bin", "codex")
        os.makedirs(os.path.dirname(self.fake))
        with open(self.fake, "w") as script:
            script.write(FAKE_CODEX)
        os.chmod(self.fake, stat.S_IRWXU)
        self.log, turns = os.path.join(root, "codex-log.json"), os.path.join(root, "turns.json")
        with open(turns, "w") as turnsFile:
            json.dump([[["progress", "reading the ledger"], ["ask", "Which month?"]],
                       [["result", "**Done**: October"], ["move", "Review"]]], turnsFile)
        os.environ.update(FAKE_CODEX_LOG=self.log, FAKE_CODEX_TURNS=turns)
        self.config = copy.deepcopy(DEFAULTS)
        self.config["agent"].update(tool="codex", directory=self.project, model="gpt-test")

    def tearDown(self):
        os.environ.pop("FAKE_CODEX_LOG", None)
        os.environ.pop("FAKE_CODEX_TURNS", None)
        self.board.close()
        self.directory.cleanup()

    def helper(self):
        launcher = CodexLauncher(self.project, os.path.join(self.state, "codex.json"), model="gpt-test", command=self.fake)
        return Helper(self.config, BoardClient(self.board.url, self.board.tokenFile), launcher, self.state)

    def calls(self):
        with open(self.log) as log:
            return json.load(log)

    def untilIdle(self, helper, cardId):
        for _ in range(100):
            helper.passOnce()
            if helper.state["runs"][cardId]["state"] == "idle":
                return
            time.sleep(0.1)
        self.fail("the codex turn did not end")

    def testCodexWorksTheCardInItsSandboxAndIsWokenByAReplyEvenAfterARestart(self):
        cardId = self.board.call("POST", "/api/items", {"source": "test", "title": "Close the books"})["cardId"]
        helper = self.helper()
        helper.passOnce()
        self.board.call("POST", "/api/cards/%s/press" % cardId, {"button": "start"})
        self.untilIdle(helper, cardId)
        self.assertEqual(self.board.column(cardId), "Needs you")
        first = self.calls()[0]
        run = helper.state["runs"][cardId]["folder"]
        self.assertIn('sandbox_mode="workspace-write"', first["arguments"])
        self.assertIn('approval_policy="never"', first["arguments"])
        self.assertIn("sandbox_workspace_write.writable_roots=%s" % json.dumps([run]), first["arguments"])
        self.assertEqual(first["arguments"][first["arguments"].index("-m") + 1], "gpt-test")
        self.assertTrue(first["message"].startswith("# You are an agent working on a card"))   # the brief leads
        self.assertEqual(first["path"].split(os.pathsep)[0], os.path.join(run, "guards"))   # stand-ins first
        restarted = self.helper()   # a new helper, as after a restart: the run goes on from the registry
        self.board.call("POST", "/api/cards/%s/press" % cardId, {"button": "reply", "text": "October."})
        self.untilIdle(restarted, cardId)
        second = self.calls()[1]
        self.assertEqual((second["arguments"][second["arguments"].index("resume") + 1], second["message"]),
                         (first["thread"], "The user replied: October."))
        card = self.board.call("GET", "/api/cards/%s" % cardId)["card"]
        self.assertEqual((self.board.column(cardId), card["agent"]["result"]), ("Review", "**Done**: October"))


if __name__ == "__main__":
    unittest.main()
