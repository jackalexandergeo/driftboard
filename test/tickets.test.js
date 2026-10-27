// Reading open tickets from the trackers (tickets.js), with the trackers' tools played by a fake,
// and ↻ Tickets on a real board on a free port. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTickets, isLate, parseTicketConfig, runTool, SKIP_STATUSES } from '../tickets.js';
import { call, newDataFolder, startBoard, stopBoard } from './helpers.js';

const gitlab = parseTicketConfig(JSON.stringify({ sources: [{ kind: 'gitlab', host: 'gitlab.example.com' }] })).sources[0];
const github = parseTicketConfig(JSON.stringify({ sources: [{ kind: 'github' }] })).sources[0];

function gitlabIssue(number, title, { status, labels = [], form = 'issues' } = {}) {
  return {
    webUrl: `https://gitlab.example.com/acme/web/-/${form}/${number}`,
    title,
    reference: `acme/web#${number}`,
    labels: { nodes: labels.map((label) => ({ title: label })) },
    ...(status === undefined ? {} : { status }),
  };
}

function mergeRequest(iid, title, { draft = true, project = 'acme/web' } = {}) {
  return { iid: String(iid), title, draft, webUrl: `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    reference: `${project}!${iid}`, project: { fullPath: project } };
}

function relatedIssue(project, iid, title, { state = 'opened', form = 'issues' } = {}) {
  return { iid, title, state, web_url: `https://gitlab.example.com/${project}/-/${form}/${iid}` };
}

// glab, answering GraphQL (who the user is, pages of their issues, their merge requests) and the
// REST list of the issues each merge request works on, from related: {"<project>!<iid>": [issue]}.
function fakeGlab(pages, { statusField = true, mergeRequests = [], related = {} } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const rest = /^projects\/(.+)\/merge_requests\/(\d+)\/related_issues$/.exec(args[3]);
    if (rest) return JSON.stringify(related[`${decodeURIComponent(rest[1])}!${rest[2]}`] ?? []);
    const query = args[args.indexOf('-f') + 1];
    if (query.includes('authoredMergeRequests')) {
      return JSON.stringify({ data: { currentUser: { authoredMergeRequests: { pageInfo: { hasNextPage: false }, nodes: mergeRequests } } } });
    }
    if (query.includes('currentUser')) return JSON.stringify({ data: { currentUser: { username: 'pat' } } });
    if (!statusField && query.includes('status {')) throw new Error("glab: Field 'status' doesn't exist on type 'Issue'");
    const after = args.find((arg) => arg.startsWith('after='))?.slice('after='.length);
    const index = after ? Number(after) : 0;
    return JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
      nodes: pages[index],
    } } });
  };
  return { run, calls };
}

test('the late stages are the ones past the user: review, testing, release, done', () => {
  const late = ['Awaits Review', 'In review', 'Code-Review', 'Ready for QA', 'Testing', 'Verification', 'Done', 'Deployed', "Won’t do"];
  const active = ['Backlog', 'To do', 'Todo', 'In progress', 'Blocked', 'Doing', ''];
  for (const status of late) assert.equal(isLate({ status }), true, status);
  for (const status of active) assert.equal(isLate({ status }), false, status);
  assert.equal(isLate({ status: 'Shipped', category: 'done' }), true, 'a done category is late whatever its name');
  assert.equal(isLate({ status: 'In progress' }, ['progress']), true, 'skipStatuses replaces the words');
});

test('GitLab: the issue status first, its status label only where there is none', async () => {
  const { run, calls } = fakeGlab([[
    gitlabIssue(1, 'Fix login', { status: { name: 'Awaits Review', category: 'in_progress' }, labels: ['Status::In Progress'] }),
    gitlabIssue(2, 'Add export', { status: null, labels: ['Status::To Do', 'UI'] }),
    gitlabIssue(3, 'Tidy styles', { status: { name: 'To do', category: 'to_do' } }),
  ]]);
  const tickets = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.reference, ticket.status, isLate(ticket)]), [
    ['acme/web#1', 'Awaits Review', true],
    ['acme/web#2', 'To Do', false],
    ['acme/web#3', 'To do', false],
  ]);
  assert.equal(tickets[0].id, 'gitlab.example.com/acme/web#1');
  assert.ok(calls.every(([command, ...args]) => command === 'glab' && args.slice(0, 3).join(' ') === 'api --hostname gitlab.example.com'),
    'every call names the host: GITLAB_HOST in the environment must not pick another');
});

