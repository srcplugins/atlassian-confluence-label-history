// Readers for resolver responses: the UI renders only values of the expected shape.
import { isRecord, isText, unwrapResponse } from './shared/response.mjs';

export interface PageRef {
  id: string;
  title: string;
  archived: boolean;
}
export interface Change {
  at: string;
  action: 'added' | 'removed';
  label: string;
  actor: string | null;
}

const invalid = () => Error('Invalid response');
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const isTime = (value: unknown): value is string =>
  isText(value, 30) && Number.isFinite(Date.parse(value));

function change(value: unknown): Change {
  if (
    !isRecord(value) ||
    !isTime(value.at) ||
    (value.action !== 'added' && value.action !== 'removed') ||
    !isText(value.label, 255) ||
    !value.label ||
    !(value.actor === null || (isText(value.actor, 128) && value.actor))
  )
    throw invalid();
  return { at: value.at, action: value.action, label: value.label, actor: value.actor };
}

function page(value: unknown): PageRef {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isText(value.title, 1000) ||
    typeof value.archived !== 'boolean'
  )
    throw invalid();
  return { id: value.id, title: value.title, archived: value.archived };
}

/**
 * One page's changes, newest first, whether older ones were removed, and whether the viewer may
 * restore labels on the page.
 */
export function readHistory(response: unknown) {
  const value = unwrapResponse(response);
  if (
    !isRecord(value) ||
    !Array.isArray(value.changes) ||
    typeof value.older !== 'boolean' ||
    typeof value.canEdit !== 'boolean'
  )
    throw invalid();
  return {
    page: page(value.page),
    changes: value.changes.map(change),
    older: value.older,
    canEdit: value.canEdit,
  };
}

/** The label a restore added back. */
export function readRestore(response: unknown) {
  const value = unwrapResponse(response);
  if (!isRecord(value) || !isText(value.label, 255) || !value.label) throw invalid();
  return { label: value.label };
}

/**
 * The rows whose removal can be undone: each label's newest change, when that change removed it.
 * The rest were followed by a later change to the same label.
 */
export function restorable(changes: Change[]) {
  const seen = new Set<string>();
  return changes.map((c) => {
    const newest = !seen.has(c.label);
    seen.add(c.label);
    return newest && c.action === 'removed';
  });
}
