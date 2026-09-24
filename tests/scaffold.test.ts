import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('platform scaffold creates adapter, fixture and test without overwriting existing work', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'autoffer-scaffold-'));
  const script = resolve('scripts/new-platform.mjs');
  try {
    const result = spawnSync(
      process.execPath,
      [script, 'sample-site', '示例平台'],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const adapter = readFileSync(
      join(cwd, 'src/platforms/sample-site/index.ts'),
      'utf8',
    );
    assert.match(adapter, /experimental/);
    assert.match(adapter, /classification/);
    assert.match(
      readFileSync(join(cwd, 'tests/sample-site.test.ts'), 'utf8'),
      /assertPlatformContract/,
    );
    assert.match(adapter, /sample-site.example.invalid/);
    assert.ok(existsSync(join(cwd, 'tests/fixtures/sample-site.html')));
    assert.ok(existsSync(join(cwd, 'tests/sample-site.test.ts')));
    // Execute the generated test against the real framework, without registering it.
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    symlinkSync(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
    symlinkSync(
      resolve('src/platforms/template.ts'),
      join(cwd, 'src/platforms/template.ts'),
    );
    symlinkSync(
      resolve('tests/platform-contract.ts'),
      join(cwd, 'tests/platform-contract.ts'),
    );
    const generated = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--test',
        join(cwd, 'tests/sample-site.test.ts'),
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    const duplicate = spawnSync(process.execPath, [script, 'sample-site'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(duplicate.status, 1);
    assert.equal(
      readFileSync(join(cwd, 'src/platforms/sample-site/index.ts'), 'utf8'),
      adapter,
    );
    const traversal = spawnSync(process.execPath, [script, '../escape'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(traversal.status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