test('GitLab: every page is read, and an issue is known by both its addresses', async () => {
  const { run } = fakeGlab([[gitlabIssue(1, 'One')], [gitlabIssue(2, 'Two', { form: 'work_items' })]]);
  const tickets = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => ticket.title), ['One', 'Two']);
  assert.deepEqual(tickets[1].aliases, ['https://gitlab.example.com/acme/web/-/issues/2']);
  assert.deepEqual(tickets[0].aliases, ['https://gitlab.example.com/acme/web/-/work_items/1']);
});

test("GitLab: a draft MR brings in the open issues it works on, the user's or not, and they are not late", async () => {
  const { run } = fakeGlab([[gitlabIssue(1, 'Fix login', { status: { name: 'Awaits Review', category: 'in_progress' } })]], {
    mergeRequests: [mergeRequest(3, 'Draft: Fix login for real')],
    related: { 'acme/web!3': [relatedIssue('acme/web', 1, 'Fix login'), relatedIssue('other/app', 9, 'Login API', { form: 'work_items' }),
      relatedIssue('acme/web', 2, 'Old login bug', { state: 'closed' })] },
  });
  const tickets = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.reference, ticket.kind, isLate(ticket), ticket.mergeRequests.map((link) => link.reference)]), [
    ['acme/web#1', 'issue', false, ['acme/web!3']],
    ['other/app#9', 'issue', false, ['acme/web!3']],
  ], 'awaiting review by its status, but a draft says the work goes on; a closed issue is done');
  assert.deepEqual([tickets[1].url, tickets[1].aliases], ['https://gitlab.example.com/other/app/-/work_items/9', ['https://gitlab.example.com/other/app/-/issues/9']]);
});

test("GitLab: a ready MR is listed on its issue's ticket but brings in no work, and a draft with no open issue is work of its own", async () => {
  const { run } = fakeGlab([[gitlabIssue(8, 'Search is slow', { status: TO_DO })]], {
    mergeRequests: [mergeRequest(4, 'Draft: Tidy the toolbar'), mergeRequest(5, 'Speed up search', { draft: false }),
      mergeRequest(6, 'Bump a dependency', { draft: false })],
    related: { 'acme/web!5': [relatedIssue('acme/web', 8, 'Search is slow'), relatedIssue('acme/web', 7, 'Search ranks badly')] },
  });
  const tickets = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.id, ticket.kind, ticket.title, ticket.status, isLate(ticket),
    ticket.mergeRequests.map((link) => `${link.reference} · ${link.stage}`)]), [
    ['gitlab.example.com/acme/web#8', 'issue', 'Search is slow', 'To do', false, ['acme/web!5 · ready']],
    ['gitlab.example.com/acme/web!4', 'mergeRequest', 'Tidy the toolbar', 'Draft MR, no ticket yet', false, []],
  ], 'acme/web#7 is not the user\'s and only in review; a ready MR on no issue is review, not work');
});

test('GitLab without issue statuses: the labels say it', async () => {
  const { run } = fakeGlab([[gitlabIssue(4, 'Old instance', { labels: ['status::in review'] })]], { statusField: false });
  const [ticket] = await fetchTickets(gitlab, run);
  assert.equal(ticket.status, 'in review');
  assert.equal(isLate(ticket), true);
});

test('GitLab: a tool that is not signed in says so', async () => {
  const run = async () => JSON.stringify({ data: { currentUser: null } });
  await assert.rejects(fetchTickets(gitlab, run), /not signed in to gitlab\.example\.com/);
});

