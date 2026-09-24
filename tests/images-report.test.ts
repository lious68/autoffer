import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { cropRegions } from '../src/background/images';
import { scanPage } from '../src/platforms/registry';
import { inferenceIssue, type Question } from '../src/core/schema';
import { AutomaticSession } from '../src/content/session';
import { formatReport, RunReportSchema } from '../src/core/report';
import { AppError } from '../src/core/errors';

const q: Question = {
  id: 'q',
  kind: 'single',
  stem: '图片题',
  material: '',
  options: [
    { id: 'o1', label: 'A', text: 'a' },
    { id: 'o2', label: 'B', text: 'b' },
  ],
  warnings: [],
  hasVisual: true,
  visuals: [
    {
      id: 'image1',
      fingerprint: 'hash',
      kind: 'image',
      x: 20,
      y: 30,
      width: 100,
      height: 80,
      viewportWidth: 1000,
      viewportHeight: 800,
      ready: true,
      obscured: false,
    },
  ],
};

test('image crops use only declared regions with DPR scaling and reject clipping/occlusion', () => {
  assert.deepEqual(cropRegions(q, 2000, 1600), [
    { id: 'image1', x: 40, y: 60, width: 200, height: 160 },
  ]);
  for (const patch of [
    { x: -1 },
    { x: 950 },
    { ready: false },
    { obscured: true },
    { width: 0 },
  ])
    assert.throws(() =>
      cropRegions(
        { ...q, visuals: [{ ...q.visuals![0]!, ...patch }] },
        2000,
        1600,
      ),
    );
  assert.throws(() => cropRegions(q, 2000, 800), /尺寸/);
});

test('platform recognizes image-only stem/options and fingerprints image content without exporting its private URL', () => {
  const dom = new JSDOM(
    '<body data-autoffer-demo="v1"><div data-kind="single"><div data-stem><img src="https://private.test/image?token=PRIVATE"></div><div data-option><span data-label>A</span><div data-text><img src="https://private.test/a"></div></div><div data-option><span data-label>B</span><div data-text>文字选项</div></div></div>',
    { url: 'http://localhost/demo.html' },
  );
  const context = {
    document: dom.window.document,
    url: new URL('http://localhost/demo.html'),
  };
  const first = scanPage(context).questions[0]!;
  assert.equal(first.stem, '【图片题干】');
  assert.equal(first.visuals?.length, 2);
  assert.equal(first.visuals?.[1]?.optionId, 'o1');
  assert.equal(inferenceIssue(first), null);
  assert.ok(!JSON.stringify(first).includes('PRIVATE'));
  const img = dom.window.document.querySelector('img')!;
  img.getBoundingClientRect = () =>
    ({ left: 30, top: 40, width: 200, height: 100 }) as DOMRect;
  assert.equal(
    scanPage(context).questions[0]!.id,
    first.id,
    'scroll/layout changes alone must not recharge a question',
  );
  img.src = 'https://private.test/new';
  assert.notEqual(scanPage(context).questions[0]!.id, first.id);
  dom.window.close();
});

test('manual start and end create a local report with fallback route, skips and reference answers', async () => {
  let now = 1000;
  const base: Question = { ...q, hasVisual: false };
  delete base.visuals;
  const make = (id: string) => ({ ...base, id });
  const session = new AutomaticSession({
    now: () => now,
    settleMs: 0,
    emit: () => {},
    cancel: async () => {},
    suggest: async (question) => {
      if (question.id === 'unavailable')
        throw new AppError('UNSUPPORTED', '未配置通用模型');
      return {
        questionId: question.id,
        selectedIds: question.kind === 'text' ? [] : ['o2'],
        provider: 'custom',
        model: 'vision-test',
        probabilities: {},
        confidence: 0.9,
        probabilityKind: 'unavailable',
        needsReview: question.kind === 'text',
        ...(question.kind === 'text'
          ? {
              manualOnly: true,
              answerText: '~~~\n<script>not executable</script>\n~~~',
            }
          : {}),
        route: [
          {
            provider: 'typesafe',
            model: 'jev',
            outcome: 'failed',
            reason: 'AUTH',
          },
          { provider: 'custom', model: 'vision-test', outcome: 'success' },
        ],
        notices: [],
      };
    },
    apply: async () => {
      now += 150;
      return 'advanced';
    },
    skip: async () => 'section-end',
  });
  session.observe(make('before-start'));
  await session.settled();
  session.start();
  session.observe(make('first'));
  await session.settled();
  session.observe({ ...make('reference'), kind: 'text', options: [] });
  await session.settled();
  session.observe({ ...make('unavailable'), kind: 'text', options: [] });
  await session.settled();
  const report = RunReportSchema.parse(session.end());
  assert.equal(report.records.length, 3);
  assert.deepEqual(
    report.records.map((r) => r.status),
    ['answered', 'reference', 'skipped'],
  );
  assert.equal(report.reachedEnd, true);
  assert.deepEqual(session.end(), report, 'ending is idempotent');
  const markdown = formatReport(report);
  assert.match(markdown, /typesafe\/jev \[failed\] AUTH → custom\/vision-test/);
  assert.ok(markdown.includes('~~~~text'));
  assert.ok(!markdown.includes('PRIVATE'));
});
