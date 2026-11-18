// A journaled page run in the marked fixture space (the framework's pageAdapter: intent before
// every create, cleanup that rechecks each page's marker and space and purges it), shared by the
// Playwright journeys (fixture.mjs) and the Rovo runner. Labels and restrictions live on the run's
// pages and go with them. `admin` and `member` are `confluenceCall`s as those accounts. A run can
// instead use the administrator's own personal space (`space: 'personal'`), which Confluence
// creates unmarked: only the run's marked pages are written there.
import { randomUUID } from 'node:crypto';
import { FixtureRun, markers } from '@srcplugins/atlassian-forge-test-framework/core';
import {
  changeLabel,
  confluenceTarget,
  expect,
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

/**
 * The caller's own personal space, verified read-only: Confluence reports it as the caller's
 * personal space and as created by the caller. The framework's `personalSpace` does the same;
 * this copy goes once the plugin's framework pin includes it (label-history#xp73).
 */
async function personalSpace(call) {
  const me = await call('/wiki/rest/api/user/current?expand=personalSpace');
  const caller = me.body?.accountId;
  const own = me.body?.personalSpace;
  if (me.status !== 200 || typeof caller !== 'string' || !own)
    throw Error('Personal space unavailable.');
  const key = String(own.key ?? '');
  if (!/^~[a-zA-Z0-9]+$/.test(key) || own.type !== 'personal')
    throw Error('Personal space ownership mismatch');
  const { status, body } = await call(
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}&limit=2`,
  );
  const results = body?.results;
  if (status !== 200 || !Array.isArray(results) || results.length !== 1)
    throw Error('Unexpected space listing.');
  const [space] = results;
  if (
    space.key !== key ||
    space.type !== 'personal' ||
    space.authorId !== caller ||
    !/^[1-9]\d*$/.test(String(space.id)) ||
    String(space.id) !== String(own.id)
  )
    throw Error('Personal space ownership mismatch');
  return { id: String(space.id), key };
}

/**
 * Opens a page run in the fixture space or the administrator's personal space, or reopens a
 * journaled one (`recover: runId`) to clean it up in whichever of the two it was journaled in.
 * @param {{ admin: any, member: any, recover?: string, space?: 'fixture' | 'personal' }} calls
 */
export async function labelRun({ admin, member, recover, space: where = 'fixture' }) {
  const runId = recover ?? randomUUID();
  const journal = journalFile(runId);
  const state = recover ? journal.load() : null;
  const fixture = await findSpace(admin, app);
  const personal =
    where === 'personal' || (recover && state?.projectId !== fixture?.id)
      ? await personalSpace(admin)
      : null;
  const space = recover
    ? [fixture, personal].find((s) => s?.id === state?.projectId)
    : where === 'personal'
      ? personal
      : fixture;
  if (!space)
    throw Error(
      recover
        ? 'Journal is not a Label History run in the fixture or personal space.'
        : 'Fixture space missing: run forge-test prepare.',
    );
  const pages = pageAdapter(admin, space, runId);
  const adapters = {
    page: {
      ...pages,
      // Confluence can still answer a read of a page just purged, so cleanup's independent read
      // waits for the purge to show. The framework's pageAdapter does this once the plugin's pin
      // includes it (atlassian-forge-test-framework f772f90).
      async remove(entry) {
        await pages.remove(entry);
        for (let i = 0; i < 4 && (await pages.read(entry.id)) !== null; i++)
          await new Promise((resolve) => setTimeout(resolve, 2000));
      },
    },
  };
  const run = recover
    ? new FixtureRun({ state, save: journal.save, adapters })
    : FixtureRun.create({
        app,
        site: confluenceTarget().host,
        projectId: space.id,
        save: journal.save,
        adapters,
        runId,
      });
  if (run.state.app !== app || run.state.runId !== runId || run.state.projectId !== space.id)
    throw Error('Journal is not a Label History run in its space.');
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
    /** A disposable page in the run's space, created by the administrator. */
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
    /**
     * Edits a run's published page in the administrator's editor (`page`) without publishing,
     * then discards the edit with the editor's "Revert to last published version", which
     * permanently deletes the draft: Confluence's REST API refuses to delete a published page's
     * draft (`content.delete.published`). Each step is recorded before it is taken and never
     * repeated; the page must still be published afterwards, without the edit.
     */
    async discardDraft(page, pageId) {
      if (!run.state.resources.some((r) => r.kind === 'page' && r.id === pageId))
        throw Error('Only a run page can have a draft discarded.');
      const edit = `Unpublished edit ${run.state.runId}`;
      const draft = async () =>
        (await admin(`/wiki/api/v2/pages/${pageId}?get-draft=true&body-format=storage`)).body;
      run.check(`edit ${pageId} unpublished`, 'sending');
      await page.goto(
        `${confluenceTarget().site}/wiki/spaces/${this.space.key}/pages/edit-v2/${pageId}`,
      );
      await page
        .locator('[contenteditable="true"]')
        .getByText('Synthetic data only.')
        .click({ timeout: 60_000 });
      await page.keyboard.press('End');
      await page.keyboard.type(` ${edit}`);
      await expect
        .poll(async () => (await draft())?.body?.storage?.value ?? '', { timeout: 60_000 })
        .toContain(edit);
      run.check(`edit ${pageId} unpublished`, 'draft saved');
      run.check(`discard draft ${pageId}`, 'sending');
      await page.getByRole('button', { name: 'More actions' }).last().click();
      await page.getByRole('menuitem', { name: 'Revert to previous version' }).click();
      const dialog = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: 'Revert to last published version?' }),
      });
      await dialog.getByRole('button', { name: 'Revert page' }).click();
      await expect
        .poll(async () => (await draft())?.body?.storage?.value ?? '', { timeout: 60_000 })
        .not.toContain(edit);
      const after = await admin(`/wiki/api/v2/pages/${pageId}?body-format=storage`);
      run.check(`discard draft ${pageId}`, after.body?.status ?? after.status);
      if (after.body?.status !== 'current') throw Error('The published page is gone.');
      if (after.body.body?.storage?.value?.includes(edit)) throw Error('The edit was published.');
    },
    cleanup: () => run.cleanup(),
  };
}
