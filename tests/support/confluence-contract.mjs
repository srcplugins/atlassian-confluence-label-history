// Shared srcplugins file, synchronized across repositories.
import { forgeContract } from './forge-contract.mjs';

// Reuse queue/route recording while exposing only the Confluence SDK entry point.
export function confluenceContract(...responses) {
  const sdk = forgeContract(...responses);
  const request = sdk.api.asUser().requestJira;
  return { ...sdk, api: { ...sdk.api, asUser: () => ({ requestConfluence: request }) } };
}
