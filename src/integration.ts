import type { FetchAPI } from '@forge/api';
import type { kvs as forgeKvs, Sort as ForgeSort } from '@forge/kvs';
import type { privacy as forgePrivacy } from '@forge/api';
import { UserError, confluenceReader } from './shared/confluence.mjs';
import { isRecord } from './shared/response.mjs';
import { changeKey, isAccountId, isId, type Account, type LabelChange } from './changes';

export interface ConfluenceDeps {
  api: Pick<FetchAPI, 'asUser'>;
  route: typeof import('@forge/api').route;
}

export interface StoreDeps {
  kvs: Pick<typeof forgeKvs, 'entity'>;
  Sort: typeof ForgeSort;
}

/** A page as the viewer can read it now. */
export interface VisiblePage {
  id: string;
  title: string;
  archived: boolean;
}

// The v2 list reads return up to 250 results; `limit` defaults to 25, so it is always sent.
const batch = 250;
const unreadable = () => new UserError('Confluence returned unreadable data.');
// The page statuses the app shows history for; the page list returns only these by default.
const shownStatuses = new Set(['current', 'archived']);

// Tests substitute the SDK below this boundary, so these exact requests are verified.
export function createConfluence({ api, route }: ConfluenceDeps) {
  const read = confluenceReader(api);
  return {
    /**
     * The page as the viewer can read it now (current or archived), or undefined when Confluence
     * doesn't show it: restricted, trashed and deleted pages are absent. A list read with a next
     * link would mean Confluence left some out, so it is unreadable, never absent.
     */
    async page(id: string): Promise<VisiblePage | undefined> {
      const body: unknown = await read(route`/wiki/api/v2/pages?id=${id}&limit=${batch}`);
      if (!isRecord(body) || !Array.isArray(body.results)) throw unreadable();
      if (isRecord(body._links) && body._links.next) throw unreadable();
      for (const value of body.results)
        if (
          !isRecord(value) ||
          !isId(value.id) ||
          typeof value.title !== 'string' ||
          typeof value.status !== 'string'
        )
          throw unreadable();
      const page = body.results.find((p) => p.id === id);
      if (!page || !shownStatuses.has(page.status)) return undefined;
      return { id, title: page.title, archived: page.status === 'archived' };
    },
    /** Whether Confluence lets the viewer edit the page, and so its labels. */
    async canEdit(id: string) {
      const body: unknown = await read(route`/wiki/api/v2/pages/${id}/operations`);
      if (!isRecord(body) || !Array.isArray(body.operations)) throw unreadable();
      return body.operations.some(
        (o) => isRecord(o) && o.operation === 'update' && o.targetType === 'page',
      );
    },
    /**
     * Whether the page has this global label now, reading every page of its labels. (Confluence
     * answers the v1 label list with HTTP 410 for apps.)
     */
    async hasLabel(id: string, name: string) {
      for (let cursor: string | undefined; ;) {
        const body: unknown = await read(
          cursor
            ? route`/wiki/api/v2/pages/${id}/labels?prefix=global&limit=${batch}&cursor=${cursor}`
            : route`/wiki/api/v2/pages/${id}/labels?prefix=global&limit=${batch}`,
        );
        if (!isRecord(body) || !Array.isArray(body.results)) throw unreadable();
        if (body.results.some((l) => isRecord(l) && l.prefix === 'global' && l.name === name))
          return true;
        const next = isRecord(body._links) ? body._links.next : undefined;
        if (!next) return false;
        cursor =
          typeof next === 'string'
            ? (new URL(next, 'https://confluence.invalid').searchParams.get('cursor') ?? undefined)
            : undefined;
        if (!cursor || !body.results.length) throw unreadable();
      }
    },
    /**
     * Adds a global label to the page as the viewer, once. Confluence checks the viewer may edit
     * the page. A refusal throws; an answer that doesn't settle the outcome returns `unconfirmed`,
     * never retried.
     */
    async addLabel(id: string, name: string): Promise<'added' | 'unconfirmed'> {
      let response;
      try {
        response = await api.asUser().requestConfluence(route`/wiki/rest/api/content/${id}/label`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify([{ prefix: 'global', name }]),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'NEEDS_AUTHENTICATION_ERR') throw error;
        return 'unconfirmed';
      }
      if (response.ok) return 'added';
      // Confluence answers 400, not 403, to a viewer who can't edit the page (spec, Verified APIs).
      if ([400, 401, 403, 404].includes(response.status))
        throw new UserError("Confluence didn't let you change this page's labels.");
      if (response.status === 429)
        throw new UserError('Confluence is busy (HTTP 429). Try again in a minute.');
      if (response.status >= 400 && response.status < 500)
        throw new UserError(`Confluence refused the label (HTTP ${response.status}).`);
      return 'unconfirmed';
    },
  };
}

