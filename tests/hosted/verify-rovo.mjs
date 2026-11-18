// Hosted Rovo acceptance for Label History on the development installation:
//   LH_ROVO_TESTS=1 node tests/hosted/verify-rovo.mjs run            (a suite step)
//   LH_ROVO_TESTS=1 node tests/hosted/verify-rovo.mjs cleanup <run>  (guarded recovery)
// The member asks the Label History agent who changed the labels on a page whose label change the
// app recorded, then on a page restricted to the administrator. The answer must carry the first
// page's label and nothing of the second's; Confluence facts (independent reads) prove that
// nothing changed. Pages are journaled fixtures (support/labels.mjs), always cleaned up.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { askRovo, openRovoChat } from '@srcplugins/atlassian-forge-test-framework/browser';
import {
  confluenceCall,
  confluenceTarget,
  expect,
  pageLabels,
  tokenRequest,
} from '@srcplugins/atlassian-forge-test-framework/confluence';
import { labelRun } from './support/labels.mjs';
import { historyWhen } from './support/app.mjs';

const [mode, recoverId] = process.argv.slice(2);
assert.ok(mode === 'run' || (mode === 'cleanup' && /^[0-9a-f-]{36}$/.test(recoverId ?? '')));
assert.equal(process.env.LH_ROVO_TESTS, '1', 'Explicit LH_ROVO_TESTS=1 required');
assert.equal(process.env.PLUGIN_TEST_ENVIRONMENT ?? 'development', 'development');

const agent = 'Label History for Confluence';
const starter = 'Who changed the labels on a page?';
const target = confluenceTarget();
const request = await tokenRequest();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = (role) =>
  browser.newContext({
    storageState: `${target.authDirectory}/${role}.json`,
    viewport: { width: 1440, height: 1100 },
  });
let labels;
const evidence = (name, data) =>
  writeFileSync(
    `${target.runs}/${labels.run.state.runId}-rovo-${name}.json`,
    JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
try {
  const memberContext = await context('member');
  const calls = { admin: confluenceCall(request), member: confluenceCall(memberContext.request) };
  if (mode === 'cleanup') {
    labels = await labelRun({ ...calls, recover: recoverId });
    await labels.cleanup();
    console.log(`Rovo run ${recoverId}: clean.`);
  } else {
    labels = await labelRun(calls);
    labels.run.state.title = 'LH-06 Rovo';
    try {
      const admin = await (await context('admin')).newPage();
      const member = await memberContext.newPage();
      for (const page of [admin, member]) page.setDefaultTimeout(30_000);
      const { key } = labels.space;

      const open = await labels.createPage('Rovo answers');
      const hidden = await labels.createPage('Rovo withholds');
      const shown = labels.label();
      const withheld = labels.label();
      await labels.change('admin', open.id, 'add', shown);
      await labels.change('admin', hidden.id, 'add', withheld);
      // The app recorded both before the second page is restricted to the administrator.
      await historyWhen(member, key, open.id, (h) => expect(h.changes).toHaveLength(1));
      await historyWhen(admin, key, hidden.id, (h) => expect(h.changes).toHaveLength(1));
      await labels.restrictToAdmin(hidden.id);
      // Confluence itself now refuses the page to the member.
      const read = await calls.member(`/wiki/api/v2/pages/${hidden.id}`);
      assert.ok(
        [403, 404].includes(read.status),
        `The member can still read the page (${read.status})`,
      );

      const asked = (id) =>
        `Who changed the labels on page ${id}? Quote each label exactly as recorded.`;
      // Only the installation under test has this page's history, so its answer picks the agent
      // when the gallery lists the agent of more than one environment.
      await openRovoChat(member, {
        url: `${target.site}/wiki/home`,
        agent,
        starter,
        inventory: {
          prompt: asked(open.id),
          matches: (text) => text.toLowerCase().includes(shown),
        },
      });
      const answer = await askRovo(member, asked(open.id));
      evidence('open', { pageId: open.id, expected: shown, answer });
      assert.ok(answer.toLowerCase().includes(shown), "The answer lacks the page's label");

      const refused = await askRovo(member, asked(hidden.id));
      evidence('hidden', { pageId: hidden.id, withheld, answer: refused });
      assert.ok(!refused.toLowerCase().includes(withheld), "The restricted page's label leaked");
      assert.ok(!refused.includes(hidden.title), "The restricted page's title leaked");
      assert.match(
        refused,
        /\b(?:not available|isn['’]t available|unavailable|not accessible|no access|restricted|can(?:no|['’])t (?:see|access|view)|don['’]t have access)\b/i,
      );

      // Read-only: both pages keep their label.
      assert.deepEqual(await pageLabels(calls.admin, open.id), [shown]);
      assert.deepEqual(await pageLabels(calls.admin, hidden.id), [withheld]);
      labels.run.check(
        'Rovo answered the open page with its label and withheld the restricted one',
      );
      labels.run.state.testStatus = 'passed';
      console.log(
        `Rovo ${labels.run.state.runId}: the agent quoted the open page's label, withheld the restricted page, and Confluence was unchanged.`,
      );
    } catch (error) {
      labels.run.state.testStatus = 'failed';
      writeFileSync(
        `${target.runs}/${labels.run.state.runId}-rovo-error.txt`,
        error instanceof Error ? (error.stack ?? error.message) : 'Unknown failure',
        { mode: 0o600 },
      );
      console.log('Rovo acceptance failed; inspect private evidence.');
      process.exitCode = 1;
    } finally {
      labels.run.persist();
      await labels.cleanup();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Rovo runner stopped');
  process.exitCode = 1;
} finally {
  await browser.close();
  await request.dispose();
}
