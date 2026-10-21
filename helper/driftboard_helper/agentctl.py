"""driftboard-agent: what an agent runs to keep its card current.

    driftboard-agent progress "reading 12 invoices"     one line on the card's face
    driftboard-agent say "Found 2 mismatches so far."   a message in the card's chat with the user
    driftboard-agent note "invoice 7 is in EUR"         a note on the card
    driftboard-agent ask "The 2025 or the 2026 ledger?" the card goes to Needs you; then stop and wait
    driftboard-agent result --file answer.md            the result (markdown; text, --file or - for stdin)
    driftboard-agent move Review                        Working, Needs you or Review

The helper that started the agent sets DRIFTBOARD_OUTBOX; it takes the report to the board.
"""

import argparse
import os
import sys

from .outbox import AGENT_COLUMNS, TEXT_LIMITS, append


def main(arguments=None):
    parser = argparse.ArgumentParser(prog="driftboard-agent", description="Keep your card on the board current.")
    commands = parser.add_subparsers(dest="kind", required=True)
    for kind, what in (("progress", "one line on the card's face"), ("say", "a message in the card's chat with the user"),
                       ("note", "a note on the card"),
                       ("ask", "a question for the user: the card goes to Needs you; then stop and wait"),
                       ("result", "the result, in markdown")):
        command = commands.add_parser(kind, help="%s (at most %d characters)" % (what, TEXT_LIMITS[kind]))
        command.add_argument("text", nargs="?", help="the text, or - to read it from stdin")
        if kind == "result":
            command.add_argument("--file", help="read the result from this file")
    move = commands.add_parser("move", help="move the card to %s" % ", ".join(AGENT_COLUMNS))
    move.add_argument("column", choices=AGENT_COLUMNS)
    options = parser.parse_args(arguments)
    outbox = os.environ.get("DRIFTBOARD_OUTBOX")
    if not outbox:
        print("driftboard-agent: DRIFTBOARD_OUTBOX is not set: only an agent the helper started can report",
              file=sys.stderr)
        return 2
    if options.kind == "move":
        entry = {"kind": "move", "column": options.column}
    else:
        if getattr(options, "file", None):
            with open(options.file) as source:
                text = source.read()
        elif options.text == "-" or options.text is None:
            text = sys.stdin.read()
        else:
            text = options.text
        entry = {"kind": options.kind, "text": text.strip()}
    try:
        append(outbox, entry)
    except ValueError as error:
        print("driftboard-agent: %s" % error, file=sys.stderr)
        return 1
    print("reported (%s)" % options.kind)
    return 0


if __name__ == "__main__":
    sys.exit(main())
