import {
  UserError,
  spaceContext,
  requireEmptyPayload,
  requireSpace,
} from './shared/confluence.mjs';
export { UserError };

interface Confluence {
  space(id: string): Promise<unknown>;
}

export function createService({ confluence }: { confluence: Confluence }) {
  return {
    async load(context: unknown, payload?: unknown) {
      const { spaceId } = spaceContext(context);
      requireEmptyPayload(payload);
      const space = requireSpace(await confluence.space(spaceId), spaceId);
      return { spaceId: space.id, spaceKey: space.key, name: space.name };
    },
  };
}
