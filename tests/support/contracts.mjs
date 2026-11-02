// Shared srcplugins file, synchronized across repositories.
import assert from 'node:assert/strict';

/**
 * Contract for a UI reader of resolver envelopes: valid values pass through unchanged, malformed
 * envelopes throw, controlled denials keep their text and non-string errors never surface.
 * @param {(response: unknown) => unknown} read
 * @param {unknown} valid A complete valid value.
 * @param {Record<string, unknown>} invalid Fields that make the value invalid when merged in.
 */
export function assertEnvelopeReader(read, valid, invalid) {
  assert.deepEqual(read({ ok: true, value: valid }), valid);
  for (const input of [
    null,
    [],
    {},
    { ok: 'true', value: valid },
    { ok: true, value: null },
    { ok: true, value: { .../** @type {object} */ (valid), ...invalid } },
  ])
    assert.throws(() => read(input));
  assert.throws(() => read({ ok: false, error: 'Controlled denial.' }), /Controlled denial/);
  assert.throws(() => read({ ok: false, error: { message: 'PRIVATE' } }), /Invalid response/);
}

/**
 * Every registered resolver is called by the UI: a resolver no UI source names is dead code that
 * knip can't see, because Forge wires resolvers by string. A UI that builds names from a template
 * (`settings-${action}`) covers every resolver with that prefix.
 * @param {string[]} resolvers Names from the real `registerResolvers(sdk)`.
 * @param {string[]} uiSources Text of every UI source file that invokes resolvers.
 */
export function assertResolversCalled(resolvers, uiSources) {
  const ui = uiSources.join('\n');
  const prefixes = [...ui.matchAll(/`([\w-]+-)\$\{/g)].map((m) => m[1]);
  const uncalled = resolvers.filter(
    (name) =>
      !new RegExp(`['"\`]${name}['"\`]`).test(ui) &&
      !prefixes.some((prefix) => name.startsWith(prefix)),
  );
  assert.deepEqual(uncalled, [], 'resolvers no UI calls: remove them or add the caller');
}
