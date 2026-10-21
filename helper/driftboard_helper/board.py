"""driftboard's REST API. The board's token goes only to a server that first proves it holds it
(another user can bind the board's port while the board is down); a card's token goes to the
same proven server, on the agent calls only."""

import hashlib
import hmac
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request


class BoardError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class BoardClient:
    def __init__(self, url, tokenFile, timeout=10):
        self.url = url.rstrip("/")
        self.tokenFile = os.path.expanduser(tokenFile)
        self.timeout = timeout
        # Straight to localhost, whatever proxy the environment names.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def token(self):
        try:
            with open(self.tokenFile) as tokenFile:
                return tokenFile.read().strip()
        except OSError as error:
            raise BoardError("cannot read the board's token (%s): %s" % (self.tokenFile, error))

    def _proven(self, token):
        """Ask the server to prove it holds the board's token (GET /api/hello) before sending any."""
        nonce = secrets.token_hex(16)
        try:
            with self._opener.open("%s/api/hello?nonce=%s" % (self.url, nonce), timeout=self.timeout) as response:
                proof = json.loads(response.read() or b"null").get("proof")
        except (OSError, ValueError, AttributeError) as error:
            raise BoardError("the board at %s did not answer: %s" % (self.url, error))
        wanted = hmac.new(token.encode(), ("driftboard-hello:" + nonce).encode(), hashlib.sha256).hexdigest()
        if not isinstance(proof, str) or not hmac.compare_digest(proof, wanted):
            raise BoardError("the server at %s could not prove it is the board; no token was sent" % self.url)

    def download(self, filename, limit):
        """An uploaded file's bytes, with the board's token (at most limit bytes)."""
        token = self.token()
        self._proven(token)
        request = urllib.request.Request("%s/uploads/%s" % (self.url, urllib.parse.quote(filename)))
        request.add_header("Authorization", "Bearer %s" % token)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                data = response.read(limit + 1)
        except urllib.error.HTTPError as error:
            raise BoardError("GET /uploads/%s: HTTP %d" % (filename, error.code), error.code)
        except OSError as error:
            raise BoardError("GET /uploads/%s: %s" % (filename, error))
        if len(data) > limit:
            raise BoardError("%s is larger than %d bytes" % (filename, limit))
        return data

    def request(self, method, path, body=None, cardToken=None):
        """A call with the board's token, or, for an agent call, with a card's own token."""
        token = self.token()
        self._proven(token)
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method)
        request.add_header("Authorization", "Bearer %s" % (cardToken or token))
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            try:
                why = json.loads(error.read() or b"null").get("error")
            except (ValueError, AttributeError):
                why = None
            raise BoardError("%s %s: HTTP %d%s" % (method, path, error.code, ": %s" % why if why else ""), error.code)
        except (OSError, ValueError) as error:
            raise BoardError("%s %s: %s" % (method, path, error))
