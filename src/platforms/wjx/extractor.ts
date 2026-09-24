import {
  interactionKind,
  type Classification,
} from '../../core/classification';
import { semanticQuestion, type Question } from '../../core/schema';
import { defineTemplate, fingerprint, visible } from '../template';
import type { PlatformAdapter, PlatformContext } from '../types';

export const cursorAttribute = 'data-autoffer-wjx-topic';
const meta: PlatformAdapter['meta'] = {
  id: 'wjx',
  name: '问卷星',
  version: '1.0.0',
  status: 'experimental',
};
const hosts = ['ks.wjx.com', 'ks.wjx.cn', 'www.wjx.com', 'www.wjx.cn'];
const formats: Record<string, Classification['format']> = {
  '1': 'fill-blank',
  '2': 'subjective',
  '3': 'single-choice',
  '4': 'multiple-choice',
};
const personal =
  /^(?:请(?:填写|输入|选择|问)?\s*)?(?:您的?|本人)?\s*(?:基本信息|个人信息|姓名|姓氏|性别|年龄|部门|员工编号|工号|学号|班级|学校|手机|电话|邮箱|电子邮件|身份证|联系方式)(?:\s|[：:（(？?]|$)/;

export function matches({ document, url }: PlatformContext) {
  return (
    url.protocol === 'https:' &&
    hosts.includes(url.hostname) &&
    /^\/vm\/[a-zA-Z0-9_-]+\.aspx$/i.test(url.pathname) &&
    Boolean(document.querySelector('form#form1 .field[topic][type]'))
  );
}

/** Reads labels only, never input values, hidden answer keys or page scripts. */
export function entries(context: PlatformContext) {
  if (!matches(context)) return [];
  const blocks = [
    ...context.document.querySelectorAll<HTMLElement>(
      'form#form1 .field[topic][type]',
    ),
  ].filter(visible);
  const seen = new Set<string>();
  return blocks.slice(0, 100).flatMap((block) => {
    const topic = block.getAttribute('topic') ?? '';
    if (
      !/^\d{1,6}$/.test(topic) ||
      block.id !== `div${topic}` ||
      seen.has(topic)
    )
      throw new Error('问卷星题号重复或布局无效。');
    seen.add(topic);
    const format = formats[block.getAttribute('type') ?? ''];
    const stem =
      block.querySelector('.field-label .topichtml')?.textContent?.trim() ?? '';
    if (
      !format ||
      !stem ||
      personal.test(stem.replace(/^\d+\s*[、.．]\s*/, ''))
    )
      return [];
    const classification: Classification = {
      domain: 'unknown',
      format,
      intent:
        context.url.hostname.startsWith('ks.') ||
        block.getAttribute('ceshi') === '1'
          ? 'knowledge'
          : 'unknown',
    };
    const template = defineTemplate({
      meta,
      match: { hosts, pathPrefix: '/vm/', marker: 'form#form1' },
      rules: [
        {
          root: `form#form1 .field[id="div${topic}"][topic="${topic}"]`,
          stem: '.field-label .topichtml',
          classification,
          ...(['3', '4'].includes(block.getAttribute('type') ?? '')
            ? {
                options: {
                  root: '.ui-controlgroup > .ui-radio, .ui-controlgroup > .ui-checkbox',
                  text: '.label',
                },
              }
            : {}),
        },
      ],
    });
    const extracted = template.extract(context).questions[0];
    if (!extracted) return [];
    const question: Question = {
      ...extracted,
      kind: interactionKind(classification),
      typeLabel:
        (
          {
            '1': '填空题',
            '2': '简答题',
            '3': '单选题',
            '4': '多选题',
          } as Record<string, string>
        )[block.getAttribute('type')!] ?? '题目',
    };
    question.id = `wjx:${topic}:${fingerprint(JSON.stringify(semanticQuestion({ ...question, id: '' })))}`;
    return [{ topic, block, question }];
  });
}

export function currentEntry(context: PlatformContext) {
  const all = entries(context);
  const topic = context.document
    .querySelector('form#form1')
    ?.getAttribute(cursorAttribute);
  // A removed/hidden selected question must not silently redirect an in-flight answer.
  return topic ? all.find((entry) => entry.topic === topic) : all[0];
}

const extractor: PlatformAdapter = {
  meta,
  matches,
  extract(context) {
    const entry = currentEntry(context);
    return {
      platform: meta,
      questions: entry ? [entry.question] : [],
      warnings: entry
        ? []
        : [
            '未找到当前可识别题目，请在悬浮面板选择题目。基本信息、矩阵和量表不自动填写。',
          ],
    };
  },
};
export default extractor;
