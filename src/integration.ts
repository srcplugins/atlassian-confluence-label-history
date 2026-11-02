import type { FetchAPI } from '@forge/api';
import { confluenceReader } from './shared/confluence.mjs';

export interface ConfluenceDeps {
  api: Pick<FetchAPI, 'asUser'>;
  route: typeof import('@forge/api').route;
}

export function createConfluence({ api, route }: ConfluenceDeps) {
  const read = confluenceReader(api);
  return { space: (id: string) => read(route`/wiki/api/v2/spaces/${id}`) };
}
