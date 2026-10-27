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

function mergeRequest(iid, title, { draft = true, project = 'acme/web', description = '' } = {}) {
  return { iid: String(iid), title, draft, description, webUrl: `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    reference: `${project}!${iid}`, project: { fullPath: project } };
}

function relatedIssue(project, iid, title, { state = 'opened', form = 'issues' } = {}) {
  return { iid, title, state, web_url: `https://gitlab.example.com/${project}/-/${form}/${iid}` };
}

// glab, answering GraphQL (who the user is, pages of their issues, their merge requests) and the
// REST list of the issues each merge request works on, from related: {"<project>!<iid>": [issue]}.
function fakeGlab(pages, { statusField = true, mergeRequests = [], related = {}, commits = {} } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const rest = /^projects\/(.+)\/merge_requests\/(\d+)\/related_issues/.exec(args[3]);
    const issues = rest && related[`${decodeURIComponent(rest[1])}!${rest[2]}`];
    if (issues === 'fails') throw new Error('glab: 404 Not Found');
    if (rest) return JSON.stringify(issues ?? []);
    const commitsOf = /^projects\/(.+)\/merge_requests\/(\d+)\/commits\?per_page=100&page=(\d+)$/.exec(args[3]);
    if (commitsOf) {
      const all = commits[`${decodeURIComponent(commitsOf[1])}!${commitsOf[2]}`] ?? [];
      return JSON.stringify(all.slice((commitsOf[3] - 1) * 100, commitsOf[3] * 100).map((message) => ({ message })));
    }
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
  const { tickets } = await fetchTickets(gitlab, run);
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
  const { tickets } = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => ticket.title), ['One', 'Two']);
  assert.deepEqual(tickets[1].aliases, ['https://gitlab.example.com/acme/web/-/issues/2']);
  assert.deepEqual(tickets[0].aliases, ['https://gitlab.example.com/acme/web/-/work_items/1']);
});

test("GitLab: a draft MR brings in the open issues it works on, the user's or not, and they are not late", async () => {
  const { run } = fakeGlab([[gitlabIssue(1, 'Fix login', { status: { name: 'Awaits Review', category: 'in_progress' } })]], {
    mergeRequests: [mergeRequest(3, 'Draft: Fix login for real', { description: 'Refs acme/web#1, other/app#9 and acme/web#2' })],
    related: { 'acme/web!3': [relatedIssue('acme/web', 1, 'Fix login'), relatedIssue('other/app', 9, 'Login API', { form: 'work_items' }),
      relatedIssue('acme/web', 2, 'Old login bug', { state: 'closed' })] },
  });
  const { tickets } = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.reference, ticket.kind, isLate(ticket), ticket.mergeRequests.map((link) => link.reference)]), [
    ['acme/web#1', 'issue', false, ['acme/web!3']],
    ['other/app#9', 'issue', false, ['acme/web!3']],
  ], 'awaiting review by its status, but a draft says the work goes on; a closed issue is done');
  assert.deepEqual([tickets[1].url, tickets[1].aliases], ['https://gitlab.example.com/other/app/-/work_items/9', ['https://gitlab.example.com/other/app/-/issues/9']]);
});

test("GitLab: a ready MR is listed on its issue's ticket but brings in no work, and a draft with no open issue is work of its own", async () => {
  const { run } = fakeGlab([[gitlabIssue(8, 'Search is slow', { status: TO_DO })]], {
    mergeRequests: [mergeRequest(4, 'Draft: Tidy the toolbar'), mergeRequest(5, 'Speed up search', { draft: false, description: 'Refs #8, #7' }),
      mergeRequest(6, 'Bump a dependency', { draft: false })],
    related: { 'acme/web!5': [relatedIssue('acme/web', 8, 'Search is slow'), relatedIssue('acme/web', 7, 'Search ranks badly')] },
  });
  const { tickets } = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.id, ticket.kind, ticket.title, ticket.status, isLate(ticket),
    ticket.mergeRequests.map((link) => `${link.reference} · ${link.stage}`)]), [
    ['gitlab.example.com/acme/web#8', 'issue', 'Search is slow', 'To do', false, ['acme/web!5 · ready']],
    ['gitlab.example.com/acme/web!4', 'mergeRequest', 'Tidy the toolbar', 'Draft MR, no ticket yet', false, []],
  ], 'acme/web#7 is not the user\'s and only in review; a ready MR on no issue is review, not work');
});

