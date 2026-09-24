import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportDownloads } from '../src/background/report-downloads';
import {
  formatReport,
  reportFilename,
  type RunReport,
} from '../src/core/report';

const report: RunReport = {
  startedAt: '2026-09-23T01:00:00Z',
  endedAt: '2026-09-23T01:01:00Z',
  reachedEnd: false,
  dropped: 0,
  records: [],
};
function setup(
  initialState: 'complete' | 'in_progress' | 'interrupted' = 'complete',
) {
  const data: Record<string, unknown> = {};
  const items = new Map<number, chrome.downloads.DownloadItem>();
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  const calls: chrome.downloads.DownloadOptions[] = [];
  const storage = {
    get: async () => structuredClone(data),
    set: async (value: Record<string, unknown>) => {
      Object.assign(data, value);
    },
  };
  const api = {
    download: async (options: chrome.downloads.DownloadOptions) => {
      calls.push(options);
      const id = calls.length;
      items.set(id, {
        id,
        state: initialState,
      } as chrome.downloads.DownloadItem);
      return id;
    },
    search: async ({ id }: chrome.downloads.DownloadQuery) =>
      items.has(id!) ? [items.get(id!)!] : [],
    onChanged: {
      addListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) =>
        listeners.add(fn),
      removeListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) =>
        listeners.delete(fn),
    },
  } as unknown as Pick<
    typeof chrome.downloads,
    'download' | 'search' | 'onChanged'
  >;
  return {
    calls,
    listeners,
    items,
    service: createReportDownloads(api, storage, 500),
    reopen: () => createReportDownloads(api, storage, 500),
  };
}

test('background report download writes Markdown to the default downloads folder without a save dialog, and deduplicates across reopening', async () => {
  const f = setup();
  const first = f.service.download(42, report);
  const duplicate = f.service.download(42, report);
  assert.equal(first, duplicate);
  const result = await first;
  assert.equal(result.id, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.saveAs, false);
  assert.equal(f.calls[0]!.conflictAction, 'uniquify');
  assert.equal(f.calls[0]!.filename, reportFilename(report));
  assert.equal(
    decodeURIComponent(f.calls[0]!.url.split(',').slice(1).join(',')),
    formatReport(report),
  );
  assert.equal(await f.service.complete(42, report), true);
  await f.reopen().download(42, report);
  assert.equal(f.calls.length, 1);
  assert.equal(f.listeners.size, 0);
});

test('download waits for completion, retains the report ID on interruption, and retries an interrupted file', async () => {
  const f = setup('in_progress');
  let resolved = false;
  const pending = f.service.download(42, report).then(() => {
    resolved = true;
  });
  const rejected = assert.rejects(pending, /下载未完成/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  for (const listener of f.listeners)
    listener({ id: 1, state: { current: 'interrupted' } });
  f.items.get(1)!.state = 'interrupted';
  await rejected;
  const retry = f.service.download(42, report);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  f.items.get(2)!.state = 'complete';
  for (const listener of f.listeners)
    listener({ id: 2, state: { current: 'complete' } });
  assert.equal((await retry).id, 2);
  assert.equal(f.listeners.size, 0);
});

test('new runs export separately, and report timestamps cannot control download paths', async () => {
  const f = setup();
  await f.service.download(42, report);
  const second = { ...report, endedAt: '../../outside/file' };
  assert.equal(await f.service.complete(42, second), false);
  await f.service.download(42, second);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1]!.filename!, /^autoffer-report-[a-zA-Z0-9_-]+\.md$/);
});
