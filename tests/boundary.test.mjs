import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confluenceContract } from './support/confluence-contract.mjs';
import { assertEnvelopeReader, assertResolversCalled } from './support/contracts.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { readSpace } = await import('../src/client.ts');
const context = { accountId: 'synthetic-user', extension: { space: { id: '42', key: 'TEST' } } };
const space = { id: '42', key: 'TEST', name: 'Synthetic space', type: 'global', status: 'current' };

test('the handler reads the trusted space asUser through the Confluence SDK', async () => {
  const sdk = confluenceContract({ body: space });
  assert.deepEqual(await registerResolvers(sdk).load({ context, payload: {} }), {
    ok: true,
    value: { spaceId: '42', spaceKey: 'TEST', name: 'Synthetic space' },
  });
  assert.deepEqual(sdk.calls, [
    {
      actor: 'asUser',
      path: '/wiki/api/v2/spaces/42',
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
  ]);
  sdk.assertDrained();
});

test('rejects missing identity, Jira context, invalid IDs and caller-selected targets before reads', async () => {
  for (const request of [
    null,
    {},
    { context: { extension: context.extension } },
    { context: { ...context, extension: { project: { id: '42' } } } },
    { context: { ...context, extension: { space: { id: '../42' } } } },
    { context, payload: null },
    { context, payload: { spaceId: '43' } },
  ]) {
    const sdk = confluenceContract();
    assert.equal((await registerResolvers(sdk).load(request)).ok, false);
    assert.equal(sdk.calls.length, 0);
  }
});

// Expected text by outcome, from the spec's States: a refusal is about access and never says to
// try again; throttling and outages do; malformed data is never reported as a refusal.
const refused = /^Confluence refused the request \(HTTP \d+\)\. Check your access to this space\.$/;
test('each failure is reported as its own outcome, once, without raw details', async () => {
  for (const [response, expected] of [
    [{ status: 401 }, refused],
    [{ status: 403 }, refused],
    [{ status: 404 }, refused],
    [{ status: 429 }, /^Confluence is busy \(HTTP 429\)\. Try again in a minute\.$/],
    [{ status: 503 }, /^Confluence is unavailable \(HTTP 503\)\. Try again later\.$/],
    [{ invalidJson: true }, /^Confluence returned unreadable data\.$/],
    [Error('PRIVATE'), /^Confluence connection failed\. Try again\.$/],
    [{ body: null }, /^Confluence returned an invalid space\.$/],
    [{ body: { ...space, id: '43' } }, /^Confluence returned an invalid space\.$/],
    [{ body: { ...space, key: '' } }, /^Confluence returned an invalid space\.$/],
    [{ body: { ...space, name: '' } }, /^Confluence returned an invalid space\.$/],
  ]) {
    const sdk = confluenceContract(response);
    const result = await registerResolvers(sdk).load({ context });
    assert.equal(result.ok, false);
    assert.match(result.error, expected, JSON.stringify(response));
    assert.equal(sdk.calls.length, 1);
    sdk.assertDrained();
  }
});

test("Forge's missing-access error leaves the resolver so Forge can prompt for access", async () => {
  // Shape from @forge/api: NeedsAuthenticationError sets this name (out/api/errors.js).
  const consent = Object.assign(new Error('Authentication Required'), {
    name: 'NEEDS_AUTHENTICATION_ERR',
  });
  const sdk = confluenceContract(consent);
  await assert.rejects(registerResolvers(sdk).load({ context }), (error) => error === consent);
  assert.equal(sdk.calls.length, 1);
});

test('the UI reads only a well-formed space envelope', () => {
  assertEnvelopeReader(
    readSpace,
    { spaceId: '42', spaceKey: 'TEST', name: 'Synthetic space' },
    { spaceKey: ' ' },
  );
  for (const invalid of [{ spaceId: 42 }, { name: '' }, { spaceKey: 'K'.repeat(256) }])
    assert.throws(() =>
      readSpace({
        ok: true,
        value: { spaceId: '42', spaceKey: 'TEST', name: 'Synthetic space', ...invalid },
      }),
    );
});

test('every resolver has a UI caller', () => {
  assertResolversCalled(Object.keys(registerResolvers(confluenceContract())), [
    readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'),
  ]);
});
