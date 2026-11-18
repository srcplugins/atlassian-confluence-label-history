// What a label event becomes in storage, and the checks every ID and filter value passes first.
import { isRecord } from './shared/response.mjs';

/** One recorded label change on a page: stored in Custom Entity Store entity `label-change`. */
export interface LabelChange {
  pageId: string;
  labelId: string;
  /** A global label's name: only global labels are recorded. */
  labelName: string;
  action: 'added' | 'removed';
  /** `eventCreatedDate` as fixed-width UTC, so it sorts as text. */
  at: string;
  /** The account that changed the label; absent when Confluence didn't name one. */
  actor?: string;
}

// Confluence IDs are 64-bit, kept as decimal strings (REST v2 returns them so).
export const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
// `unknown` stands for no account, and Atlassian's reporting API refuses it.
export const isAccountId = (value: unknown): value is string =>
  typeof value === 'string' && value !== 'unknown' && /^[\w:-]{1,128}$/.test(value);
// Confluence stores label names in lower case, without spaces.
export const isLabelName = (value: unknown): value is string =>
  typeof value === 'string' && /^[^\s]{1,255}$/.test(value);

/** An event ID: a decimal string, or a safe integer. */
function eventId(value: unknown) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  return isId(value) ? value : undefined;
}

function eventTime(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

const actions = new Map<unknown, LabelChange['action']>([
  ['avi:confluence:added:label', 'added'],
  ['avi:confluence:removed:label', 'removed'],
]);

/** A page that isn't a live doc: version 1 records page labels only. */
function plainPage(content: unknown) {
  return (
    isRecord(content) &&
    content.type === 'page' &&
    (content.subType === undefined || content.subType === null)
  );
}

/**
 * The change a label event records, or undefined for one version 1 doesn't record (space and
 * template labels, blog posts, live docs and other content, non-global labels) or can't read.
 * Reads only the fields it stores: never the context token, titles or the page's other labels.
 */
export function labelChange(event: unknown): LabelChange | undefined {
  if (!isRecord(event)) return undefined;
  const action = actions.get(event.eventType);
  const { content, label } = event;
  if (!action || !plainPage(content) || !isRecord(label) || label.prefix !== 'global')
    return undefined;
  const pageId = eventId((content as Record<string, unknown>).id);
  const labelId = eventId(label.id);
  const at = eventTime(event.eventCreatedDate);
  if (!pageId || !labelId || !at || !isLabelName(label.name)) return undefined;
  return {
    pageId,
    labelId,
    labelName: label.name,
    action,
    at,
    ...(isAccountId(event.atlassianId) ? { actor: event.atlassianId } : {}),
  };
}

/**
 * The page a page-deleted event (a purge from the trash) names, or undefined. Any content ID is
 * accepted: content IDs are unique, so one that never had recorded changes removes nothing.
 */
export function pageDeletion(event: unknown) {
  if (!isRecord(event) || event.eventType !== 'avi:confluence:deleted:page') return undefined;
  return isRecord(event.content) ? eventId(event.content.id) : undefined;
}

/**
 * An account whose ID the app stores, reported to Atlassian each week (entity `account`). `since`
 * is when the app first stored it: the age of its copy of the personal data.
 */
export interface Account {
  accountId: string;
  since: string;
}

/** A repeated delivery of the same change writes the same key, so it overwrites itself. */
export const changeKey = (change: LabelChange) =>
  `${change.pageId}:${change.labelId}:${change.action}:${change.at}`;