test('a tool that answers too much says so, not that it was slow', async () => {
  await assert.rejects(runTool(process.execPath, ['-e', "process.stdout.write('x'.repeat(34 * 1024 * 1024))"]),
    /answered more than 32 MB/);
});

test('a tracker that takes too long over its pages is given up, saying so', async () => {
  const { run } = fakeGlab([[gitlabIssue(1, 'One')], [gitlabIssue(2, 'Two')]]);
  await assert.rejects(fetchTickets(gitlab, run, { readTime: 0 }), /reading gitlab\.example\.com took longer than 0 s/);
});

test('GitHub: assigned issues, without the pull requests the same list carries', async () => {
  const issue = (number, title, labels, extra = {}) => ({
    number, title, html_url: `https://github.com/acme/app/issues/${number}`,
    repository: { full_name: 'acme/app' }, labels: labels.map((name) => ({ name })), ...extra,
  });
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    return JSON.stringify([
      issue(7, 'Crash on start', ['bug', 'status: in progress']),
      issue(8, 'Bump deps', [], { pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/8' } }),
      issue(9, 'Docs pass', ['Status: Review']),
    ]);
  };
  const tickets = await fetchTickets(github, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.id, ticket.status, isLate(ticket)]), [
    ['github.com/acme/app#7', 'in progress', false],
    ['github.com/acme/app#9', 'Review', true],
  ]);
});

test('GitHub: every page of 100 is read, and the last short one ends it', async () => {
  const asked = [];
  const run = async (command, args) => {
    const page = Number(/[?&]page=(\d+)/.exec(args[3])[1]);
    asked.push(page);
    const count = page === 1 ? 100 : 1;
    return JSON.stringify(Array.from({ length: count }, (_, index) => ({
      number: page * 1000 + index, title: `Issue ${page}.${index}`, html_url: `https://github.com/acme/app/issues/${page * 1000 + index}`,
      repository: { full_name: 'acme/app' }, labels: [],
    })));
  };
  const tickets = await fetchTickets(github, run);
  assert.deepEqual([asked, tickets.length], [[1, 2], 101]);
});

test('tickets.json is checked, and each problem says what to write', () => {
  const config = parseTicketConfig(JSON.stringify({
    sources: [{ kind: 'gitlab' }, { kind: 'gitlab', host: 'git.example.org' }, { kind: 'jira' }, { kind: 'github', host: 'not a host' }],
    skipStatuses: 'review',
  }));
  assert.deepEqual(config.sources.map((source) => [source.name, source.host, source.command]), [['gitlab', 'gitlab.com', 'glab']]);
  assert.equal(config.problems.length, 4);
  assert.match(config.problems[0], /another source is named "gitlab"/);
  assert.match(config.problems[1], /"kind" must be one of gitlab, github/);
  assert.match(config.problems[2], /"host" must be a host name/);
  assert.match(config.problems[3], /"skipStatuses" must be a list/);
  assert.equal(config.skipStatuses, SKIP_STATUSES);
  assert.match(parseTicketConfig('{nope').problems[0], /not JSON/);
  assert.match(parseTicketConfig('{"sources": [{"kind": "constructor"}]}').problems[0], /"kind" must be one of/,
    'only the kinds there are, not what every object inherits');
  assert.match(parseTicketConfig('{}').problems[0], /needs "sources"/);
});

// ---- ↻ Tickets on a real board, with glab played by test/fake-glab.js ----
const FAKE_GLAB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-glab.js');
const TO_DO = { name: 'To do', category: 'to_do' };

async function ticketBoard(issues, { signIn = false, config, delay = 0 } = {}) {
  const data = newDataFolder();
  const issuesFile = path.join(data, 'fake-issues.json');
  fs.writeFileSync(issuesFile, JSON.stringify(issues));
  const sources = [{ kind: 'gitlab', host: 'gitlab.example.com', command: FAKE_GLAB }];
  fs.writeFileSync(path.join(data, 'tickets.json'), JSON.stringify(config ?? { sources }));
  const board = await startBoard(signIn, { data, env: { FAKE_GLAB_ISSUES: issuesFile, FAKE_GLAB_DELAY: String(delay) } });
  return { ...board, issuesFile };
}

