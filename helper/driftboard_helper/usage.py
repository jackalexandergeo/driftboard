"""How much of the user's 5-hour Claude limit the board's agents took, for [agent.budget].

The usage endpoint (the one Claude Code's /usage reads, with this user's own sign-in) says how
full the 5-hour window is; Claude Code's transcripts (~/.claude/projects: one file per session,
and one per subagent under the session's folder) say which sessions made the calls. Limits are
not published per token, so calls are made comparable by weight: what the API would charge,
relative to a Sonnet input token. A set of sessions' share of the limit is their weight against
every call on this machine in the window, times the window's utilization. Use on claude.ai or
another machine is not in the transcripts, so the estimate runs high when the user works there too.
"""

import datetime
import glob
import json
import logging
import os
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CREDENTIALS = "~/.claude/.credentials.json"
PROJECTS = "~/.claude/projects"
WINDOW_SECONDS = 5 * 3600
HORIZON_SECONDS = 6 * 3600   # the 5-hour window, and an hour to spare
FETCH_SECONDS = 300          # the endpoint is asked this often (the top bar and pingwatch ask it too)
THROTTLED_SECONDS = 900      # and this long after it answers 429
READ_SECONDS = 60            # the transcripts are read this often
# Per million tokens, relative to Sonnet input = 3 (API list prices' ratios).
MODEL_WEIGHTS = (("opus", 5.0), ("fable", 5.0), ("sonnet", 3.0), ("haiku", 1.0))
OUTPUT, CACHE_WRITE, CACHE_WRITE_HOUR, CACHE_READ = 5.0, 1.25, 2.0, 0.1


