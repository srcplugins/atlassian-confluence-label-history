// The weekly personal data report and erasure: what one run must do when parts of it fail, and a
// many-week simulation that injects faults, kills runs part-way and lags the index, checking after
// every run that nothing is lost or left unreported, and that every closed account is erased once
// the faults stop.
import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { confluenceContract } from './support/confluence-contract.mjs';
import { memoryEntities } from './support/entities.mjs';
const { createLabelEventHandler, createPrivacyReportHandler } = await import('../src/events.ts');

/**
 * Atlassian's reporting API as `privacy.reportPersonalData` reaches it: at most 90 accounts a
 * request (more is refused), each answered from `statuses`. `refuse(n)` makes request n reject, as
 * the SDK does with the raw response on any status but 200 and 204.
 */
function reportingApi(statuses = {}, { refuse = () => false, stray = [] } = {}) {
  const requests = [];
  return {
    requests,
    privacy: {
      async reportPersonalData(accounts) {
        const n = requests.length;
        requests.push(accounts.map((a) => a.accountId));
        if (accounts.length > 90) throw { status: 400 };
        if (refuse(n)) throw { status: 429 };
        return [
          ...accounts
            .filter((a) => statuses[a.accountId])
            .map((a) => ({ accountId: a.accountId, status: statuses[a.accountId] })),
          // Answers about accounts this request didn't name.
          ...stray.filter((s) => !accounts.some((a) => a.accountId === s.accountId)),
        ];
      },
    },
  };
}

const run = (storage, api) =>
  createPrivacyReportHandler({ kvs: storage.kvs, Sort: storage.Sort, privacy: api.privacy })();
const record = (storage) =>
  createLabelEventHandler({ ...confluenceContract(), kvs: storage.kvs, Sort: storage.Sort });

const time = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
/** Stores `n` changes by `actor` on its own page, and registers the account. */
function seed(storage, actor, n, { since = time(0) } = {}) {
  storage.setRaw(actor, { accountId: actor, since }, 'account');
  const pageId = String(1000 + [...actor].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9e6, 7));
  for (let i = 0; i < n; i++) {
    const change = { pageId, labelId: String(9000 + i), labelName: 'approved' };
    Object.assign(change, { action: 'added', at: time(i), actor });
    storage.setRaw(`${pageId}:${change.labelId}:added:${change.at}`, change);
  }
}
const named = (storage, actor) => storage.values().filter((c) => c.actor === actor).length;
const accountIds = (storage) => storage.values('account').map((a) => a.accountId);

test('accounts are reported 90 a request, in sequence, oldest first', async () => {
  const storage = memoryEntities();
  for (let i = 0; i < 230; i++) seed(storage, `acct-${i}`, 0, { since: time(i) });
  const api = reportingApi();
  await run(storage, api);
  assert.deepEqual(
    api.requests.map((r) => r.length),
    [90, 10, 90, 10, 30],
  );
  assert.equal(api.requests[0][0], 'acct-0');
});

test('only an answer about an account its own request named can close it', async () => {
  const storage = memoryEntities();
  for (let i = 0; i < 100; i++) seed(storage, `acct-${i}`, 0, { since: time(i) });
  seed(storage, 'acct-95', 3, { since: time(95) });
  // Every request also answers that acct-95 is closed; its own request says it isn't.
  const api = reportingApi({}, { stray: [{ accountId: 'acct-95', status: 'closed' }] });
  await run(storage, api);
  assert.equal(named(storage, 'acct-95'), 3);
  assert.ok(accountIds(storage).includes('acct-95'));
});

test('a refused request fails the run, and the closed accounts other requests named are erased', async () => {
  const storage = memoryEntities();
  for (let i = 0; i < 100; i++) seed(storage, `acct-${i}`, 0, { since: time(i) });
  seed(storage, 'acct-95', 3, { since: time(95) });
  seed(storage, 'acct-5', 3, { since: time(5) });
  const statuses = { 'acct-5': 'closed', 'acct-95': 'closed' };
  // The first request (acct-0 to acct-89) is refused; the second names acct-95.
  const api = reportingApi(statuses, { refuse: (n) => n === 0 });
  await assert.rejects(run(storage, api), (error) => {
    assert.match(error.message, /1 of 2 report requests failed/);
    assert.doesNotMatch(error.message, /acct/);
    return true;
  });
  assert.equal(named(storage, 'acct-95'), 0);
  assert.ok(!accountIds(storage).includes('acct-95'));
  assert.equal(named(storage, 'acct-5'), 3);
  // Next week's report sends the refused accounts again.
  await run(storage, reportingApi(statuses));
  assert.equal(named(storage, 'acct-5'), 0);
  assert.ok(!accountIds(storage).includes('acct-5'));
});