async function refresh(board, token) {
  const { activeWorkspaceId } = (await call(board, 'GET', '/api/state', undefined, board.token)).body;
  return call(board, 'POST', `/api/workspaces/${activeWorkspaceId}/refresh-tickets`, undefined, token);
}

test('a board without tickets.json offers no ↻ Tickets, and a refresh says where to name the trackers', async () => {
  const board = await startBoard(false);
  try {
    assert.equal((await call(board, 'GET', '/api/state')).body.tickets, false);
    const { status, body } = await refresh(board);
    assert.equal(status, 400);
    assert.match(body.error, /no trackers to read: name them in .*tickets\.json/);
  } finally {
    await stopBoard(board);
  }
});

test('the tickets still the user\'s become cards where new items land, the late ones do not, and no agent starts', async () => {
  const board = await ticketBoard([
    gitlabIssue(1, 'Fix login', { status: { name: 'In progress', category: 'in_progress' } }),
    gitlabIssue(2, 'Add export', { status: { name: 'Awaits Review', category: 'in_progress' } }),
    gitlabIssue(3, 'Tidy styles', { status: null, labels: ['Status::To Do'] }),
  ]);
  try {
    const state = (await call(board, 'GET', '/api/state')).body;
    assert.equal(state.tickets, true);
    const id = state.activeWorkspaceId;
    const marked = await call(board, 'PATCH', `/api/workspaces/${id}`, { agents: { tool: 'claude' }, autoStart: true });
    assert.deepEqual([marked.body.agents, marked.body.autoStart], [{ tool: 'claude' }, true]);
    const { status, body } = await refresh(board);
    assert.equal(status, 200);
    assert.deepEqual(body.added.map((added) => added.title), ['Fix login', 'Tidy styles']);
    assert.deepEqual([body.late, body.onBoard, body.removed, body.problems], [1, 0, 0, []]);
    const ws = (await call(board, 'GET', `/api/workspaces/${id}`)).body;
    const made = ws.cards.filter((card) => card.source?.name === 'gitlab');
    assert.deepEqual(made.map((card) => [card.binderId, card.pressed]), [[ws.binders[0].id, undefined], [ws.binders[0].id, undefined]],
      'in the first column, with nothing pressed: Autostart is for new items, not for work the user has already');
    assert.equal(made[0].description, '**acme/web#1** · In progress');
    assert.deepEqual(made[0].attachments.map((attachment) => [attachment.type, attachment.url, attachment.title]),
      [['url', 'https://gitlab.example.com/acme/web/-/issues/1', 'acme/web#1']]);
  } finally {
    await stopBoard(board);
  }
});

test('a second refresh adds only what is new, and a card the user deleted stays gone', async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: TO_DO }), gitlabIssue(2, 'Two', { status: TO_DO })]);
  try {
    const first = (await refresh(board)).body;
    assert.deepEqual(first.added.map((added) => added.title), ['One', 'Two']);
    await call(board, 'DELETE', `/api/cards/${first.added[1].cardId}`);
    fs.writeFileSync(board.issuesFile, JSON.stringify([
      gitlabIssue(1, 'One', { status: TO_DO }), gitlabIssue(2, 'Two', { status: TO_DO }), gitlabIssue(3, 'Three', { status: TO_DO }),
    ]));
    const second = (await refresh(board)).body;
    assert.deepEqual(second.added.map((added) => added.title), ['Three']);
    assert.deepEqual([second.onBoard, second.removed], [1, 1]);
  } finally {
    await stopBoard(board);
  }
});

