"""A real driftboard server for the tests, on a free port with its own data folder."""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE = shutil.which("node")


class Board:
    def __init__(self, signIn=True):
        self.data = tempfile.mkdtemp(prefix="driftboard-helper-test-")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.url = "http://127.0.0.1:%d" % self.port
        self.process = subprocess.Popen([NODE, os.path.join(REPO, "server.js")], stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, env=dict(os.environ, PORT=str(self.port),
                                        DRIFTBOARD_DATA=self.data, DRIFTBOARD_SIGN_IN="on" if signIn else "off"))
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:
                self._opener.open(self.url + "/api/hello?nonce=x", timeout=1).close()
                if os.path.exists(self.tokenFile):
                    break
            except OSError:
                time.sleep(0.1)

    @property
    def tokenFile(self):
        return os.path.join(self.data, "token")

    def call(self, method, path, body=None):
        with open(self.tokenFile) as tokenFile:
            token = tokenFile.read().strip()
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                                         method=method, headers={"Authorization": "Bearer " + token,
                                                                 "Content-Type": "application/json"})
        with self._opener.open(request, timeout=10) as response:
            return json.loads(response.read() or b"null")

    def upload(self, cardId, name, mimeType, data):
        """A file attached to the card, as the board's page uploads one."""
        boundary = "driftboard-test-boundary"
        body = b"".join([("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                          "Content-Type: %s\r\n\r\n" % (boundary, name, mimeType)).encode(), data,
                         ("\r\n--%s--\r\n" % boundary).encode()])
        with open(self.tokenFile) as tokenFile:
            token = tokenFile.read().strip()
        request = urllib.request.Request(self.url + "/api/cards/%s/attachments" % cardId, data=body, method="POST",
                                         headers={"Authorization": "Bearer " + token,
                                                  "Content-Type": "multipart/form-data; boundary=" + boundary})
        with self._opener.open(request, timeout=10) as response:
            return json.loads(response.read())

    def column(self, cardId):
        found = self.call("GET", "/api/cards/%s" % cardId)
        workspace = self.call("GET", "/api/workspaces/%s" % found["workspaceId"])
        return next(binder["title"] for binder in workspace["binders"] if binder["id"] == found["card"]["binderId"])

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=10)
        shutil.rmtree(self.data, ignore_errors=True)