test("one closed account's failed erasure doesn't stop the others", async () => {
  const storage = memoryEntities();
  seed(storage, 'closed-1', 3, { since: time(1) });
  seed(storage, 'closed-2', 3, { since: time(2) });
  const api = reportingApi({ 'closed-1': 'closed', 'closed-2': 'closed' });
  let failed = false;
  storage.failWhen(({ call, entity, key }) => {
    if (failed || call !== 'set' || entity !== 'label-change') return false;
    return (failed = String(key).startsWith(
      storage.values().find((c) => c.actor === 'closed-1')?.pageId,
    ));
  });
  await assert.rejects(run(storage, api), /1 of 2 closed accounts not yet erased/);
  storage.failWhen();
  assert.equal(named(storage, 'closed-2'), 0);
  assert.deepEqual(accountIds(storage), ['closed-1']);
  await run(storage, api);
  assert.equal(named(storage, 'closed-1'), 0);
  assert.deepEqual(accountIds(storage), []);
});

test('an account with more changes than one run erases continues next week, after the others', async () => {
  const storage = memoryEntities();
  seed(storage, 'closed-big', 2100, { since: time(1) });
  seed(storage, 'closed-2', 3, { since: time(2) });
  const api = reportingApi({ 'closed-big': 'closed', 'closed-2': 'closed' });
  await assert.rejects(run(storage, api), /1 of 2 closed accounts not yet erased/);
  assert.equal(named(storage, 'closed-2'), 0);
  assert.equal(named(storage, 'closed-big'), 100);
  assert.deepEqual(accountIds(storage), ['closed-big']);
  await run(storage, api);
  assert.equal(named(storage, 'closed-big'), 0);
  assert.deepEqual(accountIds(storage), []);
  assert.equal(storage.values().length, 2103);
});

test('a lagging index rewrites no change twice and finishes the account on a later run', async () => {
  const storage = memoryEntities({ lag: 50 });
  seed(storage, 'closed-1', 30);
  storage.settle();
  const api = reportingApi({ 'closed-1': 'closed' });
  const sets = () => storage.calls.filter((c) => c === 'set').length;
  await assert.rejects(run(storage, api), /not yet erased/);
  assert.equal(sets(), 30);
  // One query for the accounts, one that finds the changes, one that lists only rewritten ones.
  assert.equal(storage.calls.filter((c) => c === 'query').length, 3);
  assert.equal(named(storage, 'closed-1'), 0);
  assert.deepEqual(accountIds(storage), ['closed-1']);
  storage.settle();
  await run(storage, api);
  assert.deepEqual(accountIds(storage), []);
  assert.equal(sets(), 30);
});

test('erasure rewrites only a change that still names the account, as stored now', async () => {
  // The index still lists the change under closed-1; the store already holds it without them.
  const storage = memoryEntities({ lag: 10 });
  seed(storage, 'closed-1', 1);
  storage.settle();
  const [key] = storage.keys();
  storage.setRaw(key, { ...storage.values()[0], actor: 'other-1' });
  storage.setRaw('other-1', { accountId: 'other-1', since: time(1) }, 'account');
  await run(storage, reportingApi({ 'closed-1': 'closed' })).catch(() => undefined);
  assert.equal(named(storage, 'other-1'), 1);
});

test('erasure never brings back a change removed meanwhile', async () => {
  const storage = memoryEntities();
  seed(storage, 'closed-1', 3);
  const [first, second] = storage.keys();
  // Between the erasure's query and its writes, a purge removes one change.
  storage.failWhen(({ call }) => {
    if (call === 'get' && storage.keys().includes(first)) storage.setRaw(first, undefined);
    return false;
  });
  await run(storage, reportingApi({ 'closed-1': 'closed' }));
  assert.equal(storage.keys().includes(first), false);
  assert.equal(storage.keys().length, 2);
  assert.equal(named(storage, 'closed-1'), 0);
  assert.ok(storage.keys().includes(second));
});

