// Hosted acceptance for Label History for Confluence (`npx forge-test suite <name> [--only a,b]`):
// delivery to the Forge development environment, then the journeys and the Rovo runner in a fixed
// order. A failed delivery step stops it.

/** The guarded Forge CLI wrapper (only development without the owner's opt-in). */
export const forge = ['node', 'config/forge.mjs'];
/** The host product: doctor, prepare and install act on Confluence. */
export const product = 'confluence';
/**
 * What the hosted runs change, so other apps' runs can share the site: this app's installation,
 * the marked fixture space, which Page Copy History also uses (so those two take turns), and the
 * administrator's personal space, where LH-08 writes its marked pages.
 */
export const leaseUses = [
  'app:label-history',
  'confluence:fixture-space',
  'confluence:admin-personal-space',
];

const step = (name, command, env = {}, more = {}) => ({ name, command, env, ...more });
const prerequisite = (name, command) => step(name, command, {}, { prerequisite: true });
const forgeTest = (...args) => ['npx', 'forge-test', ...args];

const doctor = prerequisite('Confluence credentials', forgeTest('doctor'));
const deploy = prerequisite('Deploy to development', [
  ...forge,
  'deploy',
  '-e',
  'development',
  '--non-interactive',
]);
const install = prerequisite('Install or upgrade on the primary site', forgeTest('install'));
const journeys = step('Feature journeys', forgeTest('lane', 'features'));
const rovo = step(
  'Rovo runner',
  ['node', 'tests/hosted/verify-rovo.mjs', 'run'],
  { LH_ROVO_TESTS: '1' },
  { cleanup: ['node', 'tests/hosted/verify-rovo.mjs', 'cleanup'] },
);

export const suites = {
  features: [doctor, deploy, install, journeys],
  full: [doctor, deploy, install, journeys, rovo],
  // Publish deploys its tagged build to development itself, then runs this.
  release: [doctor, install, journeys, rovo],
};