test('a card that already links the ticket is its card, by either of its addresses', async () => {
  const board = await ticketBoard([gitlabIssue(5, 'Export breaks', { status: TO_DO })]);
  try {
    await call(board, 'POST', '/api/items', {
      source: 'chat', title: 'Someone asked about the export', link: { url: 'https://gitlab.example.com/acme/web/-/work_items/5/' },
    });
    const { body } = await refresh(board);
    assert.deepEqual([body.added, body.onBoard], [[], 1]);
  } finally {
    await stopBoard(board);
  }
});

test('a tracker that fails is named, and the others still come in', async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: TO_DO })], { config: { sources: [
    { kind: 'gitlab', host: 'gitlab.example.com', command: FAKE_GLAB },
    { kind: 'github', command: 'no-such-tool-for-driftboard' },
  ] } });
  try {
    const { body } = await refresh(board);
    assert.deepEqual(body.added.map((added) => added.title), ['One']);
    assert.equal(body.problems.length, 1);
    assert.match(body.problems[0], /^github: no-such-tool-for-driftboard is not installed/);
  } finally {
    await stopBoard(board);
  }
});

test('a tickets.json with a mistake still offers ↻ Tickets, and a refresh lists what to fix', async () => {
  const board = await ticketBoard([], { config: { sources: [{ kind: 'jira' }] } });
  try {
    assert.equal((await call(board, 'GET', '/api/state')).body.tickets, true);
    const { status, body } = await refresh(board);
    assert.equal(status, 400);
    assert.match(body.problems[0], /"kind" must be one of gitlab, github/);
  } finally {
    await stopBoard(board);
  }
});

test('with sign-in on, a refresh needs the board token: the items key will not do', async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: TO_DO })], { signIn: true });
  try {
    const itemsKey = fs.readFileSync(path.join(board.data, 'items-key'), 'utf8').trim();
    assert.equal((await refresh(board, itemsKey)).status, 401);
    assert.equal((await refresh(board)).status, 401);
    const { status, body } = await refresh(board, board.token);
    assert.equal(status, 200);
    assert.equal(body.added.length, 1);
  } finally {
    await stopBoard(board);
  }
});

test('a tracker answer of the wrong shape leaves the board up, and the rest of its tickets come in', async () => {
  const board = await ticketBoard([
    { ...gitlabIssue(1, 'Fine', { status: TO_DO }) },
    { ...gitlabIssue(2, 'x', { status: { name: 7, category: 'TO_DO' } }), title: null },
    { ...gitlabIssue(3, 'No labels', { status: TO_DO }), labels: null },
  ]);
  try {
    const { status, body } = await refresh(board);
    assert.equal(status, 200);
    assert.deepEqual(body.added.map((added) => added.title), ['Fine', 'acme/web#2', 'No labels'],
      'a ticket without a title is named by its reference');
    assert.equal((await call(board, 'GET', '/api/state')).status, 200, 'the board still answers');
  } finally {
    await stopBoard(board);
  }
});

test('a tickets.json the board cannot read leaves the board up, and a refresh says why', async () => {
  const data = newDataFolder();
  fs.mkdirSync(path.join(data, 'tickets.json'));
  const board = await startBoard(false, { data });
  try {
    const state = await call(board, 'GET', '/api/state');
    assert.deepEqual([state.status, state.body.tickets], [200, true]);
    const { status, body } = await refresh(board);
    assert.equal(status, 400);
    assert.match(body.problems[0], /cannot read .*tickets\.json/);
  } finally {
    await stopBoard(board);
  }
});

test('deleting a card that only linked a ticket lets the next refresh bring the ticket in', async () => {
  const board = await ticketBoard([gitlabIssue(5, 'Export breaks', { status: TO_DO })]);
  try {
    const chat = (await call(board, 'POST', '/api/items', {
      source: 'chat', title: 'Someone asked about the export', link: { url: 'https://gitlab.example.com/acme/web/-/issues/5' },
    })).body;
    assert.equal((await refresh(board)).body.onBoard, 1);
    await call(board, 'DELETE', `/api/cards/${chat.cardId}`);
    const { body } = await refresh(board);
    assert.deepEqual([body.added.map((added) => added.title), body.removed], [['Export breaks'], 0]);
  } finally {
    await stopBoard(board);
  }
});

