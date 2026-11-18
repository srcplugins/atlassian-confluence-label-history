import Resolver from '@forge/resolver';
import api, { route, getAppContext, privacy } from '@forge/api';
import { kvs, Sort } from '@forge/kvs';
import {
  createLabelEventHandler,
  createPageDeletedHandler,
  createPrivacyReportHandler,
} from './events';
import { registerResolvers } from './resolvers';
import { createRovoAction } from './rovo';

const sdk = { api, route, kvs, Sort };
const appContext = () => {
  const c = getAppContext();
  return { environmentType: c.environmentType, license: c.license };
};
export const handler = registerResolvers({ Resolver, appContext, ...sdk });
// Without an active license Forge skips the event triggers (`appIsLicensed` in the manifest), so a
// lapsed site's history has a gap; the weekly personal data report runs regardless.
export const labelEvent = createLabelEventHandler(sdk);
export const privacyReport = createPrivacyReportHandler({ ...sdk, privacy });
export const pageDeleted = createPageDeletedHandler(sdk);
export const rovoChanges = createRovoAction({ appContext, ...sdk });
