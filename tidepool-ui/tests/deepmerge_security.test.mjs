import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import merge from 'deepmerge';

const payload = () => JSON.parse('{"__proto__":{"isAdmin":true}}');

function assertSafe(object) {
  assert.equal(Object.getPrototypeOf(object), Object.prototype);
  assert.equal(object.isAdmin, undefined);
  assert.equal(Object.hasOwn(object, '__proto__'), false);
  assert.equal({}.isAdmin, undefined);
}

test('deepmerge rejects prototype poisoning with a null-prototype target', () => {
  assertSafe(merge(Object.create(null), payload()));
});

test('the Svelte build plugin resolves the patched dependency', () => {
  const requireFromPlugin = createRequire(import.meta.resolve('@sveltejs/vite-plugin-svelte'));
  const pluginMerge = requireFromPlugin('deepmerge');
  assert.equal(pluginMerge, merge);
  assertSafe(pluginMerge(Object.create(null), payload()));
});

test('deepmerge rejects prototype poisoning copied from the target', () => {
  assertSafe(merge(payload(), { enabled: true }));
});

for (const placeholder of [null, undefined, false, 0, '']) {
  test(`deepmerge rejects nested poisoning over ${String(placeholder)}`, () => {
    const result = merge(
      { session: placeholder },
      JSON.parse('{"session":{"__proto__":{"isAdmin":true}}}'),
    );
    assertSafe(result);
  });
}

test('deepmerge rejects constructor/prototype keys in both inputs', () => {
  const input = JSON.parse('{"constructor":{"prototype":{"isAdmin":true}},"prototype":{"isAdmin":true}}');
  for (const result of [merge(input, {}), merge(Object.create(null), input)]) {
    assertSafe(result);
    assert.equal(Object.hasOwn(result, 'constructor'), false);
    assert.equal(Object.hasOwn(result, 'prototype'), false);
  }
});

test('deepmerge preserves nested configuration, symbols, functions, and array replacement', () => {
  const symbol = Symbol('option');
  const preprocess = () => 'compiled';
  const defaults = { compilerOptions: { dev: false }, extensions: ['.svelte'] };
  const options = { compilerOptions: { runes: true }, extensions: ['.svx'], preprocess, [symbol]: true };
  const result = merge(defaults, options, { arrayMerge: (_target, source) => source });
  assert.deepEqual(result.compilerOptions, { dev: false, runes: true });
  assert.deepEqual(result.extensions, ['.svx']);
  assert.equal(result.preprocess, preprocess);
  assert.equal(result[symbol], true);
  assert.deepEqual(defaults, { compilerOptions: { dev: false }, extensions: ['.svelte'] });
  assert.deepEqual(merge.all([{ values: [1] }, { values: [2] }]), { values: [1, 2] });
});
