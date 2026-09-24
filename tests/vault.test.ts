import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from '../src/background/vault';
import { SettingsSchema } from '../src/core/schema';

function setup(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  const vault = createVault(
    {
      get: async () => structuredClone(data),
      set: async (values) => {
        Object.assign(data, structuredClone(values));
      },
      remove: async (key) => {
        delete data[key];
      },
    },
    Promise.resolve(),
  );
  return { vault, data };
}
const direct = SettingsSchema.parse({});
const gateway = SettingsSchema.parse({
  provider: 'vercel',
  model: 'typesafe-ai/jev',
});

test('Jev Agent key stays separate from TypeSafe and Vercel, including blank saves and deletion', async () => {
  const { vault } = setup();
  const agent = SettingsSchema.parse({
    provider: 'jev-agent',
    model: 'jev-latest',
  });
  await vault.save({ settings: direct, apiKey: 'direct' });
  await vault.save({ settings: gateway, apiKey: 'vercel' });
  await vault.save({ settings: agent });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: agent, apiKey: 'agent' });
  await vault.save({ settings: direct });
  assert.equal((await vault.read()).apiKey, 'direct');
  await vault.save({ settings: agent });
  assert.equal((await vault.read()).apiKey, 'agent');
  await vault.save({ settings: agent, removeKey: true });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: gateway });
  assert.equal((await vault.read()).apiKey, 'vercel');
});

test('new installation defaults to Vercel with no stored key', async () => {
  const { vault } = setup();
  assert.deepEqual(await vault.read(), { settings: gateway, apiKey: '' });
});

test('legacy key is always migrated to TypeSafe, including across repeated reads', async () => {
  for (const initial of [
    { apiKey: 'legacy' },
    {
      apiKey: 'legacy',
      settings: { model: 'jev-latest', reviewThreshold: 0.8 },
    },
  ]) {
    const { vault, data } = setup(initial);
    assert.deepEqual(await vault.read(), {
      settings: direct,
      apiKey: 'legacy',
    });
    assert.deepEqual(await vault.read(), {
      settings: direct,
      apiKey: 'legacy',
    });
    assert.equal(data.apiKey, undefined);
    await vault.save({ settings: gateway });
    assert.equal((await vault.read()).apiKey, '');
  }
});

test('keys stay separate when switching, saving blank, and deleting one destination key', async () => {
  const { vault } = setup();
  await vault.save({ settings: direct, apiKey: 'direct-key' });
  await vault.save({ settings: gateway, apiKey: 'gateway-key' });
  assert.equal((await vault.read()).apiKey, 'gateway-key');
  await vault.save({ settings: direct });
  assert.equal((await vault.read()).apiKey, 'direct-key');
  await vault.save({ settings: direct, removeKey: true });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: gateway });
  assert.equal((await vault.read()).apiKey, 'gateway-key');
});

test('concurrent saves do not drop another channel key', async () => {
  const { vault, data } = setup();
  await Promise.all([
    vault.save({ settings: direct, apiKey: 'direct-key' }),
    vault.save({ settings: gateway, apiKey: 'gateway-key' }),
  ]);
  assert.deepEqual(data.apiKeys, {
    typesafe: 'direct-key',
    vercel: 'gateway-key',
  });
});

test('custom credentials are scoped to normalized full base URL and never reused across channels or endpoints', async () => {
  const { vault } = setup();
  const custom = (baseUrl: string) =>
    SettingsSchema.parse({ provider: 'custom', model: 'model', baseUrl });
  const router = SettingsSchema.parse({
    provider: 'openrouter',
    model: 'example/model',
  });
  await vault.save({ settings: custom('https://one.test/v1/'), apiKey: 'one' });
  await vault.save({ settings: custom('https://two.test/v1') });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: custom('https://one.test/other') });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: router });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: router, apiKey: 'router' });
  await vault.save({ settings: custom('https://one.test/v1') });
  assert.equal((await vault.read()).apiKey, 'one');
  await vault.save({
    settings: custom('https://one.test/v1'),
    removeKey: true,
  });
  assert.equal((await vault.read()).apiKey, '');
  await vault.save({ settings: router });
  assert.equal((await vault.read()).apiKey, 'router');
});
