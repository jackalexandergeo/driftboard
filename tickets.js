// The user's open tickets, from the trackers they name in <data>/tickets.json, for ↻ Tickets.
// Each tracker is read through its own command-line tool (glab, gh) and the login the user
// already has there: the board keeps no tracker token of its own.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

// A ticket whose status has a word starting with one of these is past the user's part (someone
// else's review, testing, a release): it gets no card. Backlog, to do, in progress, blocked do.
export const SKIP_STATUSES = ['review', 'verif', 'qa', 'test', 'done', 'deploy', 'merg', 'releas', 'closed', 'cancel', "won't", 'wont'];
// Where a tracker has no status of its own, a label like "Status::In Progress" is the status.
const STATUS_LABELS = ['status::', 'status:', 'status/'];
const KINDS = { gitlab: { host: 'gitlab.com', command: 'glab' }, github: { host: 'github.com', command: 'gh' } };
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]*$/;   // as an item's source
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i;
const PAGES = 20;          // at most this many pages of 100 tickets from one tracker
const TOOL_TIMEOUT = 60_000;
const ANSWER_LIMIT = 32 * 1024 * 1024;
// One tracker's whole read, its pages together: well inside the time a browser's request lasts.
const READ_TIME = 120_000;

// tickets.json, checked: {sources: [{kind, name, host, command, statusLabels}], skipStatuses, problems}.
export function parseTicketConfig(text) {
  const config = { sources: [], skipStatuses: SKIP_STATUSES, problems: [] };
  let given;
  try {
    given = JSON.parse(text);
  } catch (error) {
    config.problems.push(`tickets.json is not JSON: ${error.message}`);
    return config;
  }
  if (!given || typeof given !== 'object' || !Array.isArray(given.sources)) {
    config.problems.push('tickets.json needs "sources": a list of trackers, e.g. [{"kind": "gitlab", "host": "gitlab.example.com"}]');
    return config;
  }
  const names = new Set();
  given.sources.forEach((source, index) => {
    const where = `sources[${index}]`;
    const kind = Object.hasOwn(KINDS, source?.kind ?? '') ? KINDS[source.kind] : null;
    if (!kind) return config.problems.push(`${where}: "kind" must be one of ${Object.keys(KINDS).join(', ')}`);
    const host = source.host ?? kind.host;
    const name = source.name ?? source.kind;
    const command = source.command ?? kind.command;
    const statusLabels = source.statusLabels ?? STATUS_LABELS;
    if (typeof host !== 'string' || !HOST_NAME.test(host)) return config.problems.push(`${where}: "host" must be a host name, like gitlab.example.com`);
    if (typeof name !== 'string' || !SOURCE_NAME.test(name) || name.length > 40) {
      return config.problems.push(`${where}: "name" must be lowercase letters, digits, . _ - (it is the cards' source)`);
    }
    if (names.has(name)) return config.problems.push(`${where}: another source is named "${name}" too: give one a "name"`);
    if (typeof command !== 'string' || !command.trim()) return config.problems.push(`${where}: "command" must be the tool to run, like ${kind.command}`);
    if (!Array.isArray(statusLabels) || !statusLabels.every((label) => typeof label === 'string' && label)) {
      return config.problems.push(`${where}: "statusLabels" must be a list of label beginnings, like ["Status::"]`);
    }
    names.add(name);
    config.sources.push({ kind: source.kind, name, host, command, statusLabels: statusLabels.map((label) => label.toLowerCase()) });
  });
  if (given.skipStatuses !== undefined) {
    if (!Array.isArray(given.skipStatuses) || !given.skipStatuses.every((word) => typeof word === 'string' && word.trim())) {
      config.problems.push('"skipStatuses" must be a list of words, like ["review", "done"]');
    } else {
      config.skipStatuses = given.skipStatuses.map((word) => word.trim().toLowerCase());
    }
  }
  return config;
}

// The file is read again only when it changed, so an edit counts at the next press. One that
// cannot be read is a problem to show, never an error: the board reads it for every page.
let cached = null;
export function loadTicketConfig(file) {
  try {
    const stat = fs.statSync(file);
    if (cached?.file !== file || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, config: parseTicketConfig(fs.readFileSync(file, 'utf8')) };
    }
    return cached.config;
  } catch (error) {
    if (error.code === 'ENOENT') return { sources: [], skipStatuses: SKIP_STATUSES, problems: [] };
    return { sources: [], skipStatuses: SKIP_STATUSES, problems: [`cannot read ${file}: ${error.message}`] };
  }
}

// Whether a ticket is past the user's part. Its status's category counts first where the
// tracker has one (GitLab's done and canceled), then the words of its name: GitLab files a
// custom "Awaits Review" under in progress.
export function isLate(ticket, skipStatuses = SKIP_STATUSES) {
  if (['done', 'canceled'].includes(ticket.category)) return true;
  const words = (ticket.status || '').toLowerCase().replace(/’/g, "'").split(/[\s_/-]+/).filter(Boolean);
  return words.some((word) => skipStatuses.some((skip) => word.startsWith(skip)));
}

// A tracker's answer is read as it comes: a field that is not text is empty, never an error.
const textOf = (value) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

