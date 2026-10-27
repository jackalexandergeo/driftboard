#!/usr/bin/env node
// glab for the ticket tests: answers the board's GraphQL and REST calls from $FAKE_GLAB_ISSUES, a JSON list of
// issues or {issues, mergeRequests, related: {"<project>!<iid>": [issue]}}, after $FAKE_GLAB_DELAY milliseconds.
// "fails" in place of the merge requests, or of one's related issues, makes that call fail as glab does.
// A write (a new issue, a merge request's description) is answered as GitLab would and logged to $FAKE_GLAB_LOG.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(Number(process.env.FAKE_GLAB_DELAY) || 0);
const given = JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_ISSUES, 'utf8'));
const { issues = [], mergeRequests = [], related = {} } = Array.isArray(given) ? { issues: given } : given;
const args = process.argv.slice(2);   // api --hostname <host> [-X <method> -H … --input -] <endpoint>, or graphql -f …
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
const endpoint = args[3] === 'graphql' ? 'graphql' : args[args.length - 1];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
if (method !== 'GET' && process.env.FAKE_GLAB_LOG) fs.appendFileSync(process.env.FAKE_GLAB_LOG, `${JSON.stringify({ method, endpoint, body })}\n`);
const rest = /^projects\/(.+)\/merge_requests\/(\d+)\/(related_issues|commits)/.exec(endpoint);
const mergeRequest = /^projects\/(.+)\/merge_requests\/(\d+)$/.exec(endpoint);
const newIssue = /^projects\/(.+)\/issues$/.exec(endpoint);
const query = args[args.indexOf('-f') + 1] || '';
const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const failing = (rest && rest[3] === 'related_issues' && related[`${decodeURIComponent(rest[1])}!${rest[2]}`] === 'fails')
  || (endpoint === 'graphql' && query.includes('authoredMergeRequests') && mergeRequests === 'fails');
if (failing) {
  process.stderr.write('glab: 404 Not Found\n');
  process.exit(1);
}
const mine = (project, iid) => (Array.isArray(mergeRequests) ? mergeRequests : []).find((each) => each.reference === `${project}!${iid}`);
let answer;
if (endpoint === 'user') answer = { id: 7, username: 'pat', email: 'pat@example.com' };
else if (method === 'GET' && /^projects\/.+\/issues\?/.test(endpoint)) answer = [];
else if (rest) answer = rest[3] === 'commits' ? [] : related[`${decodeURIComponent(rest[1])}!${rest[2]}`] ?? [];
else if (mergeRequest) {
  const found = mine(decodeURIComponent(mergeRequest[1]), mergeRequest[2]);
  answer = { state: 'opened', draft: found?.draft, title: found?.title, description: body?.description ?? found?.description ?? '', author: { id: 7 } };
} else if (newIssue && method === 'POST') {
  answer = { iid: 12, web_url: `https://gitlab.example.com/${decodeURIComponent(newIssue[1])}/-/issues/12`,
    assignees: (body.assignee_ids || []).map((id) => ({ id })) };
} else if (query.includes('authoredMergeRequests')) answer = { data: { currentUser: { authoredMergeRequests: page(mergeRequests) } } };
else if (query.includes('currentUser')) answer = { data: { currentUser: { username: 'pat', name: 'Pat Doe', emails: { nodes: [{ email: 'pat@example.com' }] } } } };
else answer = { data: { issues: page(issues) } };
process.stdout.write(JSON.stringify(answer));
