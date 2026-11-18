// How each entry point fails, what it never reads or logs, and the exact limits of what it shows.
import './support/typescript-loader.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { confluenceContract } from './support/confluence-contract.mjs';
import { memoryEntities } from './support/entities.mjs';
const { registerResolvers } = await import('../src/resolvers.ts');
const { createLabelEventHandler, createPageDeletedHandler } = await import('../src/events.ts');
const { createRovoAction } = await import('../src/rovo.ts');

const context = { accountId: 'viewer' };
const asker = { principal: { accountId: 'asker' } };
const development = () => ({ environmentType: 'DEVELOPMENT' });

function app(responses = [], storage = memoryEntities()) {
  const sdk = confluenceContract(...responses);
  const deps = { ...sdk, kvs: storage.kvs, Sort: storage.Sort };
  return {
    sdk,
    storage,
    resolvers: registerResolvers({ ...deps, appContext: development }),
    record: createLabelEventHandler(deps),
    deleted: createPageDeletedHandler(deps),
    rovo: createRovoAction({ ...deps, appContext: development }),
  };
}
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
const removed = (minute) =>
  labelEvent({ eventCreatedDate: at(minute), eventType: 'avi:confluence:removed:label' });
const pageBody = (id) => ({ id, title: `Page ${id}`, spaceId: '42', status: 'current' });
const pagesRead = (id, pages = [pageBody(id)]) => ({
  expect: { method: 'GET', path: `/wiki/api/v2/pages?id=${id}&limit=250` },
  body: { results: pages, _links: {} },
});
const operations = {
  expect: { method: 'GET', path: '/wiki/api/v2/pages/1001/operations' },
  body: { operations: [{ operation: 'update', targetType: 'page' }] },
};
const history = (a) => a.resolvers.history({ context, payload: { pageId: '1001' } });
const restore = (a) =>
  a.resolvers.restore({ context, payload: { pageId: '1001', label: 'approved' } });
/** `n` changes to page 1001, one second apart, stored as the app stores them. */
function seed(storage, n) {
  for (let i = 0; i < n; i++) {
    const change = {
      pageId: '1001',
      labelId: String(9000 + i),
      labelName: 'approved',
      action: 'added',
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    };
    storage.setRaw(`1001:${change.labelId}:added:${change.at}`, change);
  }
}
/** A removal of `approved` on page 1001, recorded after its addition. */
async function removal(storage) {
  const s = app([], storage);
  await s.record(labelEvent());
  await s.record(removed(5));
}

test('an account keeps the time the app first stored it', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 2) });
  try {
    const { record, storage } = app();
    await record(labelEvent({ eventCreatedDate: at(1) }));
    mock.timers.tick(86_400_000);
    await record(labelEvent({ eventCreatedDate: at(2) }));
    assert.deepEqual(storage.values('account'), [
      { accountId: 'editor-1', since: '2026-11-02T00:00:00.000Z' },
    ]);
  } finally {
    mock.timers.reset();
  }
});

test('a storage outage is a failure, never an empty history, and a purge is delivered again', async () => {
  const storage = memoryEntities();
  await app([], storage).record(labelEvent());
  storage.failWhen(({ call }) => call === 'query');
  const expected = { ok: false, error: 'App storage is unavailable. Try again shortly.' };
  assert.deepEqual(await history(app([pagesRead('1001')], storage)), expected);
  assert.deepEqual(
    await app([pagesRead('1001')], storage).rovo({ pageId: '1001' }, asker),
    expected,
  );
  const purge = { eventType: 'avi:confluence:deleted:page', content: { id: '1001' } };
  assert.equal((await app([], storage).deleted(purge))?._retry, true);
  storage.failWhen();
  assert.equal(storage.values().length, 1);
});

test('a labels read that failed or made no sense stops the restore before any write', async () => {
  for (const labels of [
    { status: 503 },
    { status: 404 },
    { body: { results: 'x' } },
    { invalidJson: true },
    Error('PRIVATE'),
    { body: { results: [{ prefix: 'global', name: 'other' }], _links: { next: 7 } } },
  ]) {
    const storage = memoryEntities();
    await removal(storage);
    const a = app([pagesRead('1001'), labels], storage);
    const result = await restore(a);
    assert.equal(result.ok, false, JSON.stringify(labels));
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.ok(a.sdk.calls.every((c) => c.method === 'GET'));
  }
});

test('a failed or garbled permission read fails the view', async () => {
  for (const response of [{ status: 503 }, { body: {} }, { body: { operations: 'x' } }]) {
    const storage = memoryEntities();
    await app([], storage).record(labelEvent());
    const read = { ...response, expect: operations.expect };
    const result = await history(app([pagesRead('1001'), read], storage));
    assert.equal(result.ok, false, JSON.stringify(response));
  }
});

