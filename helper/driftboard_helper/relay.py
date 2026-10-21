"""Takes an agent's reports from its outbox to its card, with the card's token."""

import logging

from .board import BoardError
from .outbox import OutboxReader

logger = logging.getLogger(__name__)

# report kind -> (method, path after /api/agent/cards/<id>, the field the board reads)
AGENT_CALLS = {"progress": ("PATCH", "", "progress"), "result": ("PATCH", "", "result"), "say": ("POST", "/chat", "text"),
               "note": ("POST", "/notes", "content"), "ask": ("POST", "/ask", "question"),
               "move": ("POST", "/move", "column")}
CLOSED = 409   # the user moved the card to Done or Won't do


class Relay:
    def __init__(self, board, cardId, cardToken, outboxPath, offset=0):
        self.board = board
        self.cardId = cardId
        self.cardToken = cardToken
        self.reader = OutboxReader(outboxPath, offset)
        self.closed = False

    @property
    def offset(self):
        return self.reader.offset

    def pump(self):
        """Forward what is new. A report the board refuses is logged and skipped; when the board
        cannot be reached the rest waits for the next pump; a closed card stops the relay."""
        sent = 0
        for entry, offset in self.reader.read():
            method, suffix, field = AGENT_CALLS[entry["kind"]]
            value = entry["column"] if entry["kind"] == "move" else entry["text"]
            try:
                self.board.request(method, "/api/agent/cards/%s%s" % (self.cardId, suffix), {field: value},
                                   cardToken=self.cardToken)
                sent += 1
            except BoardError as error:
                if error.status == CLOSED:
                    self.closed = True
                    self.reader.offset = offset
                    return sent
                if error.status is None or error.status >= 500:
                    return sent   # not reached: this one and the rest go next time
                logger.warning("card %s: the board refused a report (%s): %s", self.cardId, entry["kind"], error)
            self.reader.offset = offset
        return sent
