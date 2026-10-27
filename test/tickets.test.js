// Reading open tickets from the trackers (tickets.js), with the trackers' tools played by a fake.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTickets, isLate, parseTicketConfig, SKIP_STATUSES } from '../tickets.js';

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

// glab, answering GraphQL: who the user is, then pages of their issues.
function fakeGlab(pages, { statusField = true } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const query = args[args.indexOf('-f') + 1];
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
  assert.match(parseTicketConfig('{}').problems[0], /needs "sources"/);
});
