import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { confluenceContract } from './support/confluence-contract.mjs';
import { assertEnvelopeReader, assertResolversCalled } from './support/contracts.mjs';
import { memoryEntities } from './support/entities.mjs';
import { licenseStates } from './support/license-states.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { createLabelEventHandler, createPageDeletedHandler, createPrivacyReportHandler } =
  await import('../src/events.ts');
const { createRovoAction } = await import('../src/rovo.ts');
const { readHistory, readRestore, restorable } = await import('../src/client.ts');

const context = { accountId: 'viewer' };
const development = () => ({ environmentType: 'DEVELOPMENT' });

/**
 * Atlassian's personal data reporting double: answers each reported account from `statuses`
 * (closed or updated; others need no action) and keeps every report.
 */
function privacyDouble(statuses = {}) {
  const reports = [];
  return {
    reports,
    privacy: {
      async reportPersonalData(accounts) {
        reports.push(structuredClone(accounts));
        return accounts
          .filter((a) => statuses[a.accountId])
          .map((a) => ({ accountId: a.accountId, status: statuses[a.accountId] }));
      },
    },
  };
}

/** The Confluence SDK double with the store, as index.ts wires them. */
function app(responses = [], storage = memoryEntities(), privacy = privacyDouble()) {
  const sdk = confluenceContract(...responses);
  const deps = {
    ...sdk,
    kvs: storage.kvs,
    Sort: storage.Sort,
  };
  return {
    sdk,
    storage,
    resolvers: registerResolvers({ ...deps, appContext: development }),
    record: createLabelEventHandler(deps),
    privacyReport: createPrivacyReportHandler({ ...deps, privacy: privacy.privacy }),
    deleted: createPageDeletedHandler(deps),
    rovo: createRovoAction({ ...deps, appContext: development }),
  };
}

