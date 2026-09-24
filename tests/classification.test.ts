import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  classificationOf,
  interactionKind,
  type Classification,
} from '../src/core/classification';
import {
  QuestionSchema,
  inferenceIssue,
  semanticQuestion,
  type Question,
} from '../src/core/schema';
import { routeFor } from '../src/core/routing';
import { solvePolicy } from '../src/solvers/policy';
import { defineTemplate } from '../src/platforms/template';
import { assertPlatformContract } from './platform-contract';
import { demoScan } from './helpers';

const base = demoScan().questions[0]!;
const classified = (classification: Classification): Question => ({
  ...base,
  kind: interactionKind(classification),
  classification,
});

test('assessment domain is independent of answer format and personal intent', () => {
  for (const domain of ['professional', 'aptitude', 'psychological'] as const) {
    for (const format of [
      'single-choice',
      'multiple-choice',
      'true-false',
      'fill-blank',
      'subjective',
      'programming',
    ] as const) {
      const question = classified({ domain, format, intent: 'knowledge' });
      question.options = question.options.slice(0, 2);
      assert.ok(QuestionSchema.safeParse(question).success);
      assert.equal(inferenceIssue(question), null);
      assert.equal(
        solvePolicy(question).mode,
        question.kind === 'text' ? 'reference' : 'choice',
      );
      assert.equal(
        solvePolicy(question).preferredProvider,
        question.kind === 'text' ? 'chat' : 'jev',
      );
    }
  }
  for (const format of [
    'single-choice',
    'multiple-choice',
    'scale',
    'ranking',
  ] as const) {
    const question = classified({
      domain: 'psychological',
      format,
      intent: 'self-report',
    });
    assert.equal(question.kind, 'personal');
    assert.match(inferenceIssue(question)!, /真实情况/);
    assert.equal(
      routeFor(question, {
        chat: {
          apiKey: 'fake',
          settings: {
            provider: 'openrouter',
            model: 'fake',
            reviewThreshold: 0.8,
          },
        },
      }),
      null,
    );
  }
});

test('unknown intent, unsupported format, contradictory kinds and malformed judgement stay non-actionable', () => {
  for (const format of ['scale', 'ranking', 'unknown'] as const) {
    assert.equal(
      solvePolicy(
        classified({ domain: 'unknown', format, intent: 'knowledge' }),
      ).mode,
      'manual',
    );
  }
  assert.ok(
    inferenceIssue(
      classified({
        domain: 'unknown',
        format: 'single-choice',
        intent: 'unknown',
      }),
    ),
  );
  assert.equal(
    QuestionSchema.safeParse({
      ...classified({
        domain: 'professional',
        format: 'programming',
        intent: 'knowledge',
      }),
      kind: 'single',
    }).success,
    false,
  );
  assert.ok(
    inferenceIssue({
      ...classified({
        domain: 'aptitude',
        format: 'true-false',
        intent: 'knowledge',
      }),
      options: [],
    }),
  );
  assert.equal(classificationOf({ kind: 'single' }).format, 'single-choice');
  assert.equal(classificationOf({ kind: 'personal' }).intent, 'self-report');
  assert.equal(classificationOf({ kind: 'text' }).domain, 'unknown');
});

test('declarative classification drives extraction and changes question identity, without reading candidate input', () => {
  const document = new JSDOM(
    '<body data-test><section><h2>自编题：请选择正确结果。</h2><label><span>A</span></label><label><span>B</span></label><input value="PRIVATE_ANSWER"></section>',
  ).window.document;
  const context = {
    document,
    url: new URL('https://sample.invalid/practice/'),
  };
  const create = (classification: Classification) =>
    defineTemplate({
      meta: {
        id: 'sample',
        name: 'Synthetic',
        version: '1',
        status: 'experimental',
      },
      match: {
        hosts: ['sample.invalid'],
        pathPrefix: '/practice/',
        marker: '[data-test]',
      },
      rules: [
        {
          root: 'section',
          classification,
          stem: 'h2',
          options: { root: 'label', text: 'span' },
        },
      ],
    });
  const first = assertPlatformContract(
    create({
      domain: 'professional',
      format: 'true-false',
      intent: 'knowledge',
    }),
    context,
  ).questions[0]!;
  assert.equal(first.kind, 'single');
  assert.equal(first.classification?.format, 'true-false');
  assert.ok(!JSON.stringify(first).includes('PRIVATE_ANSWER'));
  const second = create({
    domain: 'psychological',
    format: 'single-choice',
    intent: 'self-report',
  }).extract(context).questions[0]!;
  assert.notEqual(first.id, second.id);
  assert.equal(second.kind, 'personal');
});

test('semantic comparison ignores adapter property order but retains classification changes', () => {
  const question = classified({
    domain: 'professional',
    format: 'true-false',
    intent: 'knowledge',
  });
  question.typeLabel = '判断';
  const reordered = {
    ...question,
    classification: {
      intent: 'knowledge' as const,
      format: 'true-false' as const,
      domain: 'professional' as const,
    },
  };
  assert.equal(
    JSON.stringify(semanticQuestion(question)),
    JSON.stringify(semanticQuestion(QuestionSchema.parse(reordered))),
  );
  assert.notEqual(
    JSON.stringify(semanticQuestion(question)),
    JSON.stringify(
      semanticQuestion({
        ...question,
        classification: { ...question.classification!, domain: 'aptitude' },
      }),
    ),
  );
});