function labelStatus(labels, statusLabels) {
  for (const label of labels) {
    const prefix = statusLabels.find((start) => label.toLowerCase().startsWith(start));
    if (prefix) return label.slice(prefix.length).trim();
  }
  return '';
}

// Runs a tracker's tool, without a shell. A failure says what the tool said, in short.
export function runTool(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TOOL_TIMEOUT, maxBuffer: ANSWER_LIMIT }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.code === 'ENOENT') return reject(new Error(`${command} is not installed, or not on the board's PATH: give its full path as "command"`));
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error(`${command} answered more than ${ANSWER_LIMIT / 1024 / 1024} MB`));
      if (error.killed) return reject(new Error(`${command} took longer than ${TOOL_TIMEOUT / 1000} s`));
      const said = String(stderr || error.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
      reject(new Error(said.slice(0, 300) || `${command} failed`));
    });
  });
}

function parsed(output, command) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} answered something that is not JSON`);
  }
}

// GitLab: one GraphQL query, with the issue's own status where the instance has it (Premium,
// GitLab 18 and later), else its status label. An issue's address has two forms.
const GITLAB_ISSUES = (withStatus) => `query($username: String!, $after: String) {
  issues(assigneeUsernames: [$username], state: opened, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { webUrl title reference(full: true) labels { nodes { title } }${withStatus ? ' status { name category }' : ''} }
  }
}`;

async function gitlabTickets(source, run, onTime) {
  const graphql = async (query, variables = {}) => {
    const args = ['api', '--hostname', source.host, 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
    const answer = parsed(await run(source.command, args), source.command);
    if (answer.errors?.length) throw new Error(answer.errors.map((error) => error.message).join('; '));
    return answer.data;
  };
  const me = (await graphql('query { currentUser { username } }')).currentUser;
  if (!me) throw new Error(`${source.command} is not signed in to ${source.host}`);
  let query = GITLAB_ISSUES(true);
  const issuesAfter = async (after) => {
    const variables = { username: me.username, ...(after ? { after } : {}) };
    try {
      return await graphql(query, variables);
    } catch (error) {
      if (query === GITLAB_ISSUES(false) || !/'status' doesn't exist/.test(error.message)) throw error;
      query = GITLAB_ISSUES(false);   // an instance without issue statuses: the labels say it
      return graphql(query, variables);
    }
  };
  const tickets = [];
  let after = null;
  for (let page = 0; page < PAGES; page += 1) {
    const data = await issuesAfter(after);
    for (const issue of data.issues.nodes) {
      const url = textOf(issue?.webUrl);
      const reference = textOf(issue?.reference);
      if (!reference) continue;   // nothing to know it by
      const labels = (issue.labels?.nodes || []).map((label) => textOf(label?.title));
      const form = /\/-\/(issues|work_items)\/(\d+)$/.exec(url);
      tickets.push({
        id: `${source.host}/${reference}`,
        url,
        aliases: form ? [url.slice(0, form.index) + `/-/${form[1] === 'issues' ? 'work_items' : 'issues'}/${form[2]}`] : [],
        title: textOf(issue.title),
        reference,
        status: textOf(issue.status?.name) || labelStatus(labels, source.statusLabels),
        category: textOf(issue.status?.category).toLowerCase(),
      });
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    onTime();
    after = data.issues.pageInfo.endCursor;
  }
  return tickets;
}

// GitHub: the open issues assigned to the user in every repository they can see. Issues have
// no status of their own there: a status label is it.
async function githubTickets(source, run, onTime) {
  const tickets = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const path = `/issues?filter=assigned&state=open&per_page=100&page=${page}`;
    const issues = parsed(await run(source.command, ['api', '--hostname', source.host, path]), source.command);
    if (!Array.isArray(issues)) throw new Error(`${source.command} did not answer a list of issues`);
    for (const issue of issues) {
      if (!issue || issue.pull_request) continue;   // the same list carries pull requests
      const repository = textOf(issue.repository?.full_name);
      const number = textOf(issue.number);
      if (!repository || !number) continue;   // nothing to know it by
      const reference = `${repository}#${number}`;
      const labels = (Array.isArray(issue.labels) ? issue.labels : []).map((label) => textOf(typeof label === 'string' ? label : label?.name));
      tickets.push({
        id: `${source.host}/${reference}`,
        url: textOf(issue.html_url),
        aliases: [],
        title: textOf(issue.title),
        reference,
        status: labelStatus(labels, source.statusLabels),
        category: '',
      });
    }
    if (issues.length < 100) break;
    onTime();
  }
  return tickets;
}

// [{id, url, aliases, title, reference, status, category}]: the open tickets assigned to the user.
export function fetchTickets(source, run = runTool, { readTime = READ_TIME } = {}) {
  const giveUpAt = Date.now() + readTime;
  const onTime = () => {
    if (Date.now() >= giveUpAt) throw new Error(`reading ${source.host} took longer than ${readTime / 1000} s`);
  };
  return source.kind === 'gitlab' ? gitlabTickets(source, run, onTime) : githubTickets(source, run, onTime);
}
