#!/usr/bin/env node
// glab for the ticket tests: answers the board's GraphQL and REST calls from $FAKE_GLAB_ISSUES, a JSON list of
// issues or {issues, mergeRequests, related: {"<project>!<iid>": [issue]}}, after $FAKE_GLAB_DELAY milliseconds.
// "fails" in place of the merge requests, or of one's related issues, makes that call fail as glab does.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(Number(process.env.FAKE_GLAB_DELAY) || 0);
const given = JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_ISSUES, 'utf8'));
const { issues = [], mergeRequests = [], related = {} } = Array.isArray(given) ? { issues: given } : given;
const rest = /^projects\/(.+)\/merge_requests\/(\d+)\/(related_issues|commits)/.exec(process.argv[5] || '');
const query = process.argv[process.argv.indexOf('-f') + 1] || '';
const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const failing = (rest && rest[3] === 'related_issues' && related[`${decodeURIComponent(rest[1])}!${rest[2]}`] === 'fails')
  || (!rest && query.includes('authoredMergeRequests') && mergeRequests === 'fails');
if (failing) {
  process.stderr.write('glab: 404 Not Found\n');
  process.exit(1);
}
const answer = rest ? (rest[3] === 'commits' ? [] : related[`${decodeURIComponent(rest[1])}!${rest[2]}`] ?? [])
  : query.includes('authoredMergeRequests') ? { data: { currentUser: { authoredMergeRequests: page(mergeRequests) } } }
    : query.includes('currentUser') ? { data: { currentUser: { username: 'pat' } } }
      : { data: { issues: page(issues) } };
process.stdout.write(JSON.stringify(answer));
