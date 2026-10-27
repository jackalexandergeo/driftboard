#!/usr/bin/env node
// glab for the ticket tests: answers the board's GraphQL and REST calls from $FAKE_GLAB_ISSUES, a JSON list of
// issues or {issues, mergeRequests, related: {"<project>!<iid>": [issue]}}, after $FAKE_GLAB_DELAY milliseconds.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(Number(process.env.FAKE_GLAB_DELAY) || 0);
const given = JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_ISSUES, 'utf8'));
const { issues = [], mergeRequests = [], related = {} } = Array.isArray(given) ? { issues: given } : given;
const rest = /^projects\/(.+)\/merge_requests\/(\d+)\/related_issues$/.exec(process.argv[5] || '');
const query = process.argv[process.argv.indexOf('-f') + 1] || '';
const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const answer = rest ? related[`${decodeURIComponent(rest[1])}!${rest[2]}`] ?? []
  : query.includes('authoredMergeRequests') ? { data: { currentUser: { authoredMergeRequests: page(mergeRequests) } } }
    : query.includes('currentUser') ? { data: { currentUser: { username: 'pat' } } }
      : { data: { issues: page(issues) } };
process.stdout.write(JSON.stringify(answer));
