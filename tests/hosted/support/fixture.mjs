// The Playwright fixture for Label History's journeys. `labels` opens a journaled page run
// (support/labels.mjs) and always cleans it up, also when an assertion failed.
//
// The test's own `page` and `confluence` act as the administrator (the API account); `pages.member`
// and `labels.member` are the member's saved session, as a browser page and as REST calls.
import {
  test as base,
  expect,
  confluenceCall,
  confluenceTarget,
} from '@srcplugins/atlassian-forge-test-framework/confluence';
import { labelRun } from './labels.mjs';

export const test = base.extend({
  // Where the journey's pages go: the marked fixture space, or the administrator's personal space.
  labelSpace: ['fixture', { option: true }],
  sessions: async ({ browser }, use) => {
    const member = await browser.newContext({
      storageState: `${confluenceTarget().authDirectory}/member.json`,
      viewport: { width: 1440, height: 1100 },
    });
    try {
      await use({ member });
    } finally {
      await member.close();
    }
  },
  pages: async ({ sessions }, use) => {
    const member = await sessions.member.newPage();
    member.setDefaultTimeout(15_000);
    await use({ member });
  },
  labels: async ({ confluence, sessions, page, labelSpace }, use, info) => {
    const labels = await labelRun({
      admin: confluence,
      member: confluenceCall(sessions.member.request),
      space: labelSpace,
    });
    const started = Date.now();
    try {
      await use(labels);
    } finally {
      labels.run.state.title = info.title;
      labels.run.state.exerciseMs = Date.now() - started;
      labels.run.state.testStatus = info.status;
      labels.run.persist();
      if (info.status !== info.expectedStatus)
        await page
          .screenshot({ path: `${confluenceTarget().runs}/${labels.run.state.runId}-failure.png` })
          .catch(() => {});
      await labels.cleanup();
    }
  },
});
export { expect };
