"""~/.config/driftboard-helper/config.toml, over these defaults:

    [board]
    url = "http://127.0.0.1:4321"
    tokenFile = "~/.local/share/driftboard/token"
    workspaces = ["Inbox"]          # the boards whose cards get agent buttons

    [agent]
    tool = "claude"                 # or "codex"
    directory = "~/work"            # where agents start: a project folder, not the home folder
    model = ""                      # the tool's default when empty
    maxAgents = 3                   # more starts wait their turn
    gitHosts = []                   # hosts git may fetch from over ssh, e.g. ["github.com"]
    rules = []                      # your own hard rules, for every agent
    denyCommands = []               # extra Claude Code deny rules, e.g. ["Bash(chat-cli *send*)"]

    [agent.access]                  # other machines, per command: "deny" (default), "ask" or "allow"
    ssh = "deny"

    [agent.limits]                  # what agents hold back unless you ask: chat, codeHost, push, http,
    chat = "never"                  # credentials; each "never", "ask" (default; credentials never) or "allow"
"""

import copy
import os
import tomllib

from .rules import ACCESS_LEVELS, COMMAND_NAME, DEFAULT_LIMITS, LIMIT_LEVELS

TOOLS = ("claude", "codex")
DEFAULTS = {
    "board": {"url": "http://127.0.0.1:4321", "tokenFile": "~/.local/share/driftboard/token", "workspaces": ["Inbox"]},
    "agent": {"tool": "claude", "directory": "", "model": "", "maxAgents": 3, "gitHosts": [], "rules": [],
              "denyCommands": [], "access": {}, "limits": {}},
    "intervalSeconds": 3,
}


def configPath():
    if os.environ.get("DRIFTBOARD_HELPER_CONFIG"):
        return os.environ["DRIFTBOARD_HELPER_CONFIG"]
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "driftboard-helper", "config.toml")


def stateDirectory():
    """Private: it holds the cards' tokens and what the agents were told."""
    if os.environ.get("DRIFTBOARD_HELPER_STATE"):
        directory = os.environ["DRIFTBOARD_HELPER_STATE"]
    else:
        directory = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "driftboard-helper")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    return directory


def loadConfig(path=None):
    config = copy.deepcopy(DEFAULTS)
    try:
        with open(path or configPath(), "rb") as configFile:
            loaded = tomllib.load(configFile)
    except FileNotFoundError:
        loaded = {}
    for key, value in loaded.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            config[key].update(value)
        else:
            config[key] = value
    return config


def configProblems(config):
    problems = []
    agent, board = config["agent"], config["board"]
    if agent.get("tool") not in TOOLS:
        problems.append("agent.tool must be one of %s" % ", ".join(TOOLS))
    directory = agent.get("directory")
    if not isinstance(directory, str) or not directory.strip():
        problems.append("agent.directory is needed: the project folder agents start in")
    elif os.path.realpath(os.path.expanduser(directory)) == os.path.realpath(os.path.expanduser("~")):
        problems.append("agent.directory must be a project folder, not the home folder")
    elif not os.path.isdir(os.path.expanduser(directory)):
        problems.append("agent.directory %s does not exist" % directory)
    if not isinstance(agent.get("maxAgents"), int) or isinstance(agent.get("maxAgents"), bool) or agent["maxAgents"] < 1:
        problems.append("agent.maxAgents must be a whole number, at least 1")
    for key in ("gitHosts", "rules", "denyCommands"):
        if not isinstance(agent.get(key), list) or not all(isinstance(item, str) for item in agent[key]):
            problems.append("agent.%s must be a list of text" % key)
    access = agent.get("access")
    if not isinstance(access, dict):
        problems.append("agent.access must be a table")
    else:
        for command, level in access.items():
            if not COMMAND_NAME.fullmatch(command) or level not in ACCESS_LEVELS:
                problems.append("agent.access: %s = %r: a command name, each %s" % (command, level, ", ".join(ACCESS_LEVELS)))
            elif level == "ask" and agent.get("tool") != "claude":
                problems.append('agent.access: %s = "ask" needs Claude Code: Codex cannot stop and ask you' % command)
    limits = agent.get("limits")
    if not isinstance(limits, dict):
        problems.append("agent.limits must be a table")
    else:
        for kind, level in limits.items():
            if kind not in DEFAULT_LIMITS or level not in LIMIT_LEVELS:
                problems.append("agent.limits: %s = %r: kinds are %s; each %s"
                                % (kind, level, ", ".join(DEFAULT_LIMITS), ", ".join(LIMIT_LEVELS)))
    if not isinstance(board.get("workspaces"), list) or not board["workspaces"]:
        problems.append("board.workspaces must name at least one board")
    interval = config.get("intervalSeconds")
    if not isinstance(interval, (int, float)) or isinstance(interval, bool) or interval < 1:
        problems.append("intervalSeconds must be at least 1")
    return problems
