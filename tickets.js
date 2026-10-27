// The user's open tickets, from the trackers they name in <data>/tickets.json, for ↻ Tickets,
// and on GitLab the work of their draft merge requests too. Each tracker is read through its own
// command-line tool (glab, gh) and the login the user already has there: the board keeps no
// tracker token of its own.
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
const AT_ONCE = 6;         // calls to a tracker at the same time
const COMMIT_PAGES = 5;    // a merge request's commits read for the issues they name: 500 at most
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

// Whether a ticket is past the user's part. A draft merge request on it says it is not, whatever
// its status. Else its status's category counts first where the tracker has one (GitLab's done
// and canceled), then the words of its name: GitLab files a custom "Awaits Review" under in progress.
export function isLate(ticket, skipStatuses = SKIP_STATUSES) {
  if (ticket.active) return false;
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

// An issue's address in both its forms: GitLab answers /-/issues/N or /-/work_items/N.
function issueAddresses(url) {
  const form = /\/-\/(issues|work_items)\/(\d+)$/.exec(url);
  return { url, aliases: form ? [url.slice(0, form.index) + `/-/${form[1] === 'issues' ? 'work_items' : 'issues'}/${form[2]}`] : [] };
}

// run(item) for each item, AT_ONCE at a time, answers in order.
async function eachAtOnce(items, run) {
  const answers = [];
  for (let start = 0; start < items.length; start += AT_ONCE) {
    answers.push(...await Promise.all(items.slice(start, start + AT_ONCE).map(run)));
  }
  return answers;
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
const GITLAB_MERGE_REQUESTS = `query($after: String) {
  currentUser {
    authoredMergeRequests(state: opened, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { iid title description draft webUrl reference(full: true) project { fullPath } }
    }
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
      tickets.push({
        id: `${source.host}/${reference}`,
        kind: 'issue',
        ...issueAddresses(url),
        title: textOf(issue.title),
        reference,
        status: textOf(issue.status?.name) || labelStatus(labels, source.statusLabels),
        category: textOf(issue.status?.category).toLowerCase(),
        mergeRequests: [],
        active: false,
      });
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    onTime();
    after = data.issues.pageInfo.endCursor;
  }
  // The issues are read: past here a failure costs the merge requests' part only.
  const problems = [];
  let mergeRequests = null;
  try {
    onTime();
    mergeRequests = await addMergeRequestWork(source, tickets, graphql, run, onTime, problems);
  } catch (error) {
    problems.push(`merge requests not read: ${error.message}`);
  }
  return { tickets, mergeRequests, problems };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whether a merge request's own words name an issue: its reference (acme/web#5, or web#5), its
// address, or #5 in the merge request's own project.
function namesIssue(words, path, iid, project) {
  const forms = [`(?<![\\w.-])(?:${escapeRegExp(path)}|${escapeRegExp(path.split('/').pop())})#${iid}(?!\\d)`,
    `${escapeRegExp(path)}/-/(?:issues|work_items)/${iid}(?!\\d)`];
  if (path === project) forms.push(`(?<![\\w/#!&-])#${iid}(?!\\d)`);
  return new RegExp(forms.join('|')).test(words);
}

