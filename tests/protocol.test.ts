import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/core/protocol';

const settings = {
  provider: 'vercel',
  model: 'typesafe-ai/jev',
  reviewThreshold: 0.8,
};

test('opaque long keys are accepted without exposing or changing their contents', () => {
  for (const length of [513, 2048, 8192, 16384]) {
    const apiKey = 'x'.repeat(length);
    const request = parseRequest({
      type: 'settings:save',
      settings,
      apiKey: ` ${apiKey}\n`,
    });
    assert.equal(request.type, 'settings:save');
    if (request.type === 'settings:save') assert.equal(request.apiKey, apiKey);
  }
});

test('credential validation errors identify formatting and never reflect key contents', () => {
  for (const apiKey of [
    'Bearer PRIVATE_SENTINEL',
    'PRIVATE_SENTINEL\r\nInjected: yes',
    'PRIVATE_SENTINEL中文',
    'PRIVATE_SENTINEL ' + 'x'.repeat(17000),
  ]) {
    assert.throws(
      () => parseRequest({ type: 'settings:save', settings, apiKey }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /API Key/);
        assert.ok(!error.message.includes('PRIVATE_SENTINEL'));
        return true;
      },
    );
  }
  assert.throws(
    () =>
      parseRequest({
        type: 'settings:save',
        settings,
        apiKey: 'x'.repeat(16385),
      }),
    /超过 16384/,
  );
});

test('invalid settings report the specific field instead of asking users to reopen the panel', () => {
  for (const [patch, expected] of [
    [{ model: 'wrong model' }, /模型名称无效/],
    [{ provider: 'wrong' }, /接入渠道无效/],
    [{ reviewThreshold: 4 }, /阈值必须/],
    [{ model: 'jev-latest' }, /渠道和模型名称不匹配/],
  ] as const)
    assert.throws(
      () =>
        parseRequest({
          type: 'settings:save',
          settings: { ...settings, ...patch },
        }),
      expected,
    );
});

test('scan messages without a valid tab receive a page-specific error', () => {
  assert.throws(() => parseRequest({ type: 'scan' }), /有效网页标签/);
});
