import copy
import unittest

from driftboard_helper.config import DEFAULTS, configProblems
from driftboard_helper.rules import claudePermissions, rulesFor


class AccessTest(unittest.TestCase):
    def testOtherMachinesAreDeniedUnlessTheUserOpensThemOneByOne(self):
        closed = claudePermissions()
        self.assertIn("Bash(ssh *)", closed["deny"])
        self.assertNotIn("ask", closed)
        opened = claudePermissions({"ssh": "ask", "rsync": "allow"})
        self.assertNotIn("Bash(ssh *)", opened["deny"])
        self.assertEqual((opened["ask"], opened["allow"]), (["Bash(ssh *)"], ["Bash(rsync *:*)"]))

    def testAnyCommandTheUserNamesIsDeniedAskedOrAllowedLikewise(self):
        # A site's own CLI: every use waits for the user's yes.
        permissions = claudePermissions({"mc": "ask", "deploy": "deny"})
        self.assertEqual(permissions["ask"], ["Bash(mc *)", "Bash(mc)"])
        self.assertIn("Bash(deploy *)", permissions["deny"])
        rules = " ".join(rulesFor({"mc": "ask"}))
        self.assertIn("You may run mc when the card needs it: every use waits for the user's yes", rules)

    def testTheConfigNamesWhatIsWrong(self):
        config = copy.deepcopy(DEFAULTS)
        config["agent"].update(directory="/tmp", tool="codex", access={"mc": "ask", "Bad Name": "deny", "ssh": "maybe"})
        self.assertEqual(configProblems(config), [
            'agent.access: mc = "ask" needs Claude Code: Codex cannot stop and ask you',
            "agent.access: Bad Name = 'deny': a command name, each deny, ask, allow",
            "agent.access: ssh = 'maybe': a command name, each deny, ask, allow"])
        config["agent"].update(tool="claude", access={}, directory="~")
        self.assertEqual(configProblems(config), ["agent.directory must be a project folder, not the home folder"])


if __name__ == "__main__":
    unittest.main()
