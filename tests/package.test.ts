import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { platforms } from '../src/platforms/registry';

test('extension has a narrow host allowlist and no external messaging or persistent page injection', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions, [
    'https://api.typesafe.ai/*',
    'https://api.modelverse.cn/*',
    'https://ai-gateway.vercel.sh/*',
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.match(
    manifest.content_security_policy.extension_pages,
    /connect-src https:/,
  );
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(!manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.action.default_popup, 'popup.html');
});
test('platform IDs are unique; built-in templates do not advertise unverified production sites', () => {
  assert.equal(
    new Set(platforms.map((platform) => platform.meta.id)).size,
    platforms.length,
  );
  for (const platform of platforms) {
    assert.ok(
      ['demo', 'experimental', 'verified'].includes(platform.meta.status),
    );
  }
});