test('a label removed and then added again has no removal to undo', async () => {
  const storage = memoryEntities();
  await removal(storage);
  await app([], storage).record(labelEvent({ eventCreatedDate: at(6) }));
  const a = app([pagesRead('1001')], storage);
  const result = await restore(a);
  assert.match(result.error, /no removal to undo/);
  a.sdk.assertDrained();
  assert.equal(a.sdk.calls.length, 1);
});

test('the byline shows 100 changes and says when older ones went; Rovo answers 20', async () => {
  for (const [stored, shown, older] of [
    [99, 99, false],
    [100, 100, false],
    [101, 100, true],
  ]) {
    const storage = memoryEntities();
    seed(storage, stored);
    const { value } = await history(app([pagesRead('1001'), operations], storage));
    assert.deepEqual([value.changes.length, value.older], [shown, older], `${stored}`);
  }
  for (const [stored, answered, older] of [
    [19, 19, false],
    [20, 20, false],
    [21, 20, true],
  ]) {
    const storage = memoryEntities();
    seed(storage, stored);
    const { value } = await app([pagesRead('1001')], storage).rovo({ pageId: '1001' }, asker);
    assert.deepEqual([value.changes.length, value.olderChanges], [answered, older], `${stored}`);
  }
});

test('a page read answering with another page shows nothing', async () => {
  const storage = memoryEntities();
  await app([], storage).record(labelEvent());
  const result = await history(app([pagesRead('1001', [pageBody('1002')])], storage));
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't available to you/);
});

test("Forge's missing-access error on the write leaves the resolver, too", async () => {
  const consent = Object.assign(new Error('Authentication Required'), {
    name: 'NEEDS_AUTHENTICATION_ERR',
  });
  const storage = memoryEntities();
  await removal(storage);
  const labels = {
    expect: { method: 'GET', path: '/wiki/api/v2/pages/1001/labels?prefix=global&limit=250' },
    body: { results: [], _links: {} },
  };
  await assert.rejects(
    restore(app([pagesRead('1001'), labels, consent], storage)),
    (e) => e === consent,
  );
});

test('the triggers read only the fields they store, never the context token', async () => {
  const seen = new Set();
  const traced = (value, path) =>
    value === null || typeof value !== 'object'
      ? value
      : new Proxy(value, {
          get(target, key) {
            const p = path ? `${path}.${String(key)}` : String(key);
            if (typeof key === 'string') seen.add(p);
            return traced(target[key], p);
          },
        });
  const { record, deleted } = app();
  await record(
    traced(
      labelEvent({
        content: {
          id: '1001',
          type: 'page',
          status: 'current',
          title: 'PRIVATE',
          labels: [{ name: 'PRIVATE' }],
          version: { by: {} },
          space: { id: 42, key: 'TEST' },
        },
        permissions: {},
        context: {},
      }),
      '',
    ),
  );
  await deleted(
    traced(
      {
        eventType: 'avi:confluence:deleted:page',
        content: { id: '1001', title: 'PRIVATE' },
        contextToken: 'PRIVATE',
      },
      '',
    ),
  );
  const allowed = [
    'eventType',
    'atlassianId',
    'eventCreatedDate',
    'label',
    'label.id',
    'label.name',
    'label.prefix',
    'content',
    'content.id',
    'content.type',
    'content.subType',
  ];
  assert.deepEqual(
    [...seen].filter((p) => !allowed.includes(p)),
    [],
  );
});

test('nothing about a change or a refused page is logged', async () => {
  const lines = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
    mock.method(console, m, (...a) => lines.push(a.join(' '))),
  );
  try {
    const storage = memoryEntities();
    await app([], storage).record(labelEvent());
    await history(app([pagesRead('1001', [])], storage));
    await app([pagesRead('1001', [])], storage).rovo({ pageId: '1001' }, asker);
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
  assert.deepEqual(lines, []);
});

test('an unexpected failure reaches the user as the fixed fallback, without its text', async () => {
  const broken = {
    ...memoryEntities(),
    kvs: {
      entity: () => {
        throw Error('PRIVATE internals');
      },
    },
  };
  const lines = [];
  const spy = mock.method(console, 'error', (...a) => lines.push(a.join(' ')));
  try {
    for (const result of [
      await history(app([pagesRead('1001')], broken)),
      await app([pagesRead('1001')], broken).rovo({ pageId: '1001' }, asker),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
  } finally {
    spy.mock.restore();
  }
  assert.equal(lines.join('\n').includes('PRIVATE'), false);
});