// The work of the user's open merge requests. An issue often has several (one per repository) and
// a merge request may work on several issues, so each issue's ticket lists all of its merge
// requests with their stage, draft or ready. A draft is work going on: the issues it works on are
// the user's work now, assigned to them or not, whatever their status. One ready for review brings
// in no work by itself (it is in review, late like an issue awaiting review); it is listed on the
// ticket its issue has anyway. A draft that works on no open issue is work of its own, with no
// ticket yet. Its issues are the ones GitLab links to it that its title, description or commit
// messages name: GitLab also links an issue a reviewer only mentions in a comment ("conflicts with
// #45"), which is not this work. One whose issues cannot be looked up is named in problems and left
// out of both.
async function addMergeRequestWork(source, tickets, graphql, run, onTime, problems) {
  const open = [];
  let after = null;
  for (let page = 0; page < PAGES; page += 1) {
    const found = (await graphql(GITLAB_MERGE_REQUESTS, after ? { after } : {})).currentUser?.authoredMergeRequests;
    if (!found) break;
    for (const mergeRequest of found.nodes || []) {
      const reference = textOf(mergeRequest?.reference);
      const project = textOf(mergeRequest?.project?.fullPath);
      const iid = textOf(mergeRequest?.iid);
      if (!reference || !project || !iid) continue;
      open.push({
        project, iid, words: `${textOf(mergeRequest.title)}\n${textOf(mergeRequest.description)}`,
        link: { id: `${source.host}/${reference}`, reference, url: textOf(mergeRequest.webUrl),
          title: textOf(mergeRequest.title).replace(/^(draft|wip):\s*/i, ''), stage: mergeRequest.draft === true ? 'draft' : 'ready' },
      });
    }
    if (!found.pageInfo?.hasNextPage) break;
    onTime();
    after = found.pageInfo.endCursor;
  }
  const worksOn = await eachAtOnce(open, async ({ project, iid, words, link }) => {
    onTime();
    const ask = async (what) => {
      const answer = parsed(await run(source.command, ['api', '--hostname', source.host,
        `projects/${encodeURIComponent(project)}/merge_requests/${iid}/${what}`]), source.command);
      return Array.isArray(answer) ? answer : [];
    };
    const messages = async () => {
      const read = [];
      for (let page = 1; page <= COMMIT_PAGES; page += 1) {
        const commits = await ask(`commits?per_page=100&page=${page}`);
        read.push(...commits.map((commit) => textOf(commit?.message)));
        if (commits.length < 100) break;
      }
      return read;
    };
    try {
      const [issues, commits] = await Promise.all([ask('related_issues?per_page=100'), messages()]);
      const named = [words, ...commits].join('\n');
      return issues.filter((issue) => {
        const where = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/(\d+)$/.exec(textOf(issue?.web_url));
        return issue?.state === 'opened' && where && namesIssue(named, where[1], where[2], project);
      });
    } catch (error) {
      problems.push(`${link.reference}: ${error.message}`);
      return null;
    }
  });
  const issues = new Map();   // id → {issue, reference, links}: every open issue an open merge request works on
  open.forEach(({ link }, index) => {
    if (!worksOn[index]) return;   // not known what it works on
    let working = 0;
    for (const issue of worksOn[index]) {
      const where = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/(\d+)$/.exec(textOf(issue.web_url));
      if (!where) continue;
      const reference = `${where[1]}#${where[2]}`;
      const id = `${source.host}/${reference}`;
      if (!issues.has(id)) issues.set(id, { issue, reference, links: [] });
      issues.get(id).links.push(link);
      working += 1;
    }
    if (!working && link.stage === 'draft') {
      tickets.push({ id: link.id, kind: 'mergeRequest', url: link.url, aliases: [], title: link.title, reference: link.reference,
        status: 'Draft MR, no ticket yet', category: '', mergeRequests: [], active: true });
    }
  });
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  for (const [id, { issue, reference, links }] of issues) {
    const drafted = links.some((link) => link.stage === 'draft');
    let ticket = byId.get(id);
    if (!ticket) {
      if (!drafted) continue;   // only in review, and not the user's ticket
      ticket = { id, kind: 'issue', ...issueAddresses(textOf(issue.web_url)), title: textOf(issue.title), reference, status: '', category: '' };
      tickets.push(ticket);
    }
    ticket.mergeRequests = links;
    ticket.active = ticket.active || drafted;
  }
  return open.map(({ link }) => link);
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
        kind: 'issue',
        url: textOf(issue.html_url),
        aliases: [],
        title: textOf(issue.title),
        reference,
        status: labelStatus(labels, source.statusLabels),
        category: '',
        mergeRequests: [],
        active: false,
      });
    }
    if (issues.length < 100) break;
    onTime();
  }
  return { tickets, mergeRequests: null, problems: [] };   // pull requests are not read
}

// {tickets, mergeRequests, problems}. tickets: [{id, kind, url, aliases, title, reference, status, category,
// mergeRequests: [link], active}], the open tickets assigned to the user and on GitLab the work of their
// merge requests. mergeRequests: every open merge request of the user's, as a link {id, reference, url,
// title, stage}, or null when they were not read. problems: what could not be read, the rest still was.
export function fetchTickets(source, run = runTool, { readTime = READ_TIME } = {}) {
  const giveUpAt = Date.now() + readTime;
  const onTime = () => {
    if (Date.now() >= giveUpAt) throw new Error(`reading ${source.host} took longer than ${readTime / 1000} s`);
  };
  return source.kind === 'gitlab' ? gitlabTickets(source, run, onTime) : githubTickets(source, run, onTime);
}