// Shapes measured on development (spec, Verified APIs). The app reads none of the space fields.
const labelEvent = (overrides = {}) => ({
  eventType: 'avi:confluence:added:label',
  atlassianId: 'editor-1',
  eventCreatedDate: '2026-11-02T10:00:00.123Z',
  selfGenerated: false,
  label: { id: '9001', name: 'approved', prefix: 'global' },
  content: { id: '1001', type: 'page', status: 'current', space: { id: 42, key: 'TEST' } },
  contextToken: 'PRIVATE-TOKEN',
  ...overrides,
});
const at = (minute) => `2026-11-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
const pageBody = (id, { spaceId = '42', status = 'current', title = `Page ${id}` } = {}) => ({
  id,
  title,
  spaceId,
  status,
});
const pagesRead = (ids, pages) => ({
  expect: { method: 'GET', path: `/wiki/api/v2/pages?id=${ids.join('%2C')}&limit=250` },
  body: { results: pages, _links: {} },
});
test('a label event is stored as one minimal change, and a repeat overwrites itself', async () => {
  const { record, storage, sdk } = app();
  assert.equal(await record(labelEvent()), undefined);
  assert.equal(await record(labelEvent()), undefined);
  assert.deepEqual(storage.values(), [
    {
      pageId: '1001',
      labelId: '9001',
      labelName: 'approved',
      action: 'added',
      at: '2026-11-02T10:00:00.123Z',
      actor: 'editor-1',
    },
  ]);
  assert.deepEqual(storage.keys(), ['1001:9001:added:2026-11-02T10:00:00.123Z']);
  assert.equal(JSON.stringify(storage.values()).includes('PRIVATE'), false);
  // Recording reads nothing from Confluence.
  assert.equal(sdk.calls.length, 0);
});

test('events version 1 does not record are dropped before storage', async () => {
  const content = labelEvent().content;
  for (const event of [
    null,
    labelEvent({ eventType: 'avi:confluence:created:page' }),
    labelEvent({ label: { id: '9001', name: 'mine', prefix: 'my' } }),
    labelEvent({ label: { id: '9001', name: 'team', prefix: 'team' } }),
    labelEvent({ content: { ...content, type: 'blogpost' } }),
    labelEvent({ content: { ...content, subType: 'live' } }),
    labelEvent({ content: undefined, space: { id: 42, key: 'TEST' } }),
    labelEvent({ content: undefined, template: { templateId: '7' } }),
    labelEvent({ eventCreatedDate: 'yesterday' }),
    labelEvent({ eventCreatedDate: undefined }),
    labelEvent({ content: { ...content, id: '../1' } }),
    labelEvent({ content: { ...content, id: 2 ** 60 } }),
    labelEvent({ eventType: 'constructor' }),
    labelEvent({ eventType: 'toString' }),
    labelEvent({ label: { id: '9001', name: 'two words', prefix: 'global' } }),
  ]) {
    const { record, storage } = app();
    await record(event);
    assert.deepEqual(storage.values(), [], JSON.stringify(event));
  }
});

test('an event without an actor is stored with no actor, shown as unknown', async () => {
  const { record, storage } = app();
  await record(labelEvent({ atlassianId: undefined }));
  assert.equal('actor' in storage.values()[0], false);
});

test('a storage failure asks Forge to deliver the event again, waiting longer each time', async () => {
  const { record, storage } = app();
  for (const [retryContext, retryAfter] of [
    [undefined, 60],
    [{ retryCount: 1 }, 180],
    [{ retryCount: 2 }, 600],
    [{ retryCount: 3 }, 900],
    [{ retryCount: 9 }, 900],
    [{ retryCount: 'x' }, 60],
  ]) {
    storage.failNext('set');
    assert.deepEqual(await record(labelEvent({ retryContext })), {
      _retry: true,
      retryOptions: { retryAfter, retryReason: 'FUNCTION_RETRY_REQUEST', retryData: {} },
    });
  }
  assert.deepEqual(storage.values(), []);
  assert.equal(await record(labelEvent()), undefined);
  assert.equal(storage.values().length, 1);
});

test('each page keeps its newest 101 changes, so the history can say older ones were removed', async () => {
  const { record, storage } = app();
  for (let i = 0; i < 130; i++)
    await record(
      labelEvent({
        eventCreatedDate: new Date(Date.UTC(2026, 10, 2, 10, 0, i)).toISOString(),
      }),
    );
  // Another page's changes are untouched.
  await record(labelEvent({ content: { ...labelEvent().content, id: '1002' } }));
  const kept = storage.values().filter((c) => c.pageId === '1001');
  assert.equal(kept.length, 101);
  assert.equal(kept.map((c) => c.at).sort()[0], '2026-11-02T10:00:29.000Z');
  assert.equal(storage.values().filter((c) => c.pageId === '1002').length, 1);
});

test('invalid page IDs and identities are refused before any read', async () => {
  for (const request of [
    null,
    {},
    { context: {}, payload: { pageId: '1001' } },
    { context, payload: {} },
    { context, payload: { pageId: '../1001' } },
    { context, payload: { pageId: 1001 } },
    { context, payload: '1001' },
  ]) {
    const { resolvers, sdk, storage } = app();
    assert.equal((await resolvers.history(request)).ok, false, JSON.stringify(request));
    assert.equal(sdk.calls.length, 0);
    assert.deepEqual(storage.calls, []);
  }
});

test('a batch read Confluence cut short, refused or garbled fails the view, never shortens it', async () => {
  const storage = memoryEntities();
  await app([], storage).record(labelEvent());
  for (const [response, expected] of [
    [
      { body: { results: [pageBody('1001')], _links: { next: '/wiki/api/v2/pages?cursor=x' } } },
      /unreadable/,
    ],
    [
      { status: 403 },
      /^Confluence refused the request \(HTTP 403\)\. Check your Confluence access\.$/,
    ],
    [{ status: 429 }, /^Confluence is busy \(HTTP 429\)\. Try again in a minute\.$/],
    [{ body: { results: [{ id: 1001 }] } }, /unreadable/],
    [Error('PRIVATE'), /^Confluence connection failed\. Try again\.$/],
  ]) {
    const { resolvers } = app([response], storage);
    const result = await resolvers.history({ context, payload: { pageId: '1001' } });
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
  }
});

test('a page history reads the page as the viewer first, then its changes', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  for (let i = 0; i < 103; i++)
    await seed.record(
      labelEvent({ eventCreatedDate: new Date(Date.UTC(2026, 10, 2, 10, 0, i)).toISOString() }),
    );
  const { resolvers, sdk } = app(
    [pagesRead(['1001'], [pageBody('1001', { title: 'Checklist', status: 'archived' })])],
    storage,
  );
  const history = readHistory(await resolvers.history({ context, payload: { pageId: '1001' } }));
  assert.deepEqual(history.page, { id: '1001', title: 'Checklist', archived: true });
  // An archived page's labels can't change, so its edit permission isn't read.
  assert.equal(history.canEdit, false);
  assert.ok(sdk.calls.every((c) => c.actor === 'asUser' && c.method === 'GET'));
  assert.equal(history.changes.length, 100);
  assert.equal(history.changes[0].at, '2026-11-02T10:01:42.000Z');
  assert.equal(history.older, true);
  sdk.assertDrained();

  // A page the viewer can't read shows nothing of its history.
  const denied = app([pagesRead(['1001'], [])], storage);
  const result = await denied.resolvers.history({ context, payload: { pageId: '1001' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't available to you/);
  assert.equal(JSON.stringify(result).includes('approved'), false);
});

test('every entry point checks the license and the signed-in user before any read', async () => {
  const calls = {
    history: (deps, ctx) =>
      registerResolvers(deps).history({ context: ctx, payload: { pageId: '1001' } }),
    restore: (deps, ctx) =>
      registerResolvers(deps).restore({
        context: ctx,
        payload: { pageId: '1001', label: 'approved' },
      }),
    rovo: (deps, ctx) => createRovoAction(deps)({ pageId: '1001' }, ctx ? { principal: ctx } : {}),
  };
  for (const [name, call] of Object.entries(calls)) {
    for (const [state, appContext, licensed] of licenseStates)
      for (const ctx of [context, undefined, { accountId: ' ' }]) {
        const storage = memoryEntities();
        // A licensed, signed-in call gets as far as reading the page, which the viewer can't see.
        const sdk = confluenceContract(pagesRead(['1001'], []));
        const result = await call({ ...sdk, ...storage, appContext: () => appContext }, ctx);
        const allowed = licensed && ctx === context;
        assert.equal(result.ok, false, `${name} ${state} ${JSON.stringify(ctx)}`);
        if (allowed) assert.match(result.error, /isn't available to you/, name);
        else {
          assert.doesNotMatch(result.error, /isn't available to you/, name);
          assert.equal(sdk.calls.length, 0, name);
          assert.deepEqual(storage.calls, [], name);
        }
        if (!allowed && ctx === context) assert.match(result.error, /no active subscription/);
      }
  }
});

test('Forge skips recording while the site is unlicensed; the weekly report always runs', () => {
  const modules = parse(readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8')).modules;
  const functions = modules.function;
  assert.deepEqual(
    modules.trigger.map((t) => [t.key, t.events, t.filter]),
    [
      [
        'label-history-events',
        ['avi:confluence:added:label', 'avi:confluence:removed:label'],
        { appIsLicensed: true },
      ],
      ['label-history-deleted', ['avi:confluence:deleted:page'], { appIsLicensed: true }],
    ],
  );
  assert.deepEqual(modules.scheduledTrigger, [
    { key: 'label-history-privacy', function: 'privacy-report', interval: 'week' },
  ]);
  // Forge's default 55 s isn't enough for a large site's report and erasure.
  assert.equal(functions.find((f) => f.key === 'privacy-report').timeoutSeconds, 900);
});

test('the Rovo action reads one page as the asking user and answers with its latest 20 changes', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  for (let i = 0; i < 25; i++) await seed.record(labelEvent({ eventCreatedDate: at(i) }));
  await seed.record(labelEvent({ content: { ...labelEvent().content, id: '1002' } }));
  const { rovo, sdk } = app(
    [pagesRead(['1001'], [pageBody('1001', { status: 'archived' })])],
    storage,
  );
  const result = await rovo({ pageId: '1001' }, { principal: { accountId: 'asker' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.page, { id: '1001', title: 'Page 1001', archived: true });
  assert.equal(result.value.changes.length, 20);
  assert.deepEqual(result.value.changes[0], {
    at: at(24),
    action: 'added',
    label: 'approved',
    actor: 'editor-1',
  });
  assert.equal(result.value.olderChanges, true);
  assert.match(result.value.note, /untrusted data/);
  assert.ok(sdk.calls.every((c) => c.actor === 'asUser' && c.method === 'GET'));
  sdk.assertDrained();

  // A page the asker can't read is refused, with nothing from its history.
  const hidden = app([pagesRead(['1002'], [])], storage);
  const denied = await hidden.rovo({ pageId: '1002' }, { principal: { accountId: 'asker' } });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /isn't available to you/);

  for (const [payload, ctx] of [
    [{ pageId: '1001' }, {}],
    [{}, { principal: { accountId: 'asker' } }],
    [{ pageId: 1001 }, { principal: { accountId: 'asker' } }],
    [{ pageId: 'x' }, { principal: { accountId: 'asker' } }],
  ]) {
    const refused = app([], storage);
    assert.equal((await refused.rovo(payload, ctx)).ok, false);
    assert.equal(refused.sdk.calls.length, 0);
  }
});

const operationsRead = (id, operations) => ({
  expect: { method: 'GET', path: `/wiki/api/v2/pages/${id}/operations` },
  body: { operations: operations.map((operation) => ({ operation, targetType: 'page' })) },
});
const labelsRead = (id, names, { cursor, next } = {}) => ({
  expect: {
    method: 'GET',
    path: `/wiki/api/v2/pages/${id}/labels?prefix=global&limit=250${cursor ? `&cursor=${cursor}` : ''}`,
  },
  body: {
    results: names.map((name, i) => ({ prefix: 'global', name, id: `${i + 1}` })),
    _links: next ? { next: `/wiki/api/v2/pages/${id}/labels?prefix=global&cursor=${next}` } : {},
  },
});
const labelAdd = (id, response = {}) => ({
  expect: { method: 'POST', path: `/wiki/rest/api/content/${id}/label` },
  body: [],
  ...response,
});
const removed = (minute = 5) =>
  labelEvent({ eventCreatedDate: at(minute), eventType: 'avi:confluence:removed:label' });
const restoreRequest = (payload) => ({
  context,
  payload: { pageId: '1001', label: 'approved', ...payload },
});

test('the byline history says whether the viewer may edit the page, read as the viewer', async () => {
  const storage = memoryEntities();
  await app([], storage).record(labelEvent());
  for (const [operations, expected] of [
    [['read', 'update'], true],
    [['read'], false],
  ]) {
    const { resolvers, sdk } = app(
      [pagesRead(['1001'], [pageBody('1001')]), operationsRead('1001', operations)],
      storage,
    );
    const history = readHistory(await resolvers.history({ context, payload: { pageId: '1001' } }));
    assert.equal(history.canEdit, expected);
    sdk.assertDrained();
  }
});

test('Restore shows on each label whose newest change removed it', () => {
  const change = (action, label) => ({ at: at(1), action, label, actor: null });
  assert.deepEqual(
    restorable([
      change('removed', 'a'),
      change('added', 'a'),
      change('added', 'b'),
      change('removed', 'b'),
      change('removed', 'c'),
      change('removed', 'c'),
    ]),
    [true, false, false, false, true, false],
  );
});

test('a restore rechecks the page and the label, then adds it once as the viewer', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  await seed.record(labelEvent());
  await seed.record(removed());
  const { resolvers, sdk } = app(
    [pagesRead(['1001'], [pageBody('1001')]), labelsRead('1001', ['other']), labelAdd('1001')],
    storage,
  );
  const result = await resolvers.restore(restoreRequest());
  assert.deepEqual(readRestore(result), { label: 'approved', confirmed: true });
  const write = sdk.calls.at(-1);
  assert.equal(write.method, 'POST');
  assert.deepEqual(JSON.parse(write.body), [{ prefix: 'global', name: 'approved' }]);
  assert.ok(sdk.calls.every((c) => c.actor === 'asUser'));
  sdk.assertDrained();
  // The app stores nothing itself: the label event Confluence sends records the change.
  assert.equal(storage.values().length, 2);
});

test('a label shown on a later page of the label list is already on the page', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  await seed.record(labelEvent());
  await seed.record(removed());
  const { resolvers, sdk } = app(
    [
      pagesRead(['1001'], [pageBody('1001')]),
      labelsRead(
        '1001',
        Array.from({ length: 250 }, (_, i) => `l${i}`),
        { next: 'abc' },
      ),
      labelsRead('1001', ['approved'], { cursor: 'abc' }),
    ],
    storage,
  );
  const result = await resolvers.restore(restoreRequest());
  assert.deepEqual(result, { ok: false, error: '"approved" is already on this page.' });
  assert.ok(sdk.calls.every((c) => c.method === 'GET'));
  sdk.assertDrained();
});

test('a restore that no longer applies is refused before any write', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  await seed.record(labelEvent());
  await seed.record(removed(5));
  await seed.record(
    labelEvent({
      eventCreatedDate: at(6),
      label: { id: '9002', name: 'readded', prefix: 'global' },
    }),
  );
  for (const [payload, responses, expected] of [
    [{ label: 'two words' }, [], /^Choose a removed label\.$/],
    [{ pageId: '../1' }, [], /^Choose a Confluence page\.$/],
    [{}, [pagesRead(['1001'], [])], /isn't available to you/],
    [{}, [pagesRead(['1001'], [pageBody('1001', { status: 'archived' })])], /archived page/],
    // Its newest change added it, or it was never recorded.
    [{ label: 'readded' }, [pagesRead(['1001'], [pageBody('1001')])], /no removal to undo/],
    [{ label: 'unknown' }, [pagesRead(['1001'], [pageBody('1001')])], /no removal to undo/],
    [
      {},
      [pagesRead(['1001'], [pageBody('1001')]), labelsRead('1001', ['approved'])],
      /already on this page/,
    ],
  ]) {
    const { resolvers, sdk } = app(responses, storage);
    const result = await resolvers.restore(restoreRequest(payload));
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.match(result.error, expected);
    assert.ok(sdk.calls.every((c) => c.method === 'GET'));
    sdk.assertDrained();
  }
});

test('a refused restore is an error, an unconfirmed one is told apart, and neither is retried', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  await seed.record(labelEvent());
  await seed.record(removed());
  for (const [response, expected] of [
    [{ status: 403 }, /^Confluence didn't let you change this page's labels\.$/],
    [{ status: 400 }, /^Confluence didn't let you change this page's labels\.$/],
    [{ status: 409 }, /^Confluence refused the label \(HTTP 409\)\.$/],
    [{ status: 429 }, /^Confluence is busy/],
    [{ status: 503 }, { label: 'approved', confirmed: false }],
    [Error('PRIVATE'), { label: 'approved', confirmed: false }],
  ]) {
    const write = response instanceof Error ? response : labelAdd('1001', response);
    const { resolvers, sdk } = app(
      [pagesRead(['1001'], [pageBody('1001')]), labelsRead('1001', []), write],
      storage,
    );
    const result = await resolvers.restore(restoreRequest());
    if (expected instanceof RegExp) {
      assert.equal(result.ok, false);
      assert.match(result.error, expected);
    } else assert.deepEqual(readRestore(result), expected);
    assert.equal(sdk.calls.filter((c) => c.method === 'POST').length, 1);
    sdk.assertDrained();
  }
});

test("a page purged from the trash loses its history, and other pages' stay", async () => {
  const { record, deleted, storage, sdk } = app();
  for (let i = 0; i < 130; i++)
    await record(
      labelEvent({ eventCreatedDate: new Date(Date.UTC(2026, 10, 2, 10, 0, i)).toISOString() }),
    );
  await record(labelEvent({ content: { ...labelEvent().content, id: '1002' } }));
  const purge = { eventType: 'avi:confluence:deleted:page', content: { id: '1001', type: 'page' } };
  // Events that name no page, or another event type, remove nothing.
  for (const event of [
    null,
    { ...purge, eventType: 'avi:confluence:trashed:page' },
    { ...purge, content: { id: '../1' } },
  ])
    await deleted(event);
  assert.equal(storage.values().length, 102);
  storage.failNext('delete');
  assert.equal((await deleted(purge))?._retry, true);
  assert.equal(await deleted(purge), undefined);
  assert.deepEqual(
    storage.values().map((c) => c.pageId),
    ['1002'],
  );
  // A repeat delivery finds nothing left.
  assert.equal(await deleted(purge), undefined);
  assert.equal(sdk.calls.length, 0);
});

test('a purge removes records by the keys the store returns, and stops after its round limit', async () => {
  const storage = memoryEntities();
  const change = { pageId: '1001', labelId: '9001', labelName: 'approved', action: 'added' };
  // A key the app wouldn't compute from the change still goes: removal uses the store's keys.
  storage.setRaw('any-key', { ...change, at: at(1) });
  const { deleted } = app([], storage);
  const purge = { eventType: 'avi:confluence:deleted:page', content: { id: '1001', type: 'page' } };
  assert.equal(await deleted(purge), undefined);
  assert.deepEqual(storage.values(), []);
  // More than 20 store pages: Forge is asked to deliver the event again for the rest.
  for (let i = 0; i < 2050; i++)
    storage.setRaw(`k${i}`, {
      ...change,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  assert.equal((await deleted(purge))?._retry, true);
  assert.equal(storage.values().length, 50);
  assert.equal(await deleted(purge), undefined);
  assert.deepEqual(storage.values(), []);
});

test('each stored actor is registered once, with when the app first stored it', async () => {
  const { record, storage } = app();
  const before = new Date().toISOString();
  await record(labelEvent({ eventCreatedDate: at(1) }));
  await record(labelEvent({ eventCreatedDate: at(2), atlassianId: '557058:other-1' }));
  await record(labelEvent({ eventCreatedDate: at(3) }));
  await record(labelEvent({ eventCreatedDate: at(4), atlassianId: undefined }));
  const accounts = storage.values('account');
  assert.deepEqual(
    accounts.map((a) => a.accountId),
    ['editor-1', '557058:other-1'],
  );
  const first = accounts[0].since;
  assert.ok(first >= before && first <= new Date().toISOString());
  // A failed registration, or a failed check for one, stores no change, so the event is
  // delivered again.
  for (const call of ['set', 'get']) {
    const failing = app();
    failing.storage.failNext(call, 'account');
    assert.equal((await failing.record(labelEvent()))?._retry, true, call);
    assert.deepEqual(failing.storage.values(), [], call);
  }
});

test("each week's report names every stored account; a closed one is erased from its changes", async () => {
  const storage = memoryEntities();
  const reporting = privacyDouble({
    'closed-1': 'closed',
    'editor-1': 'updated',
  });
  const { record, privacyReport } = app([], storage, reporting);
  await record(labelEvent({ eventCreatedDate: at(1) }));
  await record(labelEvent({ eventCreatedDate: at(2), atlassianId: 'closed-1' }));
  await record(
    labelEvent({
      eventCreatedDate: at(3),
      atlassianId: 'closed-1',
      content: { ...labelEvent().content, id: '1002' },
    }),
  );
  const since = Object.fromEntries(storage.values('account').map((a) => [a.accountId, a.since]));
  await privacyReport();
  assert.equal(reporting.reports.length, 1);
  assert.deepEqual(
    reporting.reports[0].sort((x, y) => (x.accountId < y.accountId ? -1 : 1)),
    [
      { accountId: 'closed-1', updatedAt: since['closed-1'] },
      { accountId: 'editor-1', updatedAt: since['editor-1'] },
    ],
  );
  // The closed account's changes stay, by an unknown actor; `updated` changes nothing.
  assert.deepEqual(
    storage.values().map((c) => [c.pageId, c.at, c.actor]),
    [
      ['1001', at(1), 'editor-1'],
      ['1001', at(2), undefined],
      ['1002', at(3), undefined],
    ],
  );
  assert.deepEqual(
    storage.values('account').map((a) => a.accountId),
    ['editor-1'],
  );
  // The erased account isn't reported again.
  await privacyReport();
  assert.deepEqual(reporting.reports[1], [{ accountId: 'editor-1', updatedAt: since['editor-1'] }]);
});

test("Forge's missing-access error leaves the resolver so Forge can prompt for access", async () => {
  const consent = Object.assign(new Error('Authentication Required'), {
    name: 'NEEDS_AUTHENTICATION_ERR',
  });
  const { resolvers } = app([consent]);
  await assert.rejects(
    resolvers.history({ context, payload: { pageId: '1001' } }),
    (error) => error === consent,
  );
});

test('the UI reads only well-formed envelopes', () => {
  const page = { id: '1001', title: 'T', archived: false };
  const change = { at: at(1), action: 'added', label: 'approved', actor: 'editor-1' };
  assertEnvelopeReader(
    readHistory,
    { page, changes: [change], older: false, canEdit: true },
    { canEdit: 'yes' },
  );
  assertEnvelopeReader(readRestore, { label: 'approved', confirmed: true }, { label: '' });
  assert.throws(() => readRestore({ ok: true, value: { label: 'approved' } }));
  for (const bad of [{ action: 'renamed' }, { at: 'soon' }, { label: '' }, { actor: '' }])
    assert.throws(() =>
      readHistory({
        ok: true,
        value: { page, changes: [{ ...change, ...bad }], older: false, canEdit: false },
      }),
    );
});

test('every resolver has a UI caller', () => {
  assertResolversCalled(Object.keys(app().resolvers), [
    readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'),
  ]);
});
