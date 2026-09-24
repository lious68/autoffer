import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Controller,
  type PageScan,
  type Vault,
} from '../src/background/controller';
import {
  SettingsSchema,
  type Snapshot,
  type Suggestion,
} from '../src/core/schema';
import type { AnswerProvider } from '../src/providers/types';
import { demoScan } from './helpers';

function setup(providerOverride?: AnswerProvider) {
  let page: PageScan = {
    scan: demoScan(),
    documentId: 'doc-1',
    page: 'http://localhost/demo.html',
  };
  let calls = 0;
  const vault: Vault = {
    read: async () => ({
      apiKey: 'private-key',
      settings: SettingsSchema.parse({}),
    }),
    save: async () => undefined,
  };
  const provider: AnswerProvider = providerOverride ?? {
    id: 'mock',
    suggest: async (question) => {
      calls++;
      return {
        questionId: question.id,
        provider: 'mock',
        model: 'mock',
        selectedIds: ['o2'],
        probabilities: { o1: 0.1, o2: 0.8, o3: 0.1 },
        confidence: 0.9,
        probabilityKind: 'distribution',
        needsReview: false,
        notices: [],
      };
    },
  };
  const controller = new Controller({
    scan: async () => structuredClone(page),
    vault,
    provider,
  });
  return {
    controller,
    calls: () => calls,
    change: (update: Partial<PageScan>) => {
      page = { ...page, ...update };
    },
  };
}
async function scan(controller: Controller) {
  return (await controller.handle({ type: 'scan', tabId: 1 })) as Snapshot;
}
function request(snapshot: Snapshot) {
  return {
    type: 'suggest',
    tabId: 1,
    scanId: snapshot.scanId,
    questionId: snapshot.questions[0]!.id,
  };
}

test('UI settings reveal key presence, never the key', async () => {
  const { controller } = setup();
  assert.deepEqual(await controller.handle({ type: 'settings:get' }), {
    ...SettingsSchema.parse({}),
    hasKey: true,
  });
});

test('requires a fresh scan and validates the current document before API call', async () => {
  const { controller, change, calls } = setup();
  const snapshot = await scan(controller);
  change({ documentId: 'doc-2' });
  await assert.rejects(
    controller.handle(request(snapshot)),
    /页面或题目已变化/,
  );
  assert.equal(calls(), 0);
  await assert.rejects(controller.handle(request(snapshot)), /失效/);
});

test('question DOM changes without navigation also invalidate a snapshot', async () => {
  const { controller, change, calls } = setup();
  const snapshot = await scan(controller);
  const changed = demoScan();
  changed.questions[0]!.stem = '动态更换题目';
  change({ scan: changed });
  await assert.rejects(
    controller.handle(request(snapshot)),
    /页面或题目已变化/,
  );
  assert.equal(calls(), 0);
});

test('returns a suggestion after before/after page checks', async () => {
  const { controller, calls } = setup();
  const snapshot = await scan(controller);
  const answer = (await controller.handle(request(snapshot))) as Suggestion;
  assert.deepEqual(answer.selectedIds, ['o2']);
  assert.equal(calls(), 1);
});

test('a late provider answer is discarded after navigation; duplicate jobs are rejected', async () => {
  let release!: (value: Suggestion) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { controller } = setup({
    id: 'mock',
    suggest: () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const snapshot = await scan(controller);
  const promise = controller.handle(request(snapshot));
  await began;
  await assert.rejects(controller.handle(request(snapshot)), /已有请求/);
  controller.invalidate(1);
  release({
    questionId: snapshot.questions[0]!.id,
    provider: 'mock',
    model: 'mock',
    selectedIds: [],
    probabilities: {},
    confidence: null,
    probabilityKind: 'independent',
    needsReview: true,
    notices: [],
  });
  await assert.rejects(promise, /停止或超时/);
});

test('cancel reaches the provider AbortSignal', async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { controller } = setup({
    id: 'mock',
    suggest: (_question, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
        started();
      }),
  });
  const snapshot = await scan(controller);
  const promise = controller.handle(request(snapshot));
  await began;
  await controller.handle({ type: 'cancel', tabId: 1 });
  await assert.rejects(promise, /aborted/);
});

test('unknown message types and invalid settings are rejected at runtime', async () => {
  const { controller } = setup();
  await assert.rejects(
    controller.handle({ type: 'fetch', url: 'https://attacker.test' }),
    /请求无效/,
  );
  await assert.rejects(
    controller.handle({
      type: 'settings:save',
      settings: { model: 'bad model', reviewThreshold: 2 },
    }),
    /模型名称无效/,
  );
});
