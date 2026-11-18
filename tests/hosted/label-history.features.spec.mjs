// Hosted journeys for Label History for Confluence on the development installation. Each journey
// changes labels on its own disposable pages in the marked fixture space (LH-08: the
// administrator's personal space), through Confluence's REST API as the administrator and the
// member, then opens the Label History item under a page's title as a person would.
import { pageLabels } from '@srcplugins/atlassian-forge-test-framework/confluence';
import { test, expect } from './support/fixture.mjs';
import {
  bylineHistory,
  changeRows,
  historyWhen,
  redirectHistory,
  restoreLabel,
} from './support/app.mjs';

// Confluence can show a label event's change a while after it lands.
test.setTimeout(240_000);

const summary = (changes) => changes.map(({ action, label, actor }) => ({ action, label, actor }));
const refusal = {
  ok: false,
  error: "This page isn't available to you. It may be restricted, in the trash or deleted.",
};

/**
 * Opens `open`'s byline history but asks for `hidden`'s, as a direct request would, and checks the
 * refusal the popup shows: its text and Try again, and no table.
 */
async function historyOf(page, spaceKey, open, hidden) {
  const stop = await redirectHistory(page, hidden);
  try {
    const answer = await bylineHistory(page, spaceKey, open);
    await expect(page.getByText(refusal.error)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(changeRows(page)).toHaveCount(0);
    return answer;
  } finally {
    await stop();
  }
}

test('LH-01 label changes show under the page title, newest first, with who made them', async ({
  pages,
  labels,
}) => {
  const { admin, member } = labels.accounts;
  const target = await labels.createPage('Labelled page');
  const label = labels.label();
  await labels.change('admin', target.id, 'add', label);
  await labels.change('member', target.id, 'remove', label);
  // Confluence itself no longer has the label.
  expect(await pageLabels(labels.calls.admin, target.id)).not.toContain(label);

  // The member sees both changes, though the administrator made one of them.
  const history = await historyWhen(pages.member, labels.space.key, target.id, (h) =>
    expect(summary(h.changes)).toEqual([
      { action: 'removed', label, actor: member },
      { action: 'added', label, actor: admin },
    ]),
  );
  expect(history.page).toEqual({ id: target.id, title: target.title, archived: false });
  expect(history.older).toBe(false);
  const rows = changeRows(pages.member);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Removed');
  await expect(rows.nth(0)).toContainText(label);
  await expect(rows.nth(1)).toContainText('Added');
});

test('LH-02 a page restricted after its changes were recorded shows its history to nobody who cannot view it', async ({
  page,
  pages,
  labels,
}) => {
  const hidden = await labels.createPage('Restricted later');
  const open = await labels.createPage('Stays open');
  const label = labels.label();
  await labels.change('admin', hidden.id, 'add', label);
  await labels.change('admin', open.id, 'add', label);
  const recorded = (h) =>
    expect(summary(h.changes)).toEqual([{ action: 'added', label, actor: labels.accounts.admin }]);
  await historyWhen(pages.member, labels.space.key, hidden.id, recorded);
  await historyWhen(pages.member, labels.space.key, open.id, recorded);

  await labels.restrictToAdmin(hidden.id);
  // Confluence itself now refuses the page to the member.
  const read = await labels.calls.member(`/wiki/api/v2/pages/${hidden.id}`);
  expect([403, 404]).toContain(read.status);

  // Asking for the hidden page's history directly is refused, without its title or labels.
  expect(await historyOf(pages.member, labels.space.key, open.id, hidden.id)).toEqual(refusal);
  // The administrator, who can still view it, still sees its history.
  await historyWhen(page, labels.space.key, hidden.id, recorded);
});

test('LH-03 a page moved to the trash shows its history to nobody, the administrator included', async ({
  page,
  labels,
}) => {
  const trashed = await labels.createPage('Trashed later');
  const open = await labels.createPage('Stays open');
  const label = labels.label();
  await labels.change('admin', trashed.id, 'add', label);
  await historyWhen(page, labels.space.key, trashed.id, (h) =>
    expect(summary(h.changes)).toEqual([{ action: 'added', label, actor: labels.accounts.admin }]),
  );

  await labels.trash(trashed.id);
  // Confluence's batch page read, with its default statuses, no longer returns it.
  const read = await labels.calls.admin(`/wiki/api/v2/pages?id=${trashed.id},${open.id}&limit=250`);
  expect(read.status).toBe(200);
  expect(read.body.results.map((p) => p.id)).toEqual([open.id]);

  expect(await historyOf(page, labels.space.key, open.id, trashed.id)).toEqual(refusal);
});

test('LH-04 a member restores a removed label from the history, and the restore is recorded under their name', async ({
  pages,
  labels,
}) => {
  const { admin, member } = labels.accounts;
  const target = await labels.createPage('Restored label');
  const label = labels.label();
  await labels.change('admin', target.id, 'add', label);
  await labels.change('admin', target.id, 'remove', label);
  const history = await historyWhen(pages.member, labels.space.key, target.id, (h) =>
    expect(summary(h.changes)).toEqual([
      { action: 'removed', label, actor: admin },
      { action: 'added', label, actor: admin },
    ]),
  );
  expect(history.canEdit).toBe(true);
  // Only the newest change, the removal, can be undone.
  await expect(changeRows(pages.member).getByRole('button', { name: 'Restore' })).toHaveCount(1);

  expect(await restoreLabel(pages.member, label)).toEqual({
    ok: true,
    value: { label, confirmed: true },
  });
  await expect(pages.member.getByText(`Label "${label}" restored`)).toBeVisible();
  // The outcome takes focus, so a screen reader reaches it.
  await expect(pages.member.getByRole('button', { name: 'Close' })).toBeFocused();
  // The open history shows the restore at once, and the label can't be restored again.
  const rows = changeRows(pages.member);
  await expect(rows).toHaveCount(3, { timeout: 5000 });
  await expect(rows.nth(0)).toContainText('Added');
  await expect(rows.nth(0)).toContainText(label);
  await expect(rows.getByRole('button', { name: 'Restore' })).toHaveCount(0);
  // Confluence itself has the label again.
  expect(await pageLabels(labels.calls.admin, target.id)).toContain(label);

  await historyWhen(pages.member, labels.space.key, target.id, (h) =>
    expect(summary(h.changes)[0]).toEqual({ action: 'added', label, actor: member }),
  );
  await expect(changeRows(pages.member)).toHaveCount(3);
  await expect(changeRows(pages.member).getByRole('button', { name: 'Restore' })).toHaveCount(0);
});

test('LH-05 a member who can view but not edit a page gets no Restore, and Confluence refuses their label', async ({
  pages,
  labels,
}) => {
  const target = await labels.createPage('View only');
  const label = labels.label();
  await labels.change('admin', target.id, 'add', label);
  await labels.change('admin', target.id, 'remove', label);
  // Restricted once recorded: Confluence sends no label events for a restricted page.
  await historyWhen(pages.member, labels.space.key, target.id, (h) =>
    expect(h.changes[0]).toMatchObject({ action: 'removed', label }),
  );
  await labels.viewOnlyForMember(target.id);

  await historyWhen(pages.member, labels.space.key, target.id, (h) =>
    expect(h.canEdit).toBe(false),
  );
  await expect(changeRows(pages.member)).toHaveCount(2);
  await expect(pages.member.getByRole('button', { name: 'Restore' })).toHaveCount(0);
  // Confluence itself refuses the member's label on the page.
  expect(await labels.memberAdds(target.id, label)).toBe('rejected');
  expect(await pageLabels(labels.calls.admin, target.id)).not.toContain(label);
});

test("LH-07 discarding a page's unpublished draft keeps the page's history", async ({
  page,
  labels,
}) => {
  const { admin } = labels.accounts;
  const target = await labels.createPage('Draft discarded');
  const first = labels.label();
  await labels.change('admin', target.id, 'add', first);
  await historyWhen(page, labels.space.key, target.id, (h) =>
    expect(summary(h.changes)).toEqual([{ action: 'added', label: first, actor: admin }]),
  );

  // The draft shares the page's ID; Confluence permanently deletes a discarded draft.
  await labels.discardDraft(page, target.id);
  // A label changed after the discard shows once later events have arrived; the first change is
  // still there, so no deletion event for the page removed its history.
  const second = labels.label();
  await labels.change('admin', target.id, 'add', second);
  await historyWhen(page, labels.space.key, target.id, (h) =>
    expect(summary(h.changes)).toEqual([
      { action: 'added', label: second, actor: admin },
      { action: 'added', label: first, actor: admin },
    ]),
  );
});

test.describe('in a personal space', () => {
  // Confluence creates the personal space unmarked; only the run's marked pages go there (owner,
  // 2026-11-12, label-history#xp73).
  test.use({ labelSpace: 'personal' });

  test("LH-08 in the administrator's personal space, a page's history shows only to those who can view the page", async ({
    page,
    pages,
    labels,
  }) => {
    const hidden = await labels.createPage('Personal, restricted later');
    const open = await labels.createPage('Personal, stays open');
    const label = labels.label();
    await labels.change('admin', hidden.id, 'add', label);
    await labels.change('admin', open.id, 'add', label);
    const recorded = (h) =>
      expect(summary(h.changes)).toEqual([
        { action: 'added', label, actor: labels.accounts.admin },
      ]);
    // The member can view the administrator's personal space, so sees both histories.
    await historyWhen(pages.member, labels.space.key, hidden.id, recorded);
    await historyWhen(pages.member, labels.space.key, open.id, recorded);

    await labels.restrictToAdmin(hidden.id);
    const read = await labels.calls.member(`/wiki/api/v2/pages/${hidden.id}`);
    expect([403, 404]).toContain(read.status);
    expect(await historyOf(pages.member, labels.space.key, open.id, hidden.id)).toEqual(refusal);
    await historyWhen(page, labels.space.key, hidden.id, recorded);
  });
});
