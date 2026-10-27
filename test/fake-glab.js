#!/usr/bin/env node
// glab for the ticket tests: answers the board's GraphQL with the issues in $FAKE_GLAB_ISSUES (a JSON list).
import fs from 'node:fs';

const query = process.argv[process.argv.indexOf('-f') + 1];
const answer = query.includes('currentUser')
  ? { data: { currentUser: { username: 'pat' } } }
  : { data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_ISSUES, 'utf8')) } } };
process.stdout.write(JSON.stringify(answer));