test("an item that takes a ticket's source and id is the item's card, and the ticket still gets its own", async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: TO_DO })]);
  try {
    await call(board, 'POST', '/api/items', { source: 'gitlab', externalId: 'gitlab.example.com/acme/web#1', title: 'A ping' });
    const { body } = await refresh(board);
    assert.deepEqual([body.added.map((added) => added.title), body.onBoard], [['One'], 0]);
  } finally {
    await stopBoard(board);
  }
});

test("a ticket's reference and status are text on its card, not markdown a label could make a link of", async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: null, labels: ['Status::[Click me](https://evil.example) <b>now</b>'] })]);
  try {
    const { body } = await refresh(board);
    const card = (await call(board, 'GET', `/api/cards/${body.added[0].cardId}`)).body.card;
    assert.equal(card.description, '**acme/web#1** · \\[Click me\\]\\(https://evil.example\\) \\<b\\>now\\</b\\>');
  } finally {
    await stopBoard(board);
  }
});

test('one refresh at a time: a second press while the first reads is told so', async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: TO_DO })], { delay: 600 });
  try {
    const [first, second] = await Promise.all([refresh(board), new Promise((resolve) => setTimeout(resolve, 150)).then(() => refresh(board))]);
    assert.deepEqual([first.status, first.body.added.length], [200, 1]);
    assert.deepEqual([second.status, second.body.error], [409, 'the tickets are being read already']);
    assert.equal((await refresh(board)).status, 200, 'and the next press after it is read');
  } finally {
    await stopBoard(board);
  }
});

test('a board deleted while its tickets were read gets none, and no other board does', async () => {
  const board = await ticketBoard([gitlabIssue(1, 'One', { status: TO_DO })], { delay: 600 });
  try {
    const doomed = (await call(board, 'POST', '/api/workspaces', { name: 'Doomed' })).body;
    const reading = call(board, 'POST', `/api/workspaces/${doomed.id}/refresh-tickets`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await call(board, 'DELETE', `/api/workspaces/${doomed.id}`)).status, 200);
    assert.equal((await reading).status, 404);
    const { workspaces } = (await call(board, 'GET', '/api/state')).body;
    for (const { id } of workspaces) {
      const ws = (await call(board, 'GET', `/api/workspaces/${id}`)).body;
      assert.equal(ws.cards.filter((card) => card.source?.name === 'gitlab').length, 0);
    }
  } finally {
    await stopBoard(board);
  }
});

test("a card whose note or description gives the ticket's address is its card; a bare reference is not", async () => {
  const board = await ticketBoard([
    gitlabIssue(5, 'Export breaks', { status: TO_DO }), gitlabIssue(6, 'Import breaks', { status: TO_DO }), gitlabIssue(7, 'Sync breaks', { status: TO_DO }),
  ]);
  try {
    const agentCard = (await call(board, 'POST', '/api/items', { source: 'chat', title: 'Exports fail for some users' })).body;
    await call(board, 'POST', `/api/cards/${agentCard.cardId}/attachments`,
      { type: 'text', content: 'Created acme/web#5 for this (https://gitlab.example.com/acme/web/-/work_items/5)' });
    await call(board, 'POST', '/api/items', { source: 'chat', title: 'Import question', body: 'Tracked in https://gitlab.example.com/acme/web/-/issues/6.' });
    const roundUp = (await call(board, 'POST', '/api/items', { source: 'chat', title: 'Round-up' })).body;
    await call(board, 'POST', `/api/cards/${roundUp.cardId}/attachments`, { type: 'text', content: 'Other cards: acme/web#7 is in review' });
    const { body } = await refresh(board);
    assert.deepEqual([body.added.map((added) => added.title), body.onBoard], [['Sync breaks'], 2]);
  } finally {
    await stopBoard(board);
  }
});
