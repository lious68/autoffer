import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { runInContext } from 'node:vm';
import { createPageScanner } from '../src/background/scanner';
import { publicError } from '../src/core/errors';
import { fixture } from './helpers';

const scan = { platform: null, questions: [], warnings: ['No template'] };
const page = 'https://example.test/practice';
function mockScripting(responses: Array<unknown | Error>) {
  const calls: chrome.scripting.ScriptInjection<unknown[], unknown>[] = [];
  const scripting = {
    executeScript: (async (
      request: chrome.scripting.ScriptInjection<unknown[], unknown>,
    ) => {
      calls.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }) as typeof chrome.scripting.executeScript,
  };
  return { scripting, calls };
}

test('scanner reads the exact injected document in the isolated world', async () => {
  const { scripting, calls } = mockScripting([
    [{ documentId: 'doc-1', frameId: 0 }],
    [{ documentId: 'doc-1', frameId: 0, result: { scan, page } }],
  ]);
  assert.deepEqual(await createPageScanner(scripting)(5), {
    scan,
    page,
    documentId: 'doc-1',
  });
  assert.deepEqual(calls[1]?.target, { tabId: 5, documentIds: ['doc-1'] });
  assert.ok(calls.every((call) => call.world === 'ISOLATED'));
});

test('permission, missing bridge and invalid data have distinct non-sensitive diagnostics', async () => {
  for (const [responses, code] of [
    [
      [
        new Error(
          'Cannot access contents of url https://secret.test/?token=PRIVATE',
        ),
      ],
      'PAGE_PERMISSION',
    ],
    [[[{ frameId: 0 }]], 'DOCUMENT_MISSING'],
    [
      [
        [{ documentId: 'd', frameId: 0 }],
        [{ documentId: 'd', frameId: 0, result: null }],
      ],
      'SCANNER_MISSING',
    ],
    [
      [
        [{ documentId: 'd', frameId: 0 }],
        [{ documentId: 'd', frameId: 0, result: { scan: 'invalid', page } }],
      ],
      'SCAN_INVALID',
    ],
    [
      [
        [{ documentId: 'd', frameId: 0 }],
        [{ documentId: 'other', frameId: 0, result: { scan, page } }],
      ],
      'PAGE_CHANGED',
    ],
  ] as const) {
    const { scripting } = mockScripting([...responses]);
    await assert.rejects(createPageScanner(scripting)(5), (error: unknown) => {
      const safe = publicError(error);
      assert.equal(safe.code, code);
      assert.ok(!safe.message.includes('PRIVATE'));
      return true;
    });
  }
});

test('built content scanner survives wrapper-scoped injection and repeated runs', async () => {
  const built = await build({
    entryPoints: ['src/content/index.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'AutofferContent',
    write: false,
  });
  const code = built.outputFiles[0]!.text;
  const dom = new JSDOM(fixture, {
    url: 'http://localhost/demo.html',
    runScripts: 'outside-only',
  });
  try {
    for (let i = 0; i < 2; i++) {
      runInContext(`(function() { ${code}\n})();`, dom.getInternalVMContext());
      const result = runInContext(
        'globalThis.AutofferContent.scanCurrentPage()',
        dom.getInternalVMContext(),
      );
      assert.equal(result.platform.id, 'demo');
      assert.equal(result.questions.length, 5);
    }
  } finally {
    dom.window.close();
  }
});
