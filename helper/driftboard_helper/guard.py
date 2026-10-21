"""Stand-ins first on an agent's PATH for glab, gh, git, ssh, scp and sftp. Each refuses what an
agent may not do and runs the real command otherwise. They hold whatever the command's
spelling (an alias, `bash -c`, a script); a tool that runs /usr/bin/git by its full path gets
past them, so they are a floor, not a wall.

    glab, gh   only commands known to read (an alias or a new subcommand is refused, not let through)
    git        never pushes (no push, send-pack, pushing alias, new remote, -c alias.* / url.*)
    ssh        only as git's own transport, fetching from the hosts the user named (DRIFTBOARD_GIT_HOSTS)
    scp, sftp  never

A command the user opened in [agent.access] gets no stand-in.

    python3 -P -m driftboard_helper.guard <command> [arguments...]
"""

import os
import re
import shlex
import shutil
import subprocess
import sys

COMMANDS = ("glab", "gh", "git", "ssh", "scp", "sftp")
REFUSED = 126   # the exit status of a command that cannot run

FORGE_READS = {"list", "ls", "view", "show", "diff", "status", "checks", "checkout", "co", "trace", "get", "stats",
               "lint", "issues", "approvers", "download", "clone", "contributors", "watch", "search", "find",
               "read-file", "read-dir", "verify"}
FORGE_READ_COMMANDS = {"search", "status", "version", "help"}
FORGE_SECRET_NOUNS = {"variable", "var", "secret", "token", "config", "alias", "extension", "extensions", "ext",
                      "codespace", "cs", "ssh-key", "gpg-key", "deploy-key", "stack", "stacks", "cluster"}
FORGE_FLAGS_WITH_VALUE = ("-R", "--repo", "--hostname", "-H", "--header")
API_READ_FLAGS = {"--paginate", "-i", "--include", "--silent", "--slurp", "--verbose"}
API_READ_FLAGS_WITH_VALUE = {"-H", "--header", "--hostname", "--jq", "-q", "--template", "-t", "--cache", "-p",
                             "--preview", "-R", "--repo", "--output"}
GIT_GLOBAL_WITH_VALUE = ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path")
GIT_CONFIG_REFUSED = ("alias.", "url.", "remote.", "core.sshcommand", "core.hookspath", "credential.")
PUSHING = re.compile(r"\b(push|send-pack)\b")
SSH_WITH_VALUE = ("-o", "-p")
GIT_TRANSPORT_OPTIONS = ("-4", "-6", "-T", "-x")
GIT_FETCHES = {"git-upload-pack", "git-upload-archive"}


def positional(arguments, withValue=()):
    found, index = [], 0
    while index < len(arguments):
        if arguments[index] in withValue:
            index += 2
            continue
        if not arguments[index].startswith("-"):
            found.append(arguments[index])
        index += 1
    return found


def verdict(command, arguments, gitHosts=(), aliasOf=None):
    """None when the command may run, else why not."""
    if command in ("scp", "sftp"):
        return "%s is not for agents: ask the user if the card needs another machine" % command
    if command == "ssh":
        return None if gitFetch(arguments, gitHosts) else "ssh is not for agents, except git fetching from %s" % (
            ", ".join(gitHosts) or "no host (none named)")
    if command in ("glab", "gh"):
        return forgeVerdict(command, arguments)
    if command == "git":
        return gitVerdict(arguments, aliasOf)
    return None


def forgeVerdict(command, arguments):
    words = positional(arguments, FORGE_FLAGS_WITH_VALUE + ("-X", "--method", "-f", "-F", "--field", "--raw-field",
                                                            "--input"))
    if not words:
        return None
    if words[0] == "api":
        return apiVerdict(command, arguments[arguments.index("api") + 1:])
    noun, verb = words[0], words[1] if len(words) > 1 else None
    if noun == "auth":
        tokenFlag = any(argument.split("=")[0] in ("-t", "--show-token") for argument in arguments)
        return None if verb == "status" and not tokenFlag else "%s auth is not for agents" % command
    if noun in FORGE_SECRET_NOUNS:
        return "%s %s is not for agents: it shows secrets or changes the CLI" % (command, noun)
    if noun in FORGE_READ_COMMANDS or verb in FORGE_READS:
        return None
    return "the code host is read-only for agents: refusing %s %s %s" % (command, noun, verb or "")


