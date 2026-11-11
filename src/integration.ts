import type { FetchAPI } from '@forge/api';
import type { kvs as forgeKvs, Sort as ForgeSort } from '@forge/kvs';
import { UserError, confluenceReader } from './shared/confluence.mjs';
import { isRecord } from './shared/response.mjs';
import { changeKey, isId, type LabelChange } from './changes';

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
  spaceId: string;
  archived: boolean;
}

interface Space {
  id: string;
  name: string;
}

// The v2 batch reads take up to 250 IDs; `limit` defaults to 25, so it is always sent.
const batch = 250;
const unreadable = () => new UserError('Confluence returned unreadable data.');

function visiblePage(value: unknown): VisiblePage {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.title !== 'string' ||
    !isId(String(value.spaceId ?? '')) ||
    typeof value.status !== 'string'
  )
    throw unreadable();
  return {
    id: value.id,
    title: value.title,
    spaceId: String(value.spaceId),
    archived: value.status === 'archived',
  };
}

function space(value: unknown): Space {
  if (!isRecord(value) || !isId(String(value.id ?? '')) || typeof value.name !== 'string')
    throw unreadable();
  return { id: String(value.id), name: value.name };
}

/**
 * The results of one batch read. A response with a next link would mean Confluence left some out,
 * so it is unreadable, never a shorter list.
 */
function results(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.results)) throw unreadable();
  if (isRecord(body._links) && body._links.next) throw unreadable();
  return body.results;
}

// Tests substitute the SDK below this boundary, so these exact requests are verified.
export function createConfluence({ api, route }: ConfluenceDeps) {
  const read = confluenceReader(api);
  /**
   * The listed pages the viewer can read now (current and archived), keyed by ID. Restricted,
   * trashed and deleted pages are absent.
   */
  async function visiblePages(ids: string[]) {
    const visible = new Map<string, VisiblePage>();
    for (let start = 0; start < ids.length; start += batch) {
      const list = ids.slice(start, start + batch).join(',');
      const body: unknown = await read(route`/wiki/api/v2/pages?id=${list}&limit=${batch}`);
      for (const page of results(body).map(visiblePage)) visible.set(page.id, page);
    }
    return visible;
  }
  return {
    visiblePages,
    /** One page as the viewer can read it now, or undefined when Confluence doesn't show it. */
    page: async (id: string) => (await visiblePages([id])).get(id),
    /** The space with this key, if the viewer can see it. */
    async spaceByKey(key: string) {
      const body: unknown = await read(route`/wiki/api/v2/spaces?keys=${key}&limit=1`);
      return results(body).map(space)[0];
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
     * the page. An answer that doesn't settle the outcome is reported as unconfirmed, never retried.
     */
    async addLabel(id: string, name: string) {
      let response;
      try {
        response = await api.asUser().requestConfluence(route`/wiki/rest/api/content/${id}/label`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify([{ prefix: 'global', name }]),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'NEEDS_AUTHENTICATION_ERR') throw error;
        throw unconfirmed();
      }
      if (response.ok) return;
      // Confluence answers 400, not 403, to a viewer who can't edit the page (spec, Verified APIs).
      if ([400, 401, 403, 404].includes(response.status))
        throw new UserError("Confluence didn't let you change this page's labels.");
      if (response.status === 429)
        throw new UserError('Confluence is busy (HTTP 429). Try again in a minute.');
      if (response.status >= 400 && response.status < 500)
        throw new UserError(`Confluence refused the label (HTTP ${response.status}).`);
      throw unconfirmed();
    },
  };
}

const unconfirmed = () =>
  new UserError(
    "Confluence didn't confirm the change. Reopen the history to see whether the label is back.",
  );

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

// Custom Entity Store returns at most 100 entities per query.
export const queryPage = 100;

export function createStore({ kvs, Sort }: StoreDeps) {
  const entity = () => kvs.entity<LabelChange>('label-change');
  /** One store page of a partition of entity `label-change`'s indexes (manifest.yml), newest first. */
  async function query(
    index: 'by-page' | 'by-space',
    partition: string,
    cursor: string | undefined,
    limit: number,
  ) {
    let builder = entity()
      .query()
      .index(index, { partition: [partition] })
      .sort(Sort.DESC)
      .limit(Math.min(limit, queryPage));
    if (cursor) builder = builder.cursor(cursor);
    const page = await stored(() => builder.getMany());
    return { changes: page.results.map((r) => r.value), cursor: page.nextCursor };
  }
  return {
    /** Writes one change by its key; a repeat delivery overwrites itself. */
    put: (change: LabelChange) => stored(() => entity().set(changeKey(change), change)),
    remove: (change: LabelChange) => stored(() => entity().delete(changeKey(change))),
    /** Up to `limit` of a page's changes, newest first. */
    async forPage(pageId: string, limit: number) {
      const changes: LabelChange[] = [];
      let cursor: string | undefined;
      do {
        const page = await query('by-page', pageId, cursor, limit - changes.length);
        changes.push(...page.changes);
        cursor = page.cursor;
      } while (cursor && changes.length < limit);
      return changes;
    },
    /** Removes every change recorded for the page, a store page at a time. */
    async forget(pageId: string) {
      for (;;) {
        const { changes } = await query('by-page', pageId, undefined, queryPage);
        if (!changes.length) return;
        for (const change of changes) await stored(() => entity().delete(changeKey(change)));
      }
    },
    /** One store page of the changes recorded in a space, newest first. */
    forSpace: (spaceId: string, cursor: string | undefined, limit: number) =>
      query('by-space', spaceId, cursor, limit),
  };
}

export type Confluence = ReturnType<typeof createConfluence>;
export type Store = ReturnType<typeof createStore>;
