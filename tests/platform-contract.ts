import assert from 'node:assert/strict';
import { ScanSchema } from '../src/core/schema';
import type { PlatformAdapter, PlatformContext } from '../src/platforms/types';

/** Reusable minimum contract; platform-specific content and action assertions remain required. */
export function assertPlatformContract(
  adapter: PlatformAdapter,
  context: PlatformContext,
) {
  const before = context.document.documentElement.outerHTML;
  assert.equal(adapter.matches(context), true);
  const scan = ScanSchema.parse(adapter.extract(context));
  assert.equal(scan.platform?.id, adapter.meta.id);
  assert.ok(
    scan.questions.length > 0,
    'a positive fixture must contain a question',
  );
  assert.equal(
    new Set(scan.questions.map((q) => q.id)).size,
    scan.questions.length,
  );
  for (const question of scan.questions) {
    assert.equal(
      new Set(question.options.map((o) => o.id)).size,
      question.options.length,
    );
  }
  assert.deepEqual(
    adapter.extract(context),
    scan,
    'repeated reads must be stable',
  );
  assert.equal(
    context.document.documentElement.outerHTML,
    before,
    'extraction must not modify the page',
  );
  assert.equal(
    adapter.matches({ ...context, url: new URL('https://unrelated.invalid/') }),
    false,
  );
  return scan;
}