def fetchUsage(credentialsPath=CREDENTIALS, timeout=15):
    """The usage windows, as the endpoint gives them. Raises OSError or ValueError."""
    with open(os.path.expanduser(credentialsPath)) as credentials:
        token = (json.load(credentials).get("claudeAiOauth") or {}).get("accessToken")
    if not token:
        raise ValueError("not signed in to Claude")
    request = urllib.request.Request(USAGE_URL, headers={"Authorization": "Bearer %s" % token,
                                                         "Accept": "application/json",
                                                         "User-Agent": "driftboard-helper"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def weightOf(message):
    """One API call's weight, from its model and usage."""
    usage = message.get("usage") or {}
    model = str(message.get("model") or "")
    factor = next((weight for name, weight in MODEL_WEIGHTS if name in model), 3.0)
    hour = (usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
    written = max(0, (usage.get("cache_creation_input_tokens") or 0) - hour)
    tokens = ((usage.get("input_tokens") or 0) + OUTPUT * (usage.get("output_tokens") or 0)
              + CACHE_WRITE * written + CACHE_WRITE_HOUR * hour + CACHE_READ * (usage.get("cache_read_input_tokens") or 0))
    return factor * tokens / 1e6


def epochSeconds(text):
    """An ISO 8601 time (Claude's "...Z", or with an offset) as epoch seconds, or None."""
    try:
        moment = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)).timestamp()


def resetText(resetsAt):
    """When a window resets, as the user reads it: 18:40, or Thu 09:00 on another day."""
    if resetsAt is None:
        return None
    moment = datetime.datetime.fromtimestamp(resetsAt).astimezone()
    return moment.strftime("%a %H:%M") if moment.date() != datetime.date.today() else moment.strftime("%H:%M")


class TranscriptLedger:
    """Each API call in each transcript, by message, read as the files grow."""

    def __init__(self, root=PROJECTS, horizonSeconds=HORIZON_SECONDS, clock=time.time):
        self.root = os.path.expanduser(root)
        self.horizonSeconds = horizonSeconds
        self._clock = clock
        self._files = {}   # path -> {"inode", "offset", "calls": {message id: (epoch seconds, weight)}}

    def refresh(self):
        """Read what the transcripts gained since the last call (the first reads the horizon)."""
        oldest = self._clock() - self.horizonSeconds
        seen = set()
        for path in glob.glob(os.path.join(self.root, "**", "*.jsonl"), recursive=True):
            try:
                status = os.stat(path)
            except OSError:
                continue
            if status.st_mtime < oldest:
                continue
            seen.add(path)
            entry = self._files.get(path)
            if entry is None or entry["inode"] != status.st_ino or status.st_size < entry["offset"]:
                entry = self._files[path] = {"inode": status.st_ino, "offset": 0, "calls": {}}
            if status.st_size > entry["offset"]:
                self._read(path, entry)
            entry["calls"] = {key: call for key, call in entry["calls"].items() if call[0] >= oldest}
        for path in set(self._files) - seen:
            del self._files[path]

    def _read(self, path, entry):
        try:
            with open(path, "rb") as transcript:
                transcript.seek(entry["offset"])
                for line in transcript:   # line by line: a session's transcript runs to hundreds of MB
                    if not line.endswith(b"\n"):
                        break   # still being written: read next time
                    entry["offset"] += len(line)
                    self._count(line, entry["calls"])
        except OSError as error:
            logger.warning("cannot read %s: %s", path, error)

    @staticmethod
    def _count(line, calls):
        if b'"usage"' not in line or b'"assistant"' not in line:
            return
        try:
            record = json.loads(line)
        except ValueError:
            return
        message = record.get("message") or {}
        if record.get("type") != "assistant" or not isinstance(message.get("usage"), dict):
            return
        moment = epochSeconds(record.get("timestamp"))
        key = message.get("id") or record.get("requestId") or record.get("uuid")
        if moment is not None and key:
            calls[key] = (moment, weightOf(message))   # the same call repeats: the last one counts

    def weight(self, since, paths=None):
        """The weight of the calls since `since`, in these files (None: every file)."""
        files = self._files if paths is None else {path: self._files[path] for path in paths if path in self._files}
        return sum(weight for entry in files.values() for moment, weight in entry["calls"].values() if moment >= since)

    def sessionFiles(self, sessionIds):
        """The transcripts of these sessions and of their subagents, by full id or the short id
        `claude agents` shows (the full id's first characters)."""
        prefixes = tuple(str(sessionId) for sessionId in sessionIds if len(str(sessionId or "")) >= 8)
        if not prefixes:
            return []
        return [path for path in self._files
                if os.path.basename(path).startswith(prefixes)
                or os.path.basename(os.path.dirname(os.path.dirname(path))).startswith(prefixes)]


class UsageMeter:
    """The 5-hour window as the endpoint last gave it, and the transcripts read as they grow."""

    def __init__(self, fetch=fetchUsage, ledger=None, clock=time.time, fetchSeconds=FETCH_SECONDS,
                 readSeconds=READ_SECONDS):
        self._fetch = fetch
        self._clock = clock
        self.ledger = ledger or TranscriptLedger(clock=clock)
        self.fetchSeconds, self.readSeconds = fetchSeconds, readSeconds
        self.utilization = None   # percent of the 5-hour limit used, or None while not known
        self.resetsAt = None      # epoch seconds, or None (the window then is the last 5 hours)
        self._fetchAfter = self._readAt = None

    def refresh(self):
        """Ask the endpoint and read the transcripts when each is due; on a failed ask keep the
        last answer rather than guess."""
        now = self._clock()
        if self._fetchAfter is None or now >= self._fetchAfter:
            self._fetchAfter = now + self.fetchSeconds
            try:
                window = (self._fetch() or {}).get("five_hour") or {}
                utilization = window.get("utilization")
                self.utilization = utilization if isinstance(utilization, (int, float)) else None
                self.resetsAt = epochSeconds(window.get("resets_at")) if window.get("resets_at") else None
            except urllib.error.HTTPError as error:
                if error.code == 429:
                    retryAfter = error.headers.get("Retry-After") if error.headers else None
                    self._fetchAfter = now + max(THROTTLED_SECONDS, int(retryAfter) if str(retryAfter).isdigit() else 0)
                logger.warning("could not read Claude usage: %s", error)
            except (OSError, ValueError) as error:
                logger.warning("could not read Claude usage: %s", error)
        if self._readAt is None or now - self._readAt >= self.readSeconds:
            self._readAt = now
            self.ledger.refresh()

    def ofLimit(self, sessionIds):
        """Percent of the 5-hour limit these sessions used in the current window, or None while
        the window's utilization is not known."""
        if self.utilization is None:
            return None
        since = (self.resetsAt or self._clock()) - WINDOW_SECONDS
        total = self.ledger.weight(since)
        if not total:
            return 0.0
        return round(self.ledger.weight(since, self.ledger.sessionFiles(sessionIds)) / total * self.utilization, 1)
