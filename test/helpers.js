// Shared by the tests: a real board on a free port, with its own data folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startBoard(signIn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'driftboard-test-'));
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), DRIFTBOARD_DATA: data, DRIFTBOARD_SIGN_IN: signIn ? 'on' : 'off' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${url}/api/hello?nonce=x`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const token = fs.readFileSync(path.join(data, 'token'), 'utf8').trim();
  return { server, data, url, token };
}

export function stopBoard(board) {
  board.server.kill();
  fs.rmSync(board.data, { recursive: true, force: true });
}

export async function call(board, method, url, body, token) {
  const response = await fetch(`${board.url}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
