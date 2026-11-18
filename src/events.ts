import { InvocationError, InvocationErrorCode } from '@forge/events';
import { createStore, StorageUnavailable, type PrivacyDeps, type StoreDeps } from './integration';
import { createPrivacyReport } from './privacy';
import { createRecording } from './service';
import { isRecord } from './shared/response.mjs';

// Forge retries an event only when the handler returns this; a thrown error drops the event. It
// allows four retries, each at most 900 s later, so the waits grow to ride out a longer outage.
const retryAfterSeconds = [60, 180, 600, 900] as const;

/** The wait before the next delivery: retries already made are in the event's `retryContext`. */
function retryAfter(event: unknown) {
  const context = isRecord(event) && isRecord(event.retryContext) ? event.retryContext : {};
  const count = Number.isInteger(context.retryCount) ? (context.retryCount as number) : 0;
  return retryAfterSeconds[Math.min(Math.max(count, 0), retryAfterSeconds.length - 1)] ?? 900;
}

/**
 * A trigger handler for one service operation. Recording and removal are idempotent, so after a
 * storage failure Forge may deliver the event again.
 */
function trigger(operation: (event: unknown) => Promise<unknown>) {
  // The event's context token is a credential: only the fields a change needs are read.
  return async (event: unknown) => {
    try {
      await operation(event);
    } catch (error) {
      if (!(error instanceof StorageUnavailable)) throw error;
      return new InvocationError({
        retryAfter: retryAfter(event),
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
        retryData: {},
      });
    }
  };
}

/** Trigger for Confluence's label added and removed events. Reads nothing from Confluence. */
export function createLabelEventHandler(deps: StoreDeps) {
  return trigger(createRecording(createStore(deps)).record);
}

/** Trigger for Confluence's page deleted event, sent when a page is purged from the trash. */
export function createPageDeletedHandler(deps: StoreDeps) {
  return trigger(createRecording(createStore(deps)).deleted);
}

/**
 * Weekly scheduled trigger: Atlassian's personal data report. It runs with or without a license,
 * and what didn't finish waits for next week.
 */
export function createPrivacyReportHandler(deps: StoreDeps & PrivacyDeps) {
  const report = createPrivacyReport({ store: createStore(deps), privacy: deps.privacy });
  return async () => {
    await report();
  };
}