test("GitLab: an MR's work is the issues its title, description or commits name, not one a comment mentions", async () => {
  const { run } = fakeGlab([[]], {
    mergeRequests: [mergeRequest(3, 'Draft: Fix login', { description: 'Part of #1. See https://gitlab.example.com/other/app/-/issues/9' })],
    related: { 'acme/web!3': [relatedIssue('acme/web', 1, 'Fix login'), relatedIssue('other/app', 9, 'Login API'),
      relatedIssue('other/app', 12, 'Session rework'), relatedIssue('acme/web', 45, 'Conflicting change')] },
    commits: { 'acme/web!3': [...Array(100).fill('chore: tidy'), 'fix(login): keep the session\n\nRefs other/app#12'] },
  });
  const { tickets } = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => ticket.reference), ['acme/web#1', 'other/app#9', 'other/app#12'],
    'other/app#12 is named on the second page of commits; acme/web#45 is only in a reviewer\'s comment ("conflicts with #45")');
});

test("GitLab: a merge request that cannot be looked into is named, and the rest of the read stands", async () => {
  const { run } = fakeGlab([[gitlabIssue(1, 'Fix login', { status: TO_DO })]], {
    mergeRequests: [mergeRequest(3, 'Draft: Login API'), mergeRequest(4, 'Draft: Login form', { description: 'Refs acme/web#1' })],
    related: { 'acme/web!3': 'fails', 'acme/web!4': [relatedIssue('acme/web', 1, 'Fix login')] },
  });
  const { tickets, mergeRequests, problems } = await fetchTickets(gitlab, run);
  assert.deepEqual(tickets.map((ticket) => [ticket.reference, ticket.mergeRequests.map((link) => link.reference)]), [['acme/web#1', ['acme/web!4']]],
    'not a card of its own: it works on something, it is only not known what');
  assert.deepEqual(mergeRequests.map((link) => link.reference), ['acme/web!3', 'acme/web!4'], 'still open, all the same');
  assert.deepEqual(problems, ['acme/web!3: glab: 404 Not Found']);
});

test('GitLab: out of time before the merge requests, the issues read stand and the merge requests are named', async () => {
  const { run } = fakeGlab([[gitlabIssue(1, 'Fix login', { status: TO_DO })]], { mergeRequests: [mergeRequest(3, 'Draft: Login API')] });
  const { tickets, mergeRequests, problems } = await fetchTickets(gitlab, run, { readTime: 0 });
  assert.deepEqual([tickets.map((ticket) => ticket.reference), mergeRequests], [['acme/web#1'], null]);
  assert.deepEqual(problems, ['merge requests not read: reading gitlab.example.com took longer than 0 s']);
});

