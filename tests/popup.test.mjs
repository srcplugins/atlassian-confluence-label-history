import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  buttons,
  click,
  close,
  count,
  messages,
  open,
  rows,
  settle,
  text,
} from './support/popup.mjs';

// The popup rereads every 2 seconds after a restore, at most 10 times (the spec's bound).
const interval = 2000;
const rechecks = 10;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(async () => {
  await close();
  mock.timers.reset();
});
async function wait(intervals) {
  for (let i = 0; i < intervals; i++) {
    mock.timers.tick(interval);
    await settle();
  }
}

const page = { id: '1001', title: 'Checklist', archived: false };
const change = (minute, action, label = 'approved', actor = 'admin-1') => ({
  at: `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
  action,
  label,
  actor,
});
const history = (changes) => () => ({
  ok: true,
  value: { page, changes, older: false, canEdit: true },
});
const removal = [change(1, 'removed'), change(0, 'added')];
const confirmed = ({ label }) => ({ ok: true, value: { label, confirmed: true } });
async function restore(label = 'approved') {
  // The nth Restore button belongs to the nth row that offers one.
  const offering = rows().filter((r) => r[4] === 'Restore');
  await click(
    'Restore',
    offering.findIndex((r) => r[2] === label),
  );
  await click('Restore label');
}

test('a restore whose change is never recorded is reread 10 times, then says so', async () => {
  await open({ history: history(removal), restore: confirmed });
  assert.deepEqual(rows()[0].slice(1, 4), ['Removed', 'approved', 'admin-1']);
  await restore();
  assert.deepEqual(messages(), [['success', 'Label "approved" restored']]);
  // The confirmed restore shows at once, ahead of what was recorded, and offers no restore itself.
  assert.deepEqual(rows()[0].slice(1), ['Added', 'approved', 'viewer-1', '']);
  await wait(rechecks + 30);
  assert.equal(count('history'), 1 + rechecks);
  assert.equal(rows()[0][0], 'Not recorded yet');
  assert.equal(rows().length, 3);
});

test('a reread that fails to connect still counts toward the 10, and keeps the table', async () => {
  let reads = 0;
  await open({
    history: () => (++reads === 1 ? history(removal)() : Promise.reject(Error('PRIVATE network'))),
    restore: confirmed,
  });
  await restore();
  await wait(rechecks + 5);
  assert.equal(count('history'), 1 + rechecks);
  assert.equal(rows().length, 3);
  assert.equal(text().includes('PRIVATE'), false);
});

test('the recorded addition replaces the pending row and stops the rereads', async () => {
  let changes = removal;
  await open({ history: () => history(changes)(), restore: confirmed });
  await restore();
  changes = [change(5, 'added', 'approved', 'viewer-1'), ...removal];
  await wait(1);
  assert.equal(count('history'), 2);
  assert.deepEqual(
    rows().map((r) => r.slice(1, 4).join(' ')),
    ['Added approved viewer-1', 'Removed approved admin-1', 'Added approved admin-1'],
  );
  await wait(5);
  assert.equal(count('history'), 2);
});

test('a later removal clears the pending row, and its Restore is offered', async () => {
  let changes = removal;
  await open({ history: () => history(changes)(), restore: confirmed });
  await restore();
  changes = [
    change(6, 'removed', 'approved', 'admin-2'),
    change(5, 'added', 'approved', 'viewer-1'),
    ...removal,
  ];
  await wait(1);
  assert.deepEqual(
    rows().map((r) => r.slice(1).join(' ')),
    [
      'Removed approved admin-2 Restore',
      'Added approved viewer-1 ',
      'Removed approved admin-1 ',
      'Added approved admin-1 ',
    ],
  );
  await wait(5);
  assert.equal(count('history'), 2);
});

test('an unconfirmed restore shows as restored once its addition is recorded', async () => {
  let changes = removal;
  await open({
    history: () => history(changes)(),
    restore: () => Promise.reject(Error('lost connection')),
  });
  await restore();
  assert.deepEqual(messages(), [['warning', 'Restoring label "approved" wasn\'t confirmed']]);
  assert.equal(rows().length, 2);
  changes = [change(5, 'added', 'approved', 'viewer-1'), ...removal];
  await wait(1);
  assert.deepEqual(messages(), [['success', 'Label "approved" restored']]);
  assert.equal(rows().length, 3);
});

test('a refusal on a reread shows instead of the old history', async () => {
  let reads = 0;
  const refused =
    "This page isn't available to you. It may be restricted, in the trash or deleted.";
  await open({
    history: () => (++reads === 1 ? history(removal)() : { ok: false, error: refused }),
    restore: confirmed,
  });
  await restore();
  await wait(1);
  assert.deepEqual(messages(), [['error', "Label history couldn't load"]]);
  assert.equal(text().includes(refused), true);
  assert.equal(rows().length, 0);
  await wait(5);
  assert.equal(count('history'), 2);
});

test('every failed load offers Try again, which reads again', async () => {
  let reads = 0;
  await open({
    history: () =>
      ++reads === 1
        ? { ok: false, error: 'Confluence is busy (HTTP 429). Try again in a minute.' }
        : history(removal)(),
  });
  assert.equal(buttons('Try again').length, 1);
  assert.equal(buttons('Try again')[0].props.autoFocus, true);
  await click('Try again');
  assert.equal(count('history'), 2);
  assert.equal(rows().length, 2);
});

test('a double click on Restore label sends one restore', async () => {
  let answer;
  await open({
    history: history(removal),
    restore: (payload) => new Promise((r) => (answer = () => r(confirmed(payload)))),
  });
  await click('Restore');
  const button = buttons('Restore label')[0];
  button.props.onClick();
  button.props.onClick();
  await settle();
  buttons('Restore label')[0].props.onClick();
  answer();
  await settle();
  assert.equal(count('restore'), 1);
});

test('a live doc, a blog post or a missing page reads nothing', async () => {
  for (const content of [
    { id: '1001', type: 'page', subtype: 'live' },
    { id: '1001', type: 'blogpost' },
    {},
  ]) {
    await open({ history: history(removal) }, { content });
    assert.equal(text(), 'Label History records page labels only.');
    assert.equal(count('history'), 0);
  }
});

// Two labels, each removed last, so each offers Restore.
const two = [
  change(3, 'removed', 'reviewed'),
  change(1, 'removed', 'approved'),
  change(0, 'added', 'approved'),
  change(0, 'added', 'reviewed'),
];
const both = [
  change(9, 'added', 'reviewed', 'viewer-1'),
  change(8, 'added', 'approved', 'viewer-1'),
  ...two,
];

test('a reread answered after a second restore settles that restore too', async () => {
  let reads = 0;
  let answer;
  await open({
    history: () => {
      reads++;
      if (reads === 1) return history(two)();
      if (reads === 2) return new Promise((r) => (answer = () => r(history(both)())));
      return history(both)();
    },
    restore: confirmed,
  });
  await restore('approved');
  await wait(1);
  assert.equal(count('history'), 2);
  // Confirmed while the reread is out; that reread already holds both additions.
  await restore('reviewed');
  answer();
  await settle();
  await wait(rechecks + 5);
  assert.deepEqual(
    rows().map((r) => r.slice(1, 4)),
    both.map((c) => [c.action === 'added' ? 'Added' : 'Removed', c.label, c.actor]),
  );
  assert.equal(count('history'), 2);
});

test('an unconfirmed restore recorded by a reread sent before it shows as restored', async () => {
  let reads = 0;
  let answer;
  let restores = 0;
  await open({
    history: () => {
      reads++;
      if (reads === 1) return history(two)();
      if (reads === 2) return new Promise((r) => (answer = () => r(history(both)())));
      return history(both)();
    },
    restore: (p) => (++restores === 1 ? confirmed(p) : Promise.reject(Error('lost'))),
  });
  await restore('approved');
  await wait(1);
  await restore('reviewed');
  assert.equal(messages()[0][0], 'warning');
  answer();
  await settle();
  assert.deepEqual(messages(), [['success', 'Label "reviewed" restored']]);
});

test('a reread the app reports as failed shows its message and Try again, and stops', async () => {
  let reads = 0;
  await open({
    history: () =>
      ++reads === 1
        ? history(removal)()
        : { ok: false, error: 'Confluence is busy (HTTP 429). Try again in a minute.' },
    restore: confirmed,
  });
  await restore();
  await wait(rechecks + 5);
  assert.equal(count('history'), 2);
  assert.equal(rows().length, 0);
  assert.equal(text().includes('Confluence is busy'), true);
  assert.equal(buttons('Try again').length, 1);
});

test('after a failed reread, Try again loads the table and rereads resume for a later restore', async () => {
  let reads = 0;
  let answerRestore;
  let answerLoad;
  await open({
    history: () => {
      reads++;
      if (reads === 1) return history(two)();
      if (reads === 2)
        return { ok: false, error: 'Confluence is busy (HTTP 429). Try again in a minute.' };
      if (reads === 3) return new Promise((r) => (answerLoad = () => r(history(two)())));
      return history(both)();
    },
    restore: (p) =>
      p.label === 'approved'
        ? confirmed(p)
        : new Promise((r) => (answerRestore = () => r(confirmed(p)))),
  });
  await restore('approved');
  await click('Restore', 0);
  buttons('Restore label')[0].props.onClick();
  await settle();
  await wait(1);
  assert.equal(buttons('Try again').length, 1);
  // The second restore is confirmed behind the failure, and the viewer tries again.
  answerRestore();
  await settle();
  await click('Try again');
  await wait(2);
  assert.equal(count('history'), 3);
  answerLoad();
  await settle();
  assert.equal(rows().length > 0, true);
  await wait(rechecks + 5);
  assert.equal(count('history'), 4);
  assert.deepEqual(rows()[0].slice(1, 4), ['Added', 'reviewed', 'viewer-1']);
  assert.equal(rows().length, both.length);
});
