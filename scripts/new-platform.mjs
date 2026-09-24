import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const [id, name = id] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 40) {
  console.error(
    'Usage: npm run platform:new -- <lowercase-kebab-id> "平台名称"',
  );
  process.exit(1);
}
const directory = path.join('src', 'platforms', id);
try {
  await access(directory);
  console.error(`Platform already exists: ${id}`);
  process.exit(1);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const fixturePath = `tests/fixtures/${id}.html`;
const testPath = `tests/${id}.test.ts`;
for (const filename of [fixturePath, testPath]) {
  try {
    await access(filename);
    console.error(`Refusing to overwrite existing file: ${filename}`);
    process.exit(1);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await mkdir(directory, { recursive: true });
await mkdir('tests/fixtures', { recursive: true });
const files = [
  [
    path.join(directory, 'index.ts'),
    `import { defineTemplate } from '../template';

// Replace example.invalid and selectors with a reviewed, sanitized platform fixture.
export default defineTemplate({
  meta: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, version: '0.1.0', status: 'experimental' },
  match: { hosts: [${JSON.stringify(`${id}.example.invalid`)}], pathPrefix: '/practice/', marker: '[data-assessment]' },
  rules: [
    { root: '[data-question]', classification: { domain: 'unknown', format: 'single-choice', intent: 'knowledge' }, stem: '[data-stem]', options: { root: '[data-option]', text: '[data-text]' } },
  ],
});
`,
  ],
  [
    path.join(directory, 'README.md'),
    `# ${name}

- ID: \`${id}\`
- Status: experimental
- Last verified: not yet verified
- Source: synthetic fixture only; replace with authorized, sanitized HTML
- Supported question types: single choice (scaffold)
- Assessment domain: unknown; classify only from verified page/section evidence
- Actions: recognition only; automatic mode generates suggestions and waits for manual input
- Maintenance: add maintainer/contact and fixture provenance before registration
- Known limitations: no real platform verification, iframe, or Shadow DOM support yet

Before registration, update the host, path, marker and selectors; add fixtures for real variants and failures.

For actions, compose the extractor with an optional PlatformActions object in index.ts; implement it in actions.ts. See docs/platforms.md. Do not copy another platform's selectors or selection-state assumptions.
For new assessment domains or solving policies, see docs/question-model.md and src/solvers/policy.ts.
`,
  ],
  [
    fixturePath,
    `<!doctype html><html><body data-assessment>
<section data-question><h2 data-stem>演示：下列哪个是水果？</h2>
<label data-option><input type="radio" name="q1"><span data-text>苹果</span></label>
<label data-option><input type="radio" name="q1"><span data-text>石头</span></label>
</section></body></html>
`,
  ],
  [
    testPath,
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import adapter from '../src/platforms/${id}';
import { assertPlatformContract } from './platform-contract';

test('${id}: fixture extraction contract', () => {
  const document = new JSDOM(readFileSync(new URL('./fixtures/${id}.html', import.meta.url), 'utf8')).window.document;
  const context = { document, url: new URL('https://${id}.example.invalid/practice/example') };
  assert.equal(adapter.matches(context), true);
  const result = assertPlatformContract(adapter, context);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]?.classification?.format, 'single-choice');
  assert.equal(result.questions[0]?.options[0]?.text, '苹果');
  assert.equal(result.questions[0]?.warnings.length, 0);
  assert.equal(adapter.matches({ ...context, url: new URL('https://unrelated.example/') }), false);
});
`,
  ],
];
for (const [filename, contents] of files)
  await writeFile(filename, contents, { flag: 'wx' });
console.log(
  `Created ${directory}, ${fixturePath}, ${testPath}.\nNext: update selectors and fixture, register the adapter in src/platforms/registry.ts, then run npm run format && npm run check.`,
);
