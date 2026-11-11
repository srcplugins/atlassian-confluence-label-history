// The Playwright fixture for Label History's journeys. `labels` opens a journaled page run in the
// marked fixture space (the framework's pageAdapter: intent before every create, cleanup that
// rechecks each page's marker and space and purges it) and always cleans it up, also when an
// assertion failed. Labels and restrictions live on the run's pages and go with them.
//
// The test's own `page` and `confluence` act as the administrator (the API account); `pages.member`
// and `labels.member` are the member's saved session, as a browser page and as REST calls.
import { randomUUID } from 'node:crypto';
import { FixtureRun, markers } from '@srcplugins/atlassian-forge-test-framework/core';
import {
  test as base,
  expect,
  changeLabel,
  confluenceCall,
  confluenceTarget,
  findSpace,
  journalFile,
  pageAdapter,
  restrictPage,
} from '@srcplugins/atlassian-forge-test-framework/confluence';

const app = 'label-history';

async function accountId(call) {
  const { status, body } = await call('/wiki/rest/api/user/current');
  if (status !== 200 || typeof body?.accountId !== 'string' || body.type !== 'known')
    throw Error('Signed-in account unavailable.');
  return body.accountId;
}

async function labelRun({ admin, member }) {
  const space = await findSpace(admin, app);
  if (!space) throw Error('Fixture space missing: run forge-test prepare.');
  const runId = randomUUID();
  const run = FixtureRun.create({
    app,
    site: confluenceTarget().host,
    projectId: space.id,
    save: journalFile(runId).save,
    adapters: { page: pageAdapter(admin, space, runId) },
    runId,
  });
  const calls = { admin, member };
  const accounts = { admin: await accountId(admin), member: await accountId(member) };
  let count = 0;
  const applied = (result, what) => {
    if (result.outcome !== 'applied') throw Error(`${what} not applied (${result.outcome}).`);
  };
  return {
    run,
    space,
    accounts,
    calls,
    /** A run-unique label name, as Confluence stores it. */
    label: () => markers.runMarker(runId, ++count),
    /** A disposable page in the fixture space, created by the administrator. */
    async createPage(name) {
      const marker = markers.runMarker(runId, ++count);
      const entry = await run.create('page', { marker, title: `${marker} ${name}` });
      return { id: entry.id, title: entry.expected.title };
    },
    /** Adds or removes a label as one role's account; never repeated. */
    async change(role, pageId, action, name) {
      const result = await changeLabel(calls[role], pageId, action, name);
      run.check(`${role} ${action} ${name} on ${pageId}`, result.outcome);
      applied(result, `${role} label ${action}`);
    },
    /** Lets the administrator and the member view the page, and only the administrator edit it. */
    async viewOnlyForMember(pageId) {
      const result = await restrictPage(admin, pageId, {
        read: [accounts.admin, accounts.member],
        update: [accounts.admin],
      });
      run.check(`view-only ${pageId}`, result.outcome);
      applied(result, 'Restriction');
    },
    /**
     * Tries to add a label as the member, expecting Confluence to refuse; never repeated. Returns
     * the outcome (`rejected` when refused).
     */
    async memberAdds(pageId, name) {
      const result = await changeLabel(member, pageId, 'add', name);
      run.check(`member add ${name} on ${pageId}`, result.outcome);
      return result.outcome;
    },
    /** Lets only the administrator view and edit the page. */
    async restrictToAdmin(pageId) {
      const result = await restrictPage(admin, pageId, { read: [accounts.admin] });
      run.check(`restrict ${pageId}`, result.outcome);
      applied(result, 'Restriction');
    },
    /**
     * Moves a run's page to the trash as the administrator; cleanup purges it from there. Recorded
     * before it is sent, never repeated; an uncertain answer is settled by reading the page.
     */
    async trash(pageId) {
      if (!run.state.resources.some((r) => r.kind === 'page' && r.id === pageId))
        throw Error('Only a run page can be trashed.');
      run.check(`trash ${pageId}`, 'sending');
      let status = null;
      try {
        ({ status } = await admin(`/wiki/api/v2/pages/${pageId}`, 'DELETE'));
      } catch {
        // Settled by the read below.
      }
      const read = await admin(`/wiki/api/v2/pages/${pageId}?status=trashed&status=current`);
      run.check(`trash ${pageId}`, read.body?.status ?? read.status);
      if (read.body?.status !== 'trashed') throw Error(`Trash not applied (HTTP ${status}).`);
    },
    cleanup: () => run.cleanup(),
  };
}

export const test = base.extend({
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
  labels: async ({ confluence, sessions, page }, use, info) => {
    const labels = await labelRun({
      admin: confluence,
      member: confluenceCall(sessions.member.request),
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