def apiVerdict(command, arguments):
    refused = "the code host is read-only for agents: %s api may only GET, with no fields" % command
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        name, _, attached = argument.partition("=")
        if argument in ("-X", "--method"):
            if index + 1 >= len(arguments) or arguments[index + 1].upper() != "GET":
                return refused
            index += 2
            continue
        if argument in API_READ_FLAGS_WITH_VALUE:
            if index + 1 < len(arguments) and "method" in arguments[index + 1].lower():
                return refused
            index += 2
            continue
        if name == "--method" or (argument.startswith("-X") and not argument.startswith("--")):
            if (attached if name == "--method" else argument[2:]).upper() != "GET":
                return refused
        elif name in API_READ_FLAGS_WITH_VALUE and name.startswith("--"):
            if "method" in attached.lower():
                return refused
        elif argument.startswith("-") and argument not in API_READ_FLAGS:
            return refused
        elif argument == "graphql":
            return refused
        index += 1
    return None


def gitVerdict(arguments, aliasOf=None):
    index = 0
    while index < len(arguments) and arguments[index].startswith("-"):
        option = arguments[index]
        if option == "--config-env" or option.startswith("--config-env="):
            return "git --config-env is not for agents"
        if option == "-c" and index + 1 < len(arguments) and arguments[index + 1].lower().startswith(GIT_CONFIG_REFUSED):
            return "git -c may not set aliases, remotes, URLs, ssh, hooks or credentials"
        index += 2 if option in GIT_GLOBAL_WITH_VALUE else 1
    if index >= len(arguments):
        return None
    command, rest = arguments[index], arguments[index + 1:]
    if command in ("push", "send-pack"):
        return "nothing is pushed by an agent: commits stay on the local branch"
    if command == "remote" and positional(rest)[:1] and positional(rest)[0] in ("add", "set-url", "rename"):
        return "agents do not add or change remotes"
    expansion = aliasOf(command) if aliasOf else None
    if expansion and PUSHING.search(expansion):
        return "a git alias that pushes is not for agents"
    return None


def gitFetch(arguments, gitHosts):
    """True when ssh is git fetching from one of the named hosts, as git runs it."""
    index = 0
    while index < len(arguments) and arguments[index].startswith("-"):
        option = arguments[index]
        if option in SSH_WITH_VALUE and index + 1 < len(arguments):
            value = arguments[index + 1]
            if (option == "-o" and not value.startswith("SendEnv=GIT_PROTOCOL")) or (option == "-p" and not value.isdigit()):
                return False
            index += 2
        elif option in GIT_TRANSPORT_OPTIONS:
            index += 1
        else:
            return False
    rest = arguments[index:]
    return (len(rest) == 2 and rest[0].rpartition("@")[2] in gitHosts
            and rest[1].split(" ", 1)[0] in GIT_FETCHES)


def realCommand(command, guardDirectory):
    path = os.pathsep.join(part for part in os.environ.get("PATH", "").split(os.pathsep)
                           if os.path.realpath(part) != os.path.realpath(guardDirectory))
    return shutil.which(command, path=path)


def gitAlias(name, guardDirectory):
    real = realCommand("git", guardDirectory)
    if not real:
        return None
    try:
        found = subprocess.run([real, "config", "--get", "alias.%s" % name], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if found.returncode != 0:
        return None
    return found.stdout.strip() or None


def writeGuards(directory, opened=()):
    """The stand-ins in directory (put it first on PATH); none for a command the user opened."""
    os.makedirs(directory, mode=0o700, exist_ok=True)
    package = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for command in COMMANDS:
        path = os.path.join(directory, command)
        if command in opened:
            if os.path.exists(path):
                os.remove(path)
            continue
        with open(path, "w") as script:
            # -P: the agent's working folder must not get to stand in for this module
            script.write("#!/bin/sh\nDRIFTBOARD_GUARD_DIR=%s PYTHONPATH=%s exec %s -P -m driftboard_helper.guard %s \"$@\"\n"
                         % tuple(shlex.quote(part) for part in (os.path.abspath(directory), package, sys.executable,
                                                                command)))
        os.chmod(path, 0o755)
    return directory


def main(arguments):
    command, rest = arguments[0], arguments[1:]
    guardDirectory = os.environ["DRIFTBOARD_GUARD_DIR"]
    gitHosts = [host for host in os.environ.get("DRIFTBOARD_GIT_HOSTS", "").split(",") if host]
    reason = verdict(command, rest, gitHosts, aliasOf=lambda name: gitAlias(name, guardDirectory))
    if reason:
        print("driftboard guard: refused %s: %s. If the card needs it, ask the user (driftboard-agent ask)."
              % (command, reason), file=sys.stderr)
        return REFUSED
    real = realCommand(command, guardDirectory)
    if not real:
        print("driftboard guard: %s is not installed" % command, file=sys.stderr)
        return 127
    os.execv(real, [real] + rest)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
