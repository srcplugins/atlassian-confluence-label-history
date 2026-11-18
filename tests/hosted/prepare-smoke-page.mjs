// Prepares, once, the page Publish's production smoke opens (tests/hosted/production-smoke.mjs):
// a marked page in the fixture space, created through a journaled page run that is kept rather
// than cleaned up, since the smoke only reads it. A space homepage shows no byline, so the smoke
// needs a page of its own. Does nothing when the page already exists.
//   LH_SMOKE_PAGE=1 node tests/hosted/prepare-smoke-page.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import {
  confluenceCall,
  confluenceTarget,
  findSpace,
  tokenRequest,
} from '@srcplugins/atlassian-forge-test-framework/confluence';
import { labelRun } from './support/labels.mjs';
import { smokePageName, smokePages } from './production-smoke.mjs';

assert.equal(process.env.LH_SMOKE_PAGE, '1', 'Explicit smoke page preparation required');
const target = confluenceTarget();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const member = await browser.newContext({
    storageState: `${target.authDirectory}/member.json`,
  });
  const call = confluenceCall(await tokenRequest());
  const space = await findSpace(call, 'label-history');
  assert.ok(space, 'Fixture space missing: run forge-test prepare.');
  const existing = await smokePages((path) => call(path), space);
  if (existing.length) {
    console.log(`Smoke page already there: ${existing[0].id}.`);
  } else {
    const run = await labelRun({ admin: call, member: confluenceCall(member.request) });
    const page = await run.createPage(smokePageName);
    // Kept: the journal stays open with the page, so a later cleanup of this run can remove it.
    run.run.state.kept = 'production smoke page';
    run.run.persist();
    console.log(`Smoke page ${page.id} created by run ${run.run.state.runId}.`);
  }
} finally {
  await browser.close();
}
