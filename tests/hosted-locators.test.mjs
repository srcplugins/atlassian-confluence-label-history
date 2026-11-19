import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A hosted assertion that waits for app text the app no longer renders fails only after a deploy
// and minutes of live setup. Every literal text locator in tests/hosted must therefore match the
// app source, unless Confluence, fixture data or a computed value supplies the text.
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const app = files('src')
  .filter((path) => /\.(ts|tsx|mjs)$/.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const notAppText = new Map([
  ["'Synthetic data only.'", "the fixture page's body, written by the framework's pageAdapter"],
  ["'More actions'", "Confluence's page menu"],
  ["'Revert to previous version'", "Confluence's editor menu"],
  ["'Revert to last published version?'", "Confluence's discard-draft dialog"],
  ["'Revert page'", "Confluence's discard-draft dialog"],
]);
const locator =
  /(?:getByText|getByLabel|getByPlaceholder|toContainText|toHaveText|hasText:|name:)\s*\(?\s*('(?:[^'\\]|\\.)*'|\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;

test('hosted text locators match text the app renders', () => {
  const found = files('tests/hosted')
    .filter((path) => path.endsWith('.mjs'))
    .flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(locator)].map((m) => ({ path, literal: m[1] })),
    );
  assert.ok(found.length > 5, 'Locator scan found too few literals');
  const stale = found.filter(({ literal }) => {
    if (notAppText.has(literal)) return false;
    if (literal.startsWith("'")) return !app.includes(literal.slice(1, -1).replaceAll("\\'", "'"));
    const [, body, flags] = literal.match(/^\/(.*)\/([a-z]*)$/);
    return !new RegExp(body, flags.replace('g', '')).test(app);
  });
  assert.deepEqual(
    stale.map(({ path, literal }) => `${path}: ${literal}`),
    [],
    'Update the hosted test, or list the text with its source',
  );
  for (const literal of notAppText.keys())
    assert.ok(
      found.some((entry) => entry.literal === literal),
      `Unused exception ${literal}`,
    );
});

// Playwright's toPass() has no time limit unless given one, so a retry that can't succeed hangs a
// runner instead of failing it. Every toPass in tests/hosted names its own timeout.
test('hosted retries name their own timeout', () => {
  const unbounded = files('tests/hosted')
    .filter((path) => path.endsWith('.mjs'))
    .flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/\.toPass\(([^)]*)\)/g)]
        .filter(([, options]) => !/\btimeout\b/.test(options))
        .map(() => path),
    );
  assert.deepEqual(unbounded, [], 'Pass { timeout } to every toPass()');
});
