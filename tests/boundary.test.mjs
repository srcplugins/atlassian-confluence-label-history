import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confluenceContract } from './support/confluence-contract.mjs';
import { assertEnvelopeReader, assertResolversCalled } from './support/contracts.mjs';
import { memoryEntities } from './support/entities.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { createLabelEventHandler, createPageDeletedHandler, createPageMovedHandler } =
  await import('../src/events.ts');
const { createRovoAction } = await import('../src/rovo.ts');
const { readHistory, readRestore, restorable } = await import('../src/client.ts');

const context = { accountId: 'viewer' };
const development = () => ({ environmentType: 'DEVELOPMENT' });

/** The Confluence SDK double with the store, as index.ts wires them. */
function app(responses = [], storage = memoryEntities()) {
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
    moved: createPageMovedHandler(deps),
    deleted: createPageDeletedHandler(deps),
    rovo: createRovoAction({ ...deps, appContext: development }),
  };
}

// Shapes measured on development (spec, Verified APIs): space IDs arrive as numbers.
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
      spaceId: '42',
      labelId: '9001',
      labelName: 'approved',
      labelPrefix: 'global',
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
    labelEvent({ content: { ...content, space: { id: 2 ** 60 } } }),
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

test('a storage failure asks Forge to deliver the event again', async () => {
  const { record, storage } = app();
  storage.failNext('set');
  assert.deepEqual(await record(labelEvent()), {
    _retry: true,
    retryOptions: { retryAfter: 30, retryReason: 'FUNCTION_RETRY_REQUEST', retryData: {} },
  });
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

test('a moved page takes its changes to the new space', async () => {
  const { record, moved, storage } = app();
  await record(labelEvent());
  await record(labelEvent({ eventCreatedDate: at(5), eventType: 'avi:confluence:removed:label' }));
  await moved({
    eventType: 'avi:confluence:moved:page',
    content: { id: '1001', type: 'page', space: { id: 77, key: 'NEW' } },
    prevContent: { id: '1001', type: 'page', space: { id: 42, key: 'TEST' } },
  });
  assert.deepEqual(
    storage.values().map((c) => c.spaceId),
    ['77', '77'],
  );
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
    [{ status: 403 }, /^Confluence refused the request \(HTTP 403\)\. Check your access/],
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

test('without an active license the screens refuse, and recording continues', async () => {
  const storage = memoryEntities();
  const sdk = confluenceContract();
  const deps = { ...sdk, ...storage, appContext: () => ({ environmentType: 'PRODUCTION' }) };
  const result = await registerResolvers(deps).history({ context, payload: { pageId: '1001' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /no active subscription/);
  await createLabelEventHandler(deps)(labelEvent());
  assert.equal(storage.values().length, 1);
});

test('the Rovo action reads as the asking user and returns only visible changes', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  const page = (id) => ({ ...labelEvent().content, id });
  await seed.record(labelEvent({ eventCreatedDate: at(1) }));
  await seed.record(labelEvent({ eventCreatedDate: at(2), content: page('1002') }));
  await seed.record(labelEvent({ eventCreatedDate: at(3), content: page('1003') }));
  await seed.record(
    labelEvent({
      eventCreatedDate: at(4),
      eventType: 'avi:confluence:removed:label',
      atlassianId: undefined,
      content: page('1004'),
    }),
  );
  // Another space's change is never read.
  await seed.record(
    labelEvent({ eventCreatedDate: at(5), content: { ...page('1005'), space: { id: 77 } } }),
  );
  // 1002 is restricted (absent from the batch read), 1003 has moved to space 77 since, and 1004
  // is archived.
  const { rovo, sdk } = app(
    [
      {
        expect: { path: '/wiki/api/v2/spaces?keys=TEST&limit=1' },
        body: { results: [{ id: '42', name: 'S' }] },
      },
      pagesRead(
        ['1004', '1003', '1002', '1001'],
        [
          pageBody('1004', { status: 'archived' }),
          pageBody('1003', { spaceId: '77' }),
          pageBody('1001'),
        ],
      ),
    ],
    storage,
  );
  const result = await rovo({ spaceKey: 'TEST' }, { principal: { accountId: 'asker' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.space, { key: 'TEST', name: 'S' });
  assert.deepEqual(result.value.changes, [
    {
      at: at(4),
      action: 'removed',
      label: 'approved',
      actor: null,
      page: { id: '1004', title: 'Page 1004', archived: true },
    },
    {
      at: at(1),
      action: 'added',
      label: 'approved',
      actor: 'editor-1',
      page: { id: '1001', title: 'Page 1001', archived: false },
    },
  ]);
  assert.equal(result.value.olderChanges, false);
  assert.match(result.value.note, /untrusted data/);
  assert.ok(sdk.calls.every((c) => c.actor === 'asUser' && c.method === 'GET'));
  sdk.assertDrained();

  const byPage = app([pagesRead(['1001'], [pageBody('1001')])], storage);
  const one = await byPage.rovo({ pageId: '1001' }, { principal: { accountId: 'asker' } });
  assert.deepEqual(one.value.page, { id: '1001', title: 'Page 1001', archived: false });
  assert.deepEqual(
    one.value.changes.map((c) => c.at),
    [at(1)],
  );
  byPage.sdk.assertDrained();

  for (const [payload, ctx] of [
    [{ spaceKey: 'TEST' }, {}],
    [{}, { principal: { accountId: 'asker' } }],
    [{ spaceKey: 'TEST', pageId: '1001' }, { principal: { accountId: 'asker' } }],
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
  assert.deepEqual(readRestore(result), { label: 'approved' });
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

test('a refused or unconfirmed restore is reported, never retried', async () => {
  const storage = memoryEntities();
  const seed = app([], storage);
  await seed.record(labelEvent());
  await seed.record(removed());
  for (const [response, expected] of [
    [{ status: 403 }, /^Confluence didn't let you change this page's labels\.$/],
    [{ status: 400 }, /^Confluence didn't let you change this page's labels\.$/],
    [{ status: 409 }, /^Confluence refused the label \(HTTP 409\)\.$/],
    [{ status: 429 }, /^Confluence is busy/],
    [{ status: 503 }, /^Confluence didn't confirm the change\./],
    [Error('PRIVATE'), /^Confluence didn't confirm the change\./],
  ]) {
    const write = response instanceof Error ? response : labelAdd('1001', response);
    const { resolvers, sdk } = app(
      [pagesRead(['1001'], [pageBody('1001')]), labelsRead('1001', []), write],
      storage,
    );
    const result = await resolvers.restore(restoreRequest());
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
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
  assertEnvelopeReader(readRestore, { label: 'approved' }, { label: '' });
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
