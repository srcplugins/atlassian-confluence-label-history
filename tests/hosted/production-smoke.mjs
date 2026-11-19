// Production smoke for Label History. Publish runs these checks through config/production-smoke.mjs
// right after the production deploy, against the production installation on an owned site, so a
// release that breaks the byline fails within minutes. Read-only: the check opens a kept page in
// the marked fixture space and its byline history, and changes nothing.
import { expect } from '@srcplugins/atlassian-forge-test-framework/confluence';

export const app = 'label-history';

// src/license.ts: what the byline shows when the site has no subscription.
const refusal =
  'Label History for Confluence has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';
const empty = 'No label changes recorded for this page yet.';
// Confluence's and Forge's messages for an app that fails to load.
const errorText = /something went wrong|couldn.t load|problem loading|error loading/i;

/** The kept page's title ends with this (tests/hosted/prepare-smoke-page.mjs makes it). */
export const smokePageName = 'Production smoke page (kept)';

/**
 * The fixture space's current pages made for the smoke, read with `read` (a GET of a Confluence
 * path answering `{ status, body }`). A space homepage shows no byline, so the smoke opens one of
 * these.
 */
export async function smokePages(read, space) {
  const { status, body } = await read(
    `/wiki/api/v2/spaces/${space.id}/pages?status=current&limit=250`,
  );
  if (status !== 200 || !Array.isArray(body?.results)) throw Error('Fixture pages unreadable.');
  return body.results.filter(
    (page) => /^[1-9]\d*$/.test(String(page.id)) && page.title.endsWith(` ${smokePageName}`),
  );
}

/** The kept page, read with the admin session (GET only). */
async function smokePage(page, site, space) {
  const read = async (path) => {
    const response = await page.request.get(`${site}${path}`);
    return { status: response.status(), body: await response.json().catch(() => null) };
  };
  const [found] = await smokePages(read, space);
  if (!found) throw Error('No smoke page: run tests/hosted/prepare-smoke-page.mjs once.');
  return `${site}/wiki/spaces/${encodeURIComponent(space.key)}/pages/${found.id}`;
}

/** Opens the kept page's Label History byline item until it shows an answer. */
async function openByline(page, site, space) {
  const url = await smokePage(page, site, space);
  const table = page.getByRole('table', { name: 'Label changes' });
  const none = page.getByText(empty, { exact: true });
  const refused = page.getByText(refusal, { exact: true });
  // Forge upgrades the installation shortly after the deploy; reload until the byline answers.
  await expect(async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Production's item, never the development installation's "Label History (Development)" on
    // the same page.
    await page
      .getByRole('button', { name: 'Label History', exact: true })
      .click({ timeout: 45000 });
    await expect(table.or(none).or(refused).first()).toBeVisible({ timeout: 30000 });
  }).toPass({ timeout: 300000, intervals: [15000] });
  return { table, none, refused };
}

// An installation without a subscription refuses the history, so the smoke checks that refusal
// and reports unlicensed instead of passed.
export async function state({ page, site, space }) {
  const { refused } = await openByline(page, site, space);
  return (await refused.isVisible())
    ? { outcome: 'unlicensed', reason: 'no active subscription on the owned site' }
    : null;
}

export const checks = [
  {
    title: 'Byline history loads on a fixture page',
    async run({ page, site, space, state: licensing }) {
      const { table, none, refused } = await openByline(page, site, space);
      if (licensing?.outcome === 'unlicensed') {
        await expect(refused).toBeVisible();
        return;
      }
      await expect(table.or(none).first()).toBeVisible();
      await expect(refused).toHaveCount(0);
      // Loaded, not failed: no load error to retry, and no error from Confluence or Forge.
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
      await expect(page.getByText(errorText).filter({ visible: true })).toHaveCount(0);
    },
  },
];
