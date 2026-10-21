// A card's terminal: the page's keys go, over a WebSocket, to the helper, which runs the card's
// agent session in a pseudo-terminal (helper/driftboard_helper/terminal.py). The board only
// relays: it never runs anything itself.
//
// Page <-> board: the page's first message is JSON {token, cols, rows} (token: the board's,
// or null with sign-in off); then binary messages are the terminal's bytes, both ways, and text
// messages are JSON: {resize: [cols, rows]} from the page; {started, command}, {error} or
// {exited} from the board.
// Board <-> helper: frames of one byte of kind (0 data, 1 control: JSON), four of length (big
// endian), then the payload, over the helper's Unix socket.
import net from 'node:net';
import { WebSocketServer } from 'ws';

const DATA = 0;
const CONTROL = 1;
const PATH = /^\/api\/cards\/([A-Za-z0-9-]{1,64})\/terminal(?:\?|$)/;
const FIRST_MESSAGE_MS = 10000;

function frame(kind, payload) {
  const body = kind === CONTROL ? Buffer.from(JSON.stringify(payload)) : Buffer.from(payload);
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function frameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) return;
      const kind = buffer.readUInt8(0);
      const body = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      onFrame(kind, kind === CONTROL ? JSON.parse(body.toString()) : body);
    }
  };
}

// servers: the board's HTTP servers. allowed(req): the request's Host is one the board goes by.
export function attachTerminals(servers, { allowed, cardOf, signIn, tokenMatches, socketPath }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const refuse = (socket, status, text) => {
    socket.write(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${text}`);
    socket.destroy();
  };
  const onUpgrade = (req, socket, head) => {
    const match = PATH.exec(req.url || '');
    if (!match) return refuse(socket, '404 Not Found', 'no such terminal');
    // A WebSocket is not held to the same-origin rule: any page in the user's browser could open
    // one. So only the board's own page, at an address the board goes by, gets a terminal.
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!allowed(req) || (origin !== `http://${host}` && origin !== `https://${host}`)) {
      return refuse(socket, '403 Forbidden', "only the board's own page opens a card's terminal");
    }
    sockets.handleUpgrade(req, socket, head, (page) => relay(page, match[1]));
  };
  servers.forEach((server) => server.on('upgrade', onUpgrade));

  function relay(page, cardId) {
    let helper = null;
    const say = (control) => { if (page.readyState === page.OPEN) page.send(JSON.stringify(control)); };
    const end = (control) => {
      if (control) say(control);
      page.close();
      if (helper) helper.destroy();
    };
    const waiting = setTimeout(() => end({ error: 'no hello from the page' }), FIRST_MESSAGE_MS);
    page.once('message', (message, isBinary) => {
      clearTimeout(waiting);
      let hello;
      try { hello = JSON.parse(isBinary ? '' : message.toString()); } catch { return end({ error: 'the first message is JSON' }); }
      if (signIn && !tokenMatches(hello?.token)) return end({ error: 'this terminal needs the board\'s token' });
      const card = cardOf(cardId);
      if (!card) return end({ error: 'no such card' });
      if (!card.terminalEnabled) return end({ error: "this card's agent has no terminal now" });
      // What the page sends before the helper answers waits for it.
      const queued = [];
      const forward = (data, binary) => {
        if (binary) return helper.write(frame(DATA, data));
        let control;
        try { control = JSON.parse(data.toString()); } catch { return undefined; }
        if (Array.isArray(control?.resize)) helper.write(frame(CONTROL, { resize: control.resize.slice(0, 2) }));
        return undefined;
      };
      page.on('message', (data, binary) => (helper.connecting ? queued.push([data, binary]) : forward(data, binary)));
      helper = net.createConnection(socketPath);
      helper.on('error', () => end({ error: "the helper is not running, or its terminals are off ([terminal] board in its config)" }));
      helper.on('close', () => end());
      helper.on('connect', () => {
        helper.write(frame(CONTROL, { card: cardId, cols: hello.cols, rows: hello.rows }));
        queued.splice(0).forEach(([data, binary]) => forward(data, binary));
        helper.on('data', frameReader((kind, payload) => {
          if (kind === DATA) { if (page.readyState === page.OPEN) page.send(payload, { binary: true }); }
          else say(payload);
        }));
      });
    });
    page.on('close', () => { clearTimeout(waiting); if (helper) helper.destroy(); });
    page.on('error', () => { if (helper) helper.destroy(); });
  }
  return sockets;
}
