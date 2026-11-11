import Resolver from '@forge/resolver';
import api, { route, getAppContext } from '@forge/api';
import { kvs, Sort } from '@forge/kvs';
import {
  createLabelEventHandler,
  createPageDeletedHandler,
  createPageMovedHandler,
} from './events';
import { registerResolvers } from './resolvers';
import { createRovoAction } from './rovo';

const sdk = { api, route, kvs, Sort };
const appContext = () => {
  const c = getAppContext();
  return { environmentType: c.environmentType, license: c.license };
};
export const handler = registerResolvers({ Resolver, appContext, ...sdk });
// Without an active license Forge skips these triggers (`appIsLicensed` in the manifest), so a lapsed site's history has a gap.
export const labelEvent = createLabelEventHandler(sdk);
export const pageMoved = createPageMovedHandler(sdk);
export const pageDeleted = createPageDeletedHandler(sdk);
export const rovoChanges = createRovoAction({ appContext, ...sdk });
