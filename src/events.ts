import { InvocationError, InvocationErrorCode } from '@forge/events';
import {
  createConfluence,
  createStore,
  StorageUnavailable,
  type ConfluenceDeps,
  type StoreDeps,
} from './integration';
import { createService } from './service';

// Forge retries an event only when the handler returns this; a thrown error drops the event.
const retryAfterSeconds = 30;

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
        retryAfter: retryAfterSeconds,
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
        retryData: {},
      });
    }
  };
}

/** Trigger for Confluence's label added and removed events. */
export function createLabelEventHandler(deps: ConfluenceDeps & StoreDeps) {
  const service = createService({ confluence: createConfluence(deps), store: createStore(deps) });
  return trigger(service.record);
}

/** Trigger for Confluence's page deleted event, sent when a page is purged from the trash. */
export function createPageDeletedHandler(deps: ConfluenceDeps & StoreDeps) {
  const service = createService({ confluence: createConfluence(deps), store: createStore(deps) });
  return trigger(service.deleted);
}

/** Trigger for Confluence's page moved event. */
export function createPageMovedHandler(deps: ConfluenceDeps & StoreDeps) {
  const service = createService({ confluence: createConfluence(deps), store: createStore(deps) });
  return trigger(service.moved);
}
