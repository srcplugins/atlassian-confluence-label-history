import { resolveSafely } from './shared/resolver.mjs';
import { isRecord } from './shared/response.mjs';
import { createConfluence, createStore, type ConfluenceDeps, type StoreDeps } from './integration';
import { requireLicense, type AppLicense } from './license';
import { createService, UserError } from './service';

// Forge passes { context, payload }; anything else fails the context check.
type ResolverRequest = { context?: unknown; payload?: unknown } | null | undefined;

function requireUser(context: unknown) {
  if (!isRecord(context) || typeof context.accountId !== 'string' || !context.accountId.trim())
    throw new UserError('Sign in to Confluence to see label history.');
}

export function registerResolvers({
  Resolver,
  appContext,
  ...deps
}: ConfluenceDeps &
  StoreDeps & {
    Resolver: typeof import('@forge/resolver').default;
    /** This invocation's environment and license, from the Forge runtime. */
    appContext(): AppLicense;
  }) {
  const service = createService({ confluence: createConfluence(deps), store: createStore(deps) });
  const resolver = new Resolver();
  const define = (name: string, operation: (payload: unknown) => Promise<unknown>) =>
    resolver.define(name, (request: ResolverRequest) =>
      resolveSafely(
        () => {
          requireUser(request?.context);
          requireLicense(appContext());
          return operation(request?.payload);
        },
        (error) => error instanceof UserError,
      ),
    );
  // The page is read as the viewer before its history is returned, so the page ID from the
  // byline's context is never trusted on its own.
  define('history', (payload) =>
    service.pageHistory(isRecord(payload) ? payload.pageId : undefined),
  );
  // Restoring rechecks the page as the viewer, and Confluence checks they may edit it.
  define('restore', (payload) => service.restore(payload));
  return resolver.getDefinitions();
}
