// Label History's surfaces in Confluence, driven as a person would, and the app's resolver answers
// observed on the wire. A resolver answer is what the app shows; the journeys still prove every
// Confluence fact with their own independent reads.
import {
  expect,
  confluenceTarget,
  installation,
  pagePath,
} from '@srcplugins/atlassian-forge-test-framework/confluence';

const app = 'label-history';

// The Forge invocation request for one resolver function of this installation, or null.
function invocation(request) {
  try {
    const input = request.postDataJSON()?.variables?.input;
    const t = installation(app);
    if (
      typeof input?.payload?.call?.functionKey !== 'string' ||
      input.payload.context?.environmentId !== t.environmentId ||
      !String(input.extensionId ?? '').includes(t.appId)
    )
      return null;
    return input;
  } catch {
    return null;
  }
}

/**
 * Runs `exercise` and returns the envelope (`{ ok, value }` or `{ ok, error }`) of the first
 * `action` resolver answer it causes, successful or not.
 */
async function answer(page, action, exercise, { timeout = 45_000 } = {}) {
  /** @type {any} The envelope, set by the response predicate. */
  let result;
  const response = page.waitForResponse(
    async (candidate) => {
      if (invocation(candidate.request())?.payload.call.functionKey !== action) return false;
      try {
        const body = (await candidate.json())?.data?.invokeExtension?.response?.body;
        if (typeof body?.ok !== 'boolean') return false;
        result = body;
        return true;
      } catch {
        return false;
      }
    },
    { timeout },
  );
  await Promise.all([response, exercise()]);
  return result;
}

/**
 * Sends the page's next `history` request for `pageId` instead of the page it asked for: the same
 * signed-in call a direct request for that page's history would make. Returns a function that
 * stops rewriting.
 */
export async function redirectHistory(page, pageId) {
  const handler = async (route) => {
    const request = route.request();
    if (invocation(request)?.payload.call.functionKey !== 'history') return route.fallback();
    const data = request.postDataJSON();
    data.variables.input.payload.call.payload = {
      ...data.variables.input.payload.call.payload,
      pageId,
    };
    await route.continue({ postData: JSON.stringify(data) });
  };
  await page.route('**/gateway/api/graphql**', handler);
  return () => page.unroute('**/gateway/api/graphql**', handler);
}

/** The page in Confluence, then its Label History byline item. Resolves with the answer. */
export async function bylineHistory(page, spaceKey, pageId) {
  await page.goto(`${confluenceTarget().site}${pagePath(spaceKey, pageId)}`, {
    waitUntil: 'domcontentloaded',
  });
  const item = page.getByRole('button', { name: /^Label History/ }).first();
  return answer(page, 'history', () => item.click({ timeout: 45_000 }));
}

/**
 * In an open byline history, chooses Restore on `label`'s row, then confirms. Resolves with the
 * restore answer.
 */
export async function restoreLabel(page, label) {
  await changeRows(page)
    .filter({ hasText: label })
    .first()
    .getByRole('button', { name: 'Restore' })
    .click();
  const confirm = page.getByRole('button', { name: 'Add label back' });
  return answer(page, 'restore', () => confirm.click());
}

/** The label changes table's body rows. */
export const changeRows = (page) =>
  page.getByRole('table', { name: 'Label changes' }).locator('tbody tr');

/**
 * Waits until the page's byline history passes `check(value)`, reopening it between attempts:
 * Confluence delivers label events a few seconds after the change. Resolves with that history.
 */
export async function historyWhen(page, spaceKey, pageId, check, { timeout = 120_000 } = {}) {
  /** @type {any} The last observed history, set inside the retried check. */
  let history;
  await expect(async () => {
    const result = await bylineHistory(page, spaceKey, pageId);
    if (!result?.ok) throw Error(`Resolver history failed: ${result?.error ?? 'no answer'}`);
    history = result.value;
    check(history);
  }).toPass({ timeout, intervals: [3000, 5000, 10_000] });
  return history;
}
