import { UserError } from './shared/confluence.mjs';
import { isRecord } from './shared/response.mjs';
import { isId, isLabelName, labelChange, pageDeletion, type LabelChange } from './changes';
import type { Confluence, Store } from './integration';
export { UserError };

// Each page keeps its newest 100 changes plus one, so the history can say older ones were removed.
const shown = 100;
const kept = shown + 1;
// Rovo answers with up to 20 changes.
const answered = 20;

function requirePageId(value: unknown) {
  if (!isId(value)) throw new UserError('Choose a Confluence page.');
  return value;
}

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

  return {
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
     * Confluence, so a repeated or concurrent restore leaves one label. `confirmed` is false when
     * Confluence's answer didn't settle whether the label was added.
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
      return { label, confirmed: (await confluence.addLabel(id, label)) === 'added' };
    },
    /** The Rovo action: a page's latest changes, as the asking user sees them. */
    async changes(payload: unknown) {
      const input = isRecord(payload) ? payload : {};
      if (!isId(input.pageId)) throw new UserError('Provide one page ID.');
      const { page, changes, older } = await history(input.pageId);
      return {
        page,
        changes: changes.slice(0, answered),
        olderChanges: older || changes.length > answered,
      };
    },
  };
}

/** What Confluence's events change in storage, as the app: recording and purging. */
export function createRecording(store: Store) {
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
    /** Removes a page's history once Confluence reports the page purged from the trash. */
    async deleted(event: unknown) {
      const pageId = pageDeletion(event);
      if (!pageId) return 'ignored' as const;
      await store.forget(pageId);
      return 'forgotten' as const;
    },
  };
}
