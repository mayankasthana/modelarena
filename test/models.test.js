const { test } = require('node:test');
const assert = require('node:assert');

// Catalog/mock logic — test both live-token and no-token shapes.
function freshEnv(hasToken) {
  const save = { ...process.env };
  if (hasToken) process.env.DO_API_TOKEN = 'test-token';
  else delete process.env.DO_API_TOKEN;
  delete require.cache[require.resolve('../lib/models')];
  const m = require('../lib/models');
  process.env = save;
  return m;
}

test('mock mode is active when no DO token is set', () => {
  const { IS_MOCK, providers } = freshEnv(false);
  assert.strictEqual(IS_MOCK, true);
  assert.strictEqual(providers.digitalocean.mock, true);
});

test('live mode when DO token is set, and catalog is curated to confirmed models', () => {
  const { IS_MOCK, activeModels, getModel } = freshEnv(true);
  assert.strictEqual(IS_MOCK, false);
  const ids = activeModels().map((m) => m.id);
  for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash-0731', 'llama-4-maverick', 'kimi-k3', 'router:general']) {
    assert.ok(ids.includes(id), `expected ${id} in catalog`);
  }
  const kimi = getModel('kimi-k3');
  assert.strictEqual(kimi.archetype, 'reasoning');
  assert.strictEqual(kimi.reasoning, true);
  const router = getModel('router:general');
  assert.strictEqual(router.provider, 'digitalocean');
});
