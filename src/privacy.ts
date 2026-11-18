// Atlassian's personal data reporting: the app stores the account ID of each change's actor, so
// each week it reports those IDs and erases the ones Atlassian says are closed. Each part fails
// alone: a refused request or one account's erasure doesn't stop the rest, and whatever didn't
// finish is reported and erased again next week. Forge doesn't retry a failed scheduled run, so
// the run fails at the end, with counts only, to show in the app's invocation errors.
import type { PrivacyDeps, Store } from './integration';

// The reporting API takes at most 90 accounts a request; one at a time keeps within its rate.
const perRequest = 90;

export function createPrivacyReport({ store, privacy }: { store: Store } & PrivacyDeps) {
  return async () => {
    const closed: string[] = [];
    let requests = 0;
    let refused = 0;
    let unread = false;
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await store.accounts(cursor);
      } catch {
        unread = true;
        break;
      }
      for (let start = 0; start < page.accounts.length; start += perRequest) {
        const accounts = page.accounts.slice(start, start + perRequest);
        const reported = new Set(accounts.map((a) => a.accountId));
        requests++;
        try {
          const updates = await privacy.reportPersonalData(
            accounts.map(({ accountId, since }) => ({ accountId, updatedAt: since })),
          );
          // `updated` asks for a fresh copy of personal data the app doesn't keep: only the ID.
          for (const update of updates ?? [])
            if (update.status === 'closed' && reported.has(update.accountId))
              closed.push(update.accountId);
        } catch {
          refused++;
        }
      }
      cursor = page.cursor;
    } while (cursor);
    // Erased after the report, so removing accounts doesn't disturb its cursor.
    let unerased = 0;
    for (const accountId of closed) {
      try {
        if (!(await store.erase(accountId))) unerased++;
      } catch {
        unerased++;
      }
    }
    const problems = [
      unread && 'the stored accounts could not all be read',
      refused && `${refused} of ${requests} report requests failed`,
      unerased && `${unerased} of ${closed.length} closed accounts not yet erased`,
    ].filter(Boolean);
    if (problems.length)
      throw new Error(`Personal data report: ${problems.join('; ')}. Next week's run continues.`);
  };
}