test('GitLab without issue statuses: the labels say it', async () => {
  const { run } = fakeGlab([[gitlabIssue(4, 'Old instance', { labels: ['status::in review'] })]], { statusField: false });
  const { tickets: [ticket] } = await fetchTickets(gitlab, run);
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
  const { tickets } = await fetchTickets(github, run);
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
  const { tickets } = await fetchTickets(github, run);
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

// ---- An issue's merge requests on its card ----
const linksOf = (card) => card.attachments.filter((attachment) => attachment.type === 'url').map((attachment) => attachment.title);
async function cardOf(board, cardId) {
  return (await call(board, 'GET', `/api/cards/${cardId}`)).body.card;
}

test("an issue's card lists its merge requests by stage, and its first line says how they stand", async () => {
  const board = await ticketBoard({
    issues: [gitlabIssue(1, 'Fix login', { status: TO_DO })],
    mergeRequests: [mergeRequest(3, 'Draft: Fix login in the API', { project: 'acme/api', description: 'Refs acme/web#1' }),
      mergeRequest(4, 'Fix login form', { draft: false, description: 'Closes #1' })],
    related: { 'acme/api!3': [relatedIssue('acme/web', 1, 'Fix login')], 'acme/web!4': [relatedIssue('acme/web', 1, 'Fix login')] },
  });
  try {
    const { body } = await refresh(board);
    const card = await cardOf(board, body.added[0].cardId);
    assert.equal(card.description, '**acme/web#1** · To do · 2 MRs: 1 draft, 1 ready');
    assert.deepEqual(linksOf(card), ['acme/web#1', 'api!3 · draft', 'web!4 · ready']);
  } finally {
    await stopBoard(board);
  }
});

test("a later press brings a card's merge requests up to date, and leaves a first line the user wrote", async () => {
  const work = (mergeRequests) => ({
    issues: [gitlabIssue(1, 'Fix login', { status: TO_DO })],
    mergeRequests: mergeRequests.map((found) => ({ ...found, description: 'Refs acme/web#1' })),
    related: Object.fromEntries(mergeRequests.map((found) => [found.reference, [relatedIssue('acme/web', 1, 'Fix login')]])),
  });
  const board = await ticketBoard(work([mergeRequest(3, 'Draft: Login API'), mergeRequest(4, 'Draft: Login form')]));
  try {
    const cardId = (await refresh(board)).body.added[0].cardId;
    fs.writeFileSync(board.issuesFile, JSON.stringify(work([mergeRequest(3, 'Login API', { draft: false }), mergeRequest(5, 'Draft: Login tests')])));
    const second = (await refresh(board)).body;
    assert.deepEqual([second.added, second.updated, second.onBoard], [[], 1, 1]);
    let card = await cardOf(board, cardId);
    assert.deepEqual(linksOf(card), ['acme/web#1', 'web!3 · ready', 'web!4 · merged or closed', 'web!5 · draft'],
      'one gone from the open ones is marked, not taken off');
    assert.equal(card.description, '**acme/web#1** · To do · 2 MRs: 1 draft, 1 ready');
    await call(board, 'PATCH', `/api/cards/${cardId}`, { description: 'Waiting on the API review first.' });
    fs.writeFileSync(board.issuesFile, JSON.stringify(work([mergeRequest(3, 'Login API', { draft: false }), mergeRequest(5, 'Login tests', { draft: false })])));
    await refresh(board);
    card = await cardOf(board, cardId);
    assert.equal(card.description, 'Waiting on the API review first.');
    assert.deepEqual(linksOf(card).slice(-1), ['web!5 · ready']);
  } finally {
    await stopBoard(board);
  }
});

test("a draft's own card becomes its ticket's card once the ticket is there, not a second card", async () => {
  const draft = mergeRequest(6, 'Draft: Tidy the toolbar');
  const board = await ticketBoard({ issues: [], mergeRequests: [draft], related: {} });
  try {
    const first = (await refresh(board)).body;
    const cardId = first.added[0].cardId;
    assert.equal((await cardOf(board, cardId)).description, '**acme/web!6** · Draft MR, no ticket yet');
    fs.writeFileSync(board.issuesFile, JSON.stringify({ issues: [], mergeRequests: [{ ...draft, description: 'Refs acme/web#10' }],
      related: { 'acme/web!6': [relatedIssue('acme/web', 10, 'Toolbar is cluttered')] } }));
    const second = (await refresh(board)).body;
    assert.deepEqual([second.added, second.updated], [[], 1]);
    const card = await cardOf(board, cardId);
    assert.equal(card.description, '**acme/web#10** · 1 MR: 1 draft');
    assert.deepEqual(linksOf(card), ['web!6 · draft', 'acme/web#10']);
    assert.deepEqual((await refresh(board)).body.added, [], 'and the ticket is remembered as that card');
  } finally {
    await stopBoard(board);
  }
});

test('a card keeps up when its draft goes ready and its issue to review, and when both are done', async () => {
  const stage = (status, draft) => ({
    issues: status ? [gitlabIssue(5, 'Fix export', { status: { name: status, category: 'in_progress' } })] : [],
    mergeRequests: draft === undefined ? [] : [mergeRequest(9, 'Draft: Fix export', { draft, description: 'Refs acme/web#5' })],
    related: { 'acme/web!9': [relatedIssue('acme/web', 5, 'Fix export')] },
  });
  const board = await ticketBoard(stage('In progress', true));
  try {
    const cardId = (await refresh(board)).body.added[0].cardId;
    fs.writeFileSync(board.issuesFile, JSON.stringify(stage('In review', false)));
    const inReview = (await refresh(board)).body;
    assert.deepEqual([inReview.late, inReview.updated], [1, 1], 'still counted as in review, and its card brought up to date');
    let card = await cardOf(board, cardId);
    assert.deepEqual([card.description, linksOf(card)], ['**acme/web#5** · In review · 1 MR: 1 ready', ['acme/web#5', 'web!9 · ready']]);
    fs.writeFileSync(board.issuesFile, JSON.stringify(stage(null, undefined)));
    assert.equal((await refresh(board)).body.updated, 1);
    card = await cardOf(board, cardId);
    assert.deepEqual(linksOf(card), ['acme/web#5', 'web!9 · merged or closed'], 'its ticket gone from the list, its links still follow');
  } finally {
    await stopBoard(board);
  }
});

test("a draft's own card is adopted by one ticket only, when the draft works on two", async () => {
  const board = await ticketBoard({ issues: [], mergeRequests: [mergeRequest(6, 'Draft: Tidy the toolbar')], related: {} });
  try {
    await refresh(board);
    fs.writeFileSync(board.issuesFile, JSON.stringify({
      issues: [],
      mergeRequests: [mergeRequest(6, 'Draft: Tidy the toolbar', { description: 'Refs #1, #2' }), mergeRequest(7, 'Draft: Toolbar icons', { description: 'Refs #1' })],
      related: { 'acme/web!6': [relatedIssue('acme/web', 1, 'Toolbar is cluttered'), relatedIssue('acme/web', 2, 'Toolbar overflows')],
        'acme/web!7': [relatedIssue('acme/web', 1, 'Toolbar is cluttered')] },
    }));
    const second = (await refresh(board)).body;
    assert.deepEqual([second.added.length, second.updated], [1, 1], 'one ticket takes the draft\'s card, the other gets its own');
    const { activeWorkspaceId } = (await call(board, 'GET', '/api/state')).body;
    const cards = (await call(board, 'GET', `/api/workspaces/${activeWorkspaceId}`)).body.cards.filter((card) => card.source?.name === 'gitlab');
    assert.deepEqual(cards.map((card) => card.description).sort(), ['**acme/web#1** · 2 MRs: 2 draft', '**acme/web#2** · 1 MR: 1 draft']);
    assert.ok(!cards.some((card) => linksOf(card).some((title) => title.endsWith('merged or closed'))), 'no open draft is marked gone');
    assert.equal((await refresh(board)).body.updated, 0, 'and the next press finds nothing to change');
  } finally {
    await stopBoard(board);
  }
});

test("a card from before the board kept its first line takes the new one only if the line is still the refresh's", async () => {
  const issues = [gitlabIssue(1, 'Fix login', { status: TO_DO }), gitlabIssue(2, 'Fix export', { status: TO_DO })];
  let board = await ticketBoard({ issues, mergeRequests: [], related: {} });
  const { data, issuesFile } = board;
  try {
    const made = (await refresh(board)).body.added;
    const boardFile = path.join(data, 'board.json');
    const written = () => fs.existsSync(boardFile) && made.every(({ cardId }) => fs.readFileSync(boardFile, 'utf8').includes(cardId));
    for (let attempt = 0; attempt < 50 && !written(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const exited = new Promise((resolve) => board.server.once('exit', resolve));
    board.server.kill();
    await exited;
    const saved = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    for (const card of saved.workspaces.flatMap((w) => w.cards)) {   // as the first version left them
      delete card.source.summary;
      delete card.source.ticket;
      if (card.title === 'Fix export') card.description = '**acme/web#2** · blocked on the API';
    }
    fs.writeFileSync(boardFile, JSON.stringify(saved));
    fs.writeFileSync(issuesFile, JSON.stringify({ issues,
      mergeRequests: [mergeRequest(3, 'Draft: Login and export', { description: 'Refs #1, #2' })],
      related: { 'acme/web!3': [relatedIssue('acme/web', 1, 'Fix login'), relatedIssue('acme/web', 2, 'Fix export')] } }));
    board = await startBoard(false, { data, env: { FAKE_GLAB_ISSUES: issuesFile } });
    await refresh(board);
    const [login, exported] = await Promise.all(made.map(({ cardId }) => cardOf(board, cardId)));
    assert.equal(login.description, '**acme/web#1** · To do · 1 MR: 1 draft');
    assert.equal(exported.description, '**acme/web#2** · blocked on the API', 'the user wrote over it: it stays');
    assert.deepEqual(linksOf(exported), ['acme/web#2', 'web!3 · draft'], "its links are the refresh's all the same");
  } finally {
    await stopBoard(board);
  }
});
