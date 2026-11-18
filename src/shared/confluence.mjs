// Shared srcplugins file, synchronized across repositories.
// @ts-check
// Confluence reads use the invoking user; event payloads never establish viewer access. The
// trusted space context of a space page is in confluence-space.mjs.
export class UserError extends Error {}
/**
 * What a non-2xx response tells the user. A refusal (Confluence answers 404 for content the user
 * can't see) is about access and is never worth retrying; throttling and outages are.
 * @param {number} status
 */
function failureMessage(status) {
  if ([401, 403, 404].includes(status))
    return `Confluence refused the request (HTTP ${status}). Check your Confluence access.`;
  if (status === 429) return 'Confluence is busy (HTTP 429). Try again in a minute.';
  if (status >= 500) return `Confluence is unavailable (HTTP ${status}). Try again later.`;
  return `Confluence request failed (HTTP ${status}).`;
}

/**
 * GET only, with no implicit retries. Never treats denied or malformed data as empty. Forge's
 * missing-access error (`NEEDS_AUTHENTICATION_ERR`) passes through unchanged so Forge can prompt.
 * @param {Pick<import('@forge/api').FetchAPI, 'asUser'>} api
 */
export function confluenceReader(api) {
  /** @param {import('@forge/api').Route} path */
  return async (path) => {
    let response;
    try {
      response = await api
        .asUser()
        .requestConfluence(path, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (error) {
      if (error instanceof Error && error.name === 'NEEDS_AUTHENTICATION_ERR') throw error;
      throw new UserError('Confluence connection failed. Try again.');
    }
    if (!response.ok) throw new UserError(failureMessage(response.status));
    try {
      return await response.json();
    } catch {
      throw new UserError('Confluence returned unreadable data.');
    }
  };
}