/** App storage failed; the trigger asks Forge to deliver the event again. */
export class StorageUnavailable extends UserError {
  constructor() {
    super('App storage is unavailable. Try again shortly.');
  }
}

async function stored<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch {
    throw new StorageUnavailable();
  }
}

// Custom Entity Store returns at most 100 entities per query, and a cursor must be reused with the
// query's original parameters, so every query asks for a full page.
const queryPage = 100;
// A purge or an erasure removes at most this many store pages before asking to run again.
const rounds = 20;

export function createStore({ kvs, Sort }: StoreDeps) {
  const entity = () => kvs.entity<LabelChange>('label-change');
  const accounts = () => kvs.entity<Account>('account');
  /** One store page of a partition of entity `label-change`'s indexes (manifest.yml), newest first. */
  async function query(index: 'by-page' | 'by-actor', partition: string, cursor?: string) {
    let builder = entity()
      .query()
      .index(index, { partition: [partition] })
      .sort(Sort.DESC)
      .limit(queryPage);
    if (cursor) builder = builder.cursor(cursor);
    const page = await stored(() => builder.getMany());
    return {
      changes: page.results.map((r) => r.value),
      keys: page.results.map((r) => r.key),
      cursor: page.nextCursor,
    };
  }
  return {
    /**
     * Writes one change by its key; a repeat delivery overwrites itself. Its actor is added to the
     * accounts reported to Atlassian first, so no stored account ID goes unreported.
     */
    async put(change: LabelChange) {
      const { actor } = change;
      if (actor && !(await stored(() => accounts().get(actor))))
        await stored(() =>
          accounts().set(actor, { accountId: actor, since: new Date().toISOString() }),
        );
      await stored(() => entity().set(changeKey(change), change));
    },
    remove: (change: LabelChange) => stored(() => entity().delete(changeKey(change))),
    /** Up to `limit` of a page's changes, newest first. */
    async forPage(pageId: string, limit: number) {
      const changes: LabelChange[] = [];
      let cursor: string | undefined;
      do {
        const page = await query('by-page', pageId, cursor);
        changes.push(...page.changes);
        cursor = page.cursor;
      } while (cursor && changes.length < limit);
      return changes.slice(0, limit);
    },
    /**
     * Removes every change recorded for the page, a store page at a time, by the keys the store
     * returns. A page with more left than the round limit asks Forge to deliver the event again.
     */
    async forget(pageId: string) {
      for (let round = 0; round < rounds; round++) {
        const { keys } = await query('by-page', pageId);
        if (!keys.length) return;
        for (const key of keys) await stored(() => entity().delete(key));
      }
      throw new StorageUnavailable();
    },
    /** One store page of the stored accounts, oldest first. */
    async accounts(cursor?: string) {
      let builder = accounts().query().index('by-since').sort(Sort.ASC).limit(queryPage);
      if (cursor) builder = builder.cursor(cursor);
      const page = await stored(() => builder.getMany());
      return {
        accounts: page.results.map((r) => r.value).filter((a) => isAccountId(a.accountId)),
        cursor: page.nextCursor,
      };
    },
    /**
     * Removes a closed account's ID from every change that names it, then the account itself, and
     * says whether it finished. Its changes stay, by an unknown actor. Each change is reread before
     * it is rewritten, so one removed or changed meanwhile is left alone, and rewritten once: the
     * index can still list a rewritten change for a while, and when it lists nothing new, or the
     * round limit is reached, the account stays for next week's run to finish.
     */
    async erase(accountId: string) {
      const rewritten = new Set<string>();
      for (let round = 0; round < rounds; round++) {
        const { keys } = await query('by-actor', accountId);
        if (!keys.length) {
          await stored(() => accounts().delete(accountId));
          return true;
        }
        const fresh = keys.filter((key) => !rewritten.has(key));
        if (!fresh.length) return false;
        for (const key of fresh) {
          rewritten.add(key);
          const change = await stored(() => entity().get(key));
          if (change?.actor !== accountId) continue;
          delete change.actor;
          await stored(() => entity().set(key, change));
        }
      }
      return false;
    },
  };
}

export interface PrivacyDeps {
  privacy: Pick<typeof forgePrivacy, 'reportPersonalData'>;
}

export type Confluence = ReturnType<typeof createConfluence>;
export type Store = ReturnType<typeof createStore>;
