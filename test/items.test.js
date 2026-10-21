// The items API against a real server on a free port, with its own data folder.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBoard, stopBoard } from './helpers.js';

let open;     // sign-in off
let locked;   // sign-in on

before(async () => {
  [open, locked] = await Promise.all([startBoard(false), startBoard(true)]);
});

after(() => Promise.all([open, locked].map(stopBoard)));

async function send(board, item, token) {
  const response = await fetch(`${board.url}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(item),
  });
  return { status: response.status, body: await response.json() };
}

async function card(board, cardId) {
  const response = await fetch(`${board.url}/api/cards/${cardId}`);
  return (await response.json()).card;
}

async function workspace(board, workspaceId) {
  return (await fetch(`${board.url}/api/workspaces/${workspaceId}`)).json();
}

test('an item becomes a card in the first column of the Inbox, made with the work columns', async () => {
  const { status, body } = await send(open, {
    source: 'ci', externalId: 'build-1', title: 'Nightly build failed', body: 'step `test` exited 1',
    link: { url: 'https://ci.example/build/1', title: 'Build 1' },
  });
  assert.equal(status, 201);
  assert.equal(body.created, true);
  const made = await card(open, body.cardId);
  assert.equal(made.title, 'Nightly build failed');
  assert.equal(made.description, 'step `test` exited 1');
  assert.deepEqual(made.attachments.map((attachment) => [attachment.type, attachment.url]), [['url', 'https://ci.example/build/1']]);
  const inbox = await workspace(open, body.workspaceId);
  assert.equal(inbox.name, 'Inbox');
  assert.deepEqual(inbox.binders.map((binder) => binder.title), ['New', 'Working', 'Needs you', 'Review', 'Done', "Won't do"]);
  assert.equal(inbox.binders.find((binder) => binder.id === made.binderId).title, 'New');
});

test('the same item twice is one card', async () => {
  const first = await send(open, { source: 'mail', externalId: 'm-7', title: 'Invoice 7 is wrong' });
  const again = await send(open, { source: 'mail', externalId: 'm-7', title: 'Invoice 7 is wrong' });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.cardId, again.body.duplicate], [first.body.cardId, true]);
});

test('an item whose card the user deleted is not put back when it comes again', async () => {
  const first = await send(open, { source: 'mail', externalId: 'm-9', title: 'Newsletter' });
  await fetch(`${open.url}/api/cards/${first.body.cardId}`, { method: 'DELETE' });
  const again = await send(open, { source: 'mail', externalId: 'm-9', title: 'Newsletter' });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.duplicate, again.body.cardId], [true, null]);
  const inbox = await workspace(open, first.body.workspaceId);
  assert.ok(!inbox.cards.some((each) => each.title === 'Newsletter'));
});

test('a later item in the same thread joins its card as a note', async () => {
  const first = await send(open, { source: 'chat', thread: 't-1', externalId: 'p-1', title: 'Can you look at the export?' });
  const later = await send(open, { source: 'chat', thread: 't-1', externalId: 'p-2', title: 'Still broken', body: 'since 9am' });
  assert.deepEqual([later.body.cardId, later.body.joined], [first.body.cardId, true]);
  const joined = await card(open, first.body.cardId);
  assert.deepEqual(joined.attachments.map((attachment) => attachment.content), ['**chat**: Still broken\n\nsince 9am']);
  const elsewhere = await send(open, { source: 'other', thread: 't-1', title: 'Another source, same thread name' });
  assert.equal(elsewhere.body.created, true);   // threads belong to their source
});

test('a later item on a closed thread brings its card back where new items land', async () => {
  const first = await send(locked, { source: 'mail', thread: 'refund-7', title: 'Refund request' }, locked.token);
  const inbox = await (await fetch(`${locked.url}/api/workspaces/${first.body.workspaceId}`, {
    headers: { Authorization: `Bearer ${locked.token}` } })).json();
  const column = (title) => inbox.binders.find((binder) => binder.title === title).id;
  await fetch(`${locked.url}/api/cards/${first.body.cardId}/move`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${locked.token}` },
    body: JSON.stringify({ binderId: column('Done'), toIndex: 0 }) });
  const later = await send(locked, { source: 'mail', thread: 'refund-7', title: 'Re: refund request', body: 'still waiting' }, locked.token);
  assert.deepEqual([later.body.joined, later.body.reopened], [true, true]);
  const reopened = (await (await fetch(`${locked.url}/api/cards/${first.body.cardId}`, {
    headers: { Authorization: `Bearer ${locked.token}` } })).json()).card;
  assert.equal(reopened.binderId, column('New'));
  assert.match(reopened.attachments.at(-1).content, /^_Reopened: a new item came in on this thread\._/);
});

test("a later item's link is attached to the thread's card, once", async () => {
  const first = await send(open, { source: 'ci', thread: 'nightly', title: 'Nightly failed', link: { url: 'https://ci.example/1' } });
  for (const run of [2, 2]) {
    await send(open, { source: 'ci', thread: 'nightly', title: `Still failing (run ${run})`, link: { url: `https://ci.example/${run}` } });
  }
  const links = (await card(open, first.body.cardId)).attachments.filter((a) => a.type === 'url').map((a) => a.url);
  assert.deepEqual(links, ['https://ci.example/1', 'https://ci.example/2']);
});

test('an item names its board and column, and an unknown column is refused with the ones there are', async () => {
  const placed = await send(open, { source: 'ci', title: 'Flaky test', workspace: 'Builds', column: 'Working' });
  assert.equal(placed.status, 201);
  const builds = await workspace(open, placed.body.workspaceId);
  assert.equal(builds.name, 'Builds');
  assert.equal(builds.binders.find((binder) => binder.id === (builds.cards[0] || {}).binderId).title, 'Working');
  const nowhere = await send(open, { source: 'ci', title: 'x', workspace: 'Builds', column: 'Someday' });
  assert.equal(nowhere.status, 400);
  assert.deepEqual(nowhere.body.columns, ['New', 'Working', 'Needs you', 'Review', 'Done', "Won't do"]);
});

test('an item refused for its column leaves no new board behind, and a board needs a name', async () => {
  const refused = await send(open, { source: 'ci', title: 'x', workspace: 'Never made', column: 'Someday' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.columns, ['New', 'Working', 'Needs you', 'Review', 'Done', "Won't do"]);
  const boards = await (await fetch(`${open.url}/api/state`)).json();
  assert.ok(!boards.workspaces.some((w) => w.name === 'Never made'));
  const blank = await send(open, { source: 'ci', title: 'x', workspace: '   ' });
  assert.equal(blank.status, 400);
  assert.deepEqual(blank.body.problems, ['workspace must name a board (leave it out for Inbox)']);
});

test('what is not an item is refused, saying why', async () => {
  const { status, body } = await send(open, { title: ' ', source: 'Not A Name', link: { url: 'javascript:alert(1)' } });
  assert.equal(status, 400);
  assert.deepEqual(body.problems, ['title is required',
    'source is required: lowercase letters, digits, . _ - (who sent it, e.g. "ci")', 'link.url must be an http or https address']);
});

test('with sign-in on, an item needs the board token', async () => {
  const refused = await send(locked, { source: 'ci', title: 'x' });
  assert.equal(refused.status, 401);
  const taken = await send(locked, { source: 'ci', title: 'x' }, locked.token);
  assert.equal(taken.status, 201);
});
