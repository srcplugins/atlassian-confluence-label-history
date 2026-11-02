import { resolveSafely } from './shared/resolver.mjs';
import { createConfluence, type ConfluenceDeps } from './integration';
import { createService, UserError } from './service';

type ResolverRequest = { context?: unknown; payload?: unknown } | null | undefined;

export function registerResolvers({
  Resolver,
  api,
  route,
}: ConfluenceDeps & {
  Resolver: typeof import('@forge/resolver').default;
}) {
  const service = createService({ confluence: createConfluence({ api, route }) });
  const resolver = new Resolver();
  resolver.define('load', (request: ResolverRequest) =>
    resolveSafely(
      () => service.load(request?.context, request?.payload),
      (error) => error instanceof UserError,
    ),
  );
  return resolver.getDefinitions();
}
