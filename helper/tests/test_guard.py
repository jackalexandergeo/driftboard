import os
import subprocess
import tempfile
import unittest

from driftboard_helper.guard import REFUSED, verdict, writeGuards

FETCH = ["-o", "SendEnv=GIT_PROTOCOL", "git@git.example.com", "git-upload-pack 'g/app.git'"]
PUSH = ["-o", "SendEnv=GIT_PROTOCOL", "git@git.example.com", "git-receive-pack 'g/app.git'"]


class SshTest(unittest.TestCase):
    def testSshCarriesOnlyGitToTheNamedHostsAndPushesOnlyWhenTheUserLetsIt(self):
        hosts = ["git.example.com"]
        self.assertIsNone(verdict("ssh", FETCH, hosts))
        self.assertIsNotNone(verdict("ssh", PUSH, hosts))
        self.assertIsNone(verdict("ssh", PUSH, hosts, pushOpen=True))
        for arguments in (["git@elsewhere", FETCH[3]], ["-L", "8080:localhost:80"] + FETCH[2:], FETCH[2:3] + ["rm -rf /"],
                          FETCH + ["extra"]):
            self.assertIsNotNone(verdict("ssh", arguments, hosts, pushOpen=True), arguments)


class StandInTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.real = os.path.join(self.directory.name, "real")
        os.makedirs(self.real)
        with open(os.path.join(self.real, "ssh"), "w") as script:
            script.write('#!/bin/sh\necho "ssh ran"\n')
        os.chmod(os.path.join(self.real, "ssh"), 0o755)

    def tearDown(self):
        self.directory.cleanup()

    def ssh(self, pinned, **environment):
        guards = writeGuards(os.path.join(self.directory.name, "guards"), pinned=pinned)
        return subprocess.run(["ssh"] + PUSH, capture_output=True, text=True,
                              env=dict(os.environ, PATH="%s:%s:%s" % (guards, self.real, os.environ["PATH"]), **environment))

    def testWhatTheStandInWasWrittenWithIsWhatHolds(self):
        opened = {"gitHosts": ["git.example.com"], "push": True}
        self.assertEqual(self.ssh(opened).stdout.strip(), "ssh ran")
        held = dict(opened, push=False)
        self.assertEqual(self.ssh(held, DRIFTBOARD_GUARD_PUSH="1").returncode, REFUSED)   # the agent cannot open it
        self.assertEqual(self.ssh(opened, DRIFTBOARD_GIT_HOSTS="elsewhere").stdout.strip(), "ssh ran")   # nor move it
        self.assertEqual(self.ssh(None, DRIFTBOARD_GIT_HOSTS="git.example.com", DRIFTBOARD_GUARD_PUSH="1").returncode,
                         REFUSED)   # unpinned: git never pushes


if __name__ == "__main__":
    unittest.main()
