import json
import os
import subprocess
import sys
import tempfile
import unittest

from driftboard_helper.outbox import OutboxReader, append

AGENT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "driftboard-agent")


class OutboxTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.directory.name, "outbox.jsonl")

    def tearDown(self):
        self.directory.cleanup()

    def agent(self, *arguments, stdin=None):
        return subprocess.run([AGENT, *arguments], input=stdin, capture_output=True, text=True,
                              env=dict(os.environ, DRIFTBOARD_OUTBOX=self.path))

    def testWhatTheAgentReportsIsReadOnceInOrder(self):
        self.assertEqual(self.agent("progress", "reading 12 invoices").returncode, 0)
        self.assertEqual(self.agent("result", "-", stdin="**2 mismatches**\n").returncode, 0)
        self.assertEqual(self.agent("move", "Review").returncode, 0)
        reader = OutboxReader(self.path)
        self.assertEqual([(entry["kind"], entry.get("text") or entry.get("column")) for entry, _offset in reader.read()],
                         [("progress", "reading 12 invoices"), ("result", "**2 mismatches**"), ("move", "Review")])
        reader.offset = reader.read()[-1][1]
        self.assertEqual(reader.read(), [])

    def testWhatTheBoardWouldRefuseIsRefusedAtOnce(self):
        refused = self.agent("move", "Done")
        self.assertNotEqual(refused.returncode, 0)
        long = self.agent("progress", "x" * 301)
        self.assertEqual((long.returncode, long.stderr.strip()), (1, "driftboard-agent: progress is longer than 300 characters"))
        nowhere = subprocess.run([AGENT, "progress", "x"], capture_output=True, text=True,
                                 env={key: value for key, value in os.environ.items() if key != "DRIFTBOARD_OUTBOX"})
        self.assertIn("only an agent the helper started can report", nowhere.stderr)

    def testAHalfWrittenLineWaitsAndABadOneIsSkipped(self):
        append(self.path, {"kind": "note", "text": "first"})
        with open(self.path, "a") as outbox:
            outbox.write("not json\n" + json.dumps({"kind": "move", "column": "Done"}) + "\n" + '{"kind": "note", "te')
        reader = OutboxReader(self.path)
        self.assertEqual([entry["text"] for entry, _offset in reader.read()], ["first"])
        with open(self.path, "a") as outbox:
            outbox.write('xt": "second"}\n')
        reader.offset = 0
        self.assertEqual([entry["text"] for entry, _offset in reader.read()], ["first", "second"])


if __name__ == "__main__":
    unittest.main()
