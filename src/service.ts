import { UserError } from './shared/confluence.mjs';
import { isRecord } from './shared/response.mjs';
import {
  isId,
  isLabelName,
  labelChange,
  pageDeletion,
  pageMove,
  type LabelChange,
} from './changes';
import { queryPage, type Confluence, type Store } from './integration';
export { UserError };

// Each page keeps its newest 100 changes plus one, so the history can say older ones were removed.
const shown = 100;
const kept = shown + 1;
// Rovo answers with up to 20 changes; a space's history reads up to 5 store pages (500 changes).
const answered = 20;
const maxRounds = 5;

function requirePageId(value: unknown) {
  if (!isId(value)) throw new UserError('Choose a Confluence page.');
  return value;
}

const optional = <T>(value: unknown, valid: (v: unknown) => v is T, message: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!valid(value)) throw new UserError(message);
  return value;
};

const summary = ({ at, action, labelName, actor }: LabelChange) => ({
  at,
  action,
  label: labelName,
  actor: actor ?? null,
});

export function createService({ confluence, store }: { confluence: Confluence; store: Store }) {
  async function visiblePage(id: string) {
    const page = await confluence.page(id);
    if (!page)
      throw new UserError(
        "This page isn't available to you. It may be restricted, in the trash or deleted.",
      );
    return page;
  }

  /** A page's changes, newest first, after Confluence confirms the viewer can read the page. */
  async function history(pageId: unknown) {
    const id = requirePageId(pageId);
    const page = await visiblePage(id);
    const changes = await store.forPage(id, kept);
    return {
      page: { id: page.id, title: page.title, archived: page.archived },
      changes: changes.slice(0, shown).map(summary),
      older: changes.length > shown,
    };
  }

  /** A space's latest changes on pages the viewer can read now and that are still in the space. */
  async function spaceHistory(spaceId: string) {
    const rows = [];
    let cursor: string | undefined;
    for (let round = 0; round < maxRounds; round++) {
      const read = await store.forSpace(spaceId, cursor, queryPage);
      const visible = await confluence.visiblePages([
        ...new Set(read.changes.map((c) => c.pageId)),
      ]);
      for (const change of read.changes) {
        const page = visible.get(change.pageId);
        // A page moved out of the space takes its changes with it.
        if (page?.spaceId === spaceId)
          rows.push({
            ...summary(change),
            page: { id: page.id, title: page.title, archived: page.archived },
          });
      }
      cursor = read.cursor;
      if (!cursor || rows.length > answered) break;
    }
    return { changes: rows.slice(0, answered), more: Boolean(cursor) || rows.length > answered };
  }

  return {
    /** Stores one label event's change, or ignores an event version 1 doesn't record. */
    async record(event: unknown) {
      const change = labelChange(event);
      if (!change) return 'ignored' as const;
      await store.put(change);
      // Best effort: a failed trim leaves an extra change, which the page's next change removes.
      try {
        const all = await store.forPage(change.pageId, kept + 25);
        for (const old of all.slice(kept)) await store.remove(old);
      } catch {
        // The change itself is stored, so the event needs no retry.
      }
      return 'recorded' as const;
    },
    /** Moves a page's changes to its new space, so they show in that space's history. */
    async moved(event: unknown) {
      const move = pageMove(event);
      if (!move) return 'ignored' as const;
      for (const change of await store.forPage(move.pageId, kept + 25))
        if (change.spaceId !== move.spaceId) await store.put({ ...change, spaceId: move.spaceId });
      return 'moved' as const;
    },
    history,
    /** The byline's history, with whether the viewer may restore labels on the page. */
    async pageHistory(pageId: unknown) {
      const found = await history(pageId);
      return {
        ...found,
        canEdit: !found.page.archived && (await confluence.canEdit(found.page.id)),
      };
    },
    /**
     * Adds a removed label back to the page as the viewer. Checked first, at the moment of the
     * write: the page is visible and not archived, the label's newest recorded change is its
     * removal, and Confluence doesn't show it on the page. Adding a label is idempotent in
     * Confluence, so a repeated or concurrent restore leaves one label.
     */
    async restore(payload: unknown) {
      const input = isRecord(payload) ? payload : {};
      const id = requirePageId(input.pageId);
      if (!isLabelName(input.label)) throw new UserError('Choose a removed label.');
      const label = input.label;
      const page = await visiblePage(id);
      if (page.archived) throw new UserError("An archived page's labels can't be changed.");
      const newest = (await store.forPage(id, kept)).find((c) => c.labelName === label);
      if (newest?.action !== 'removed')
        throw new UserError(`"${label}" has no removal to undo. Reopen the history to see why.`);
      if (await confluence.hasLabel(id, label))
        throw new UserError(`"${label}" is already on this page.`);
      await confluence.addLabel(id, label);
      return { label };
    },
    /** Removes a page's history once Confluence reports the page purged from the trash. */
    async deleted(event: unknown) {
      const pageId = pageDeletion(event);
      if (!pageId) return 'ignored' as const;
      await store.forget(pageId);
      return 'forgotten' as const;
    },
    /** The Rovo action: a page's or a space's latest changes, as the asking user sees them. */
    async changes(payload: unknown) {
      const input = isRecord(payload) ? payload : {};
      const pageId = optional(input.pageId, isId, 'Provide one page ID.');
      const spaceKey = optional(
        input.spaceKey,
        (v): v is string => typeof v === 'string' && /^~?[A-Za-z0-9_-]{1,255}$/.test(v),
        'Provide one space key.',
      );
      if (Boolean(pageId) === Boolean(spaceKey))
        throw new UserError('Provide either a page ID or a space key.');
      if (pageId) {
        const { page, changes, older } = await history(pageId);
        return {
          page,
          changes: changes.slice(0, answered),
          olderChanges: older || changes.length > answered,
        };
      }
      const space = await confluence.spaceByKey(spaceKey as string);
      if (!space) throw new UserError("That space isn't available to you.");
      const { changes, more } = await spaceHistory(space.id);
      return { space: { key: spaceKey, name: space.name }, changes, olderChanges: more };
    },
  };
}
