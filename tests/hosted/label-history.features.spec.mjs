// Hosted journeys for Label History for Confluence on the development installation. The starter's
// space settings page is Confluence's first hosted smoke: it loads in the marked fixture space
// without an error flag, and its resolver reads the space as the signed-in administrator.
import { confluenceSpaceKey } from '@srcplugins/atlassian-forge-test-framework/core';
import {
  test,
  expect,
  spaceSettingsPage,
} from '@srcplugins/atlassian-forge-test-framework/confluence';

test('LH-00 the starter space settings page loads and reads the fixture space', async ({
  page,
  confluence,
}) => {
  const key = confluenceSpaceKey('label-history');
  // The administrator can read the space through the API, independently of the app.
  const space = await confluence(`/wiki/api/v2/spaces?keys=${key}&limit=1`);
  expect(space.status).toBe(200);
  expect(space.body.results.map((s) => s.key)).toEqual([key]);

  await spaceSettingsPage(page, 'label-history', key, 'label-history');
  await expect(page.getByRole('heading', { name: 'Label History for Confluence' })).toBeVisible();
  await expect(page.getByText('Ready.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check space access' }).click();
  await expect(page.getByText(`You can read ${key}.`, { exact: true })).toBeVisible();
});
