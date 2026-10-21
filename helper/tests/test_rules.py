import copy
import unittest

from driftboard_helper.config import DEFAULTS, configProblems
from driftboard_helper.rules import claudePermissions, guidanceFor, rulesFor, unguarded


class AccessTest(unittest.TestCase):
    def testOtherMachinesAreDeniedUnlessTheUserOpensThemOneByOne(self):
        closed = claudePermissions()
        self.assertIn("Bash(ssh *)", closed["deny"])
        self.assertNotIn("Bash(ssh *)", closed["ask"])
        opened = claudePermissions({"ssh": "ask", "rsync": "allow"})
        self.assertNotIn("Bash(ssh *)", opened["deny"])
        self.assertIn("Bash(ssh *)", opened["ask"])
        self.assertEqual(opened["allow"], ["Bash(rsync *:*)"])

    def testAnyCommandTheUserNamesIsDeniedAskedOrAllowedLikewise(self):
        # A site's own CLI: every use waits for the user's yes.
        permissions = claudePermissions({"mc": "ask", "deploy": "deny"})
        self.assertTrue({"Bash(mc *)", "Bash(mc)"} <= set(permissions["ask"]))
        self.assertIn("Bash(deploy *)", permissions["deny"])
        guidance = " ".join(guidanceFor({"mc": "ask"}))
        self.assertIn("You may run mc when the card needs it: every use waits for the user's yes", guidance)

    def testWhatAnAgentHoldsBackTheUserCanLiftKindByKind(self):
        # The user: "I can't tell the agent to make an MR". By default it does when asked; Claude asks for a yes.
        permissions = claudePermissions()
        for rule in ("Bash(glab *mr create*)", "Bash(gh *pr create*)", "Bash(git *push*)", "Bash(curl *--data*)"):
            self.assertIn(rule, permissions["ask"])
            self.assertNotIn(rule, permissions["deny"])
        self.assertIn("Read(~/.ssh/**)", permissions["deny"])   # credentials stay never
        self.assertNotIn("code host", " ".join(rulesFor()))
        self.assertIn("Unless the user asks you to", " ".join(guidanceFor()))
        self.assertEqual(unguarded(None, None), ["glab", "gh", "git"])   # no stand-in in the way of what they ask
        never = claudePermissions(limits={"codeHost": "never", "chat": "never"})
        self.assertIn("Bash(glab *mr create*)", never["deny"])
        self.assertIn("Never write to a code host", " ".join(rulesFor(limits={"codeHost": "never"})))
        self.assertEqual(unguarded(None, {"codeHost": "never", "push": "never"}), [])

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