test('"unknown" and malformed actors are never stored, registered or reported', async () => {
  const storage = memoryEntities();
  const handler = record(storage);
  const event = (atlassianId, minute) => ({
    eventType: 'avi:confluence:added:label',
    atlassianId,
    eventCreatedDate: `2026-11-02T10:0${minute}:00.000Z`,
    label: { id: '9001', name: 'approved', prefix: 'global' },
    content: { id: '1001', type: 'page', space: { id: 42 } },
  });
  await handler(event('unknown', 1));
  await handler(event('bad id!', 2));
  assert.deepEqual(
    storage.values().map((c) => c.actor),
    [undefined, undefined],
  );
  assert.deepEqual(storage.values('account'), []);
  storage.setRaw('unknown', { accountId: 'unknown', since: time(0) }, 'account');
  const api = reportingApi();
  await run(storage, api);
  assert.deepEqual(api.requests, []);
});

/** A small deterministic random source, so a failing seed can be replayed. */
function random(start) {
  let s = start >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

test('over many weeks of faults, killed runs and a lagging index, erasure is safe and converges', async () => {
  for (let seedNo = 1; seedNo <= 60; seedNo++) {
    const rand = random(seedNo);
    const storage = memoryEntities({ lag: Math.floor(rand() * 40) });
    const statuses = {};
    const accounts = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, i) => `acct-${i}`);
    let biggest = 0;
    for (const [i, id] of accounts.entries()) {
      const n = rand() < 0.15 ? 2000 + Math.floor(rand() * 300) : Math.floor(rand() * 60);
      biggest = Math.max(biggest, n);
      seed(storage, id, n, { since: time(i) });
      const roll = rand();
      if (roll < 0.5) statuses[id] = 'closed';
      else if (roll < 0.7) statuses[id] = 'updated';
    }
    const total = storage.values().length;
    const before = Object.fromEntries(accounts.map((id) => [id, named(storage, id)]));
    const replay = `seed ${seedNo}`;
    /** What must hold after every run, however it ended. */
    const safe = (api) => {
      assert.equal(storage.values().length, total, `${replay}: a change was lost or added`);
      const registered = new Set(accountIds(storage));
      for (const c of storage.values())
        if (c.actor)
          assert.ok(registered.has(c.actor), `${replay}: ${c.actor} stored unregistered`);
      for (const id of accounts)
        if (statuses[id] !== 'closed') {
          assert.ok(registered.has(id), `${replay}: ${id} is open but unregistered`);
          assert.equal(named(storage, id), before[id], `${replay}: ${id} is open but erased`);
        }
      for (const r of api.requests) assert.ok(r.length <= 90 && !r.includes('unknown'), replay);
    };
    // Three weeks with faults: random store failures, refused requests, a run killed part-way.
    for (let week = 0; week < 3; week++) {
      let callNo = 0;
      const killAt = rand() < 0.5 ? Math.floor(rand() * 3000) : Infinity;
      const p = rand() * 0.05;
      storage.failWhen(() => ++callNo >= killAt || rand() < p);
      const api = reportingApi(statuses, { refuse: () => rand() < 0.3 });
      await run(storage, api).catch(() => undefined);
      storage.failWhen();
      safe(api);
    }
    // Then no faults: every closed account is erased within the runs its size needs (a lagging
    // index can halve a run's progress), plus one for the index to catch up, and the last run
    // succeeds.
    const weeks = Math.ceil(biggest / 1000) + 2;
    let last;
    for (let week = 0; week < weeks; week++) {
      const api = reportingApi(statuses);
      last = await run(storage, api).then(
        () => undefined,
        (error) => error,
      );
      safe(api);
      storage.settle();
    }
    assert.equal(last, undefined, `${replay}: the last run failed: ${last?.message}`);
    for (const id of accounts) {
      const closed = statuses[id] === 'closed';
      assert.equal(named(storage, id) === 0 && !accountIds(storage).includes(id), closed, replay);
    }
  }
});
