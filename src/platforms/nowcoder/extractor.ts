import { extractAcm } from './acm';
import type { PlatformAdapter } from '../types';
import { defineTemplate, visible } from '../template';
import {
  interactionKind,
  type Classification,
} from '../../core/classification';

const meta = {
  id: 'nowcoder',
  name: '牛客企业笔试',
  version: '0.5.0',
  status: 'experimental',
} as const;

const nowcoder: PlatformAdapter = {
  meta,
  matches({ url }) {
    return (
      url.protocol === 'https:' &&
      url.hostname === 'exam.nowcoder.com' &&
      /^\/cts\/\d+\//.test(url.pathname)
    );
  },
  extract(context) {
    const { document } = context;
    // Confirmed on the enterprise directory. Never treat candidate fields or
    // section names as questions, and never advance/submit the exam here.
    const directory = document.querySelector('.module-menu .menu-container');
    if (directory && visible(directory)) {
      return {
        platform: meta,
        questions: [],
        warnings: [
          '当前是牛客试卷目录，还没有显示具体题目。请在测试场次中自行进入题目页后重新识别。',
        ],
      };
    }
    const blocks = Array.from(
      document.querySelectorAll('.question-preview-container'),
    ).filter(visible);
    if (blocks.length !== 1)
      return {
        platform: meta,
        questions: [],
        warnings: [
          blocks.length
            ? '检测到多个牛客题目容器，请等待页面稳定后重新识别。'
            : '已识别牛客入口，尚未找到当前题目，请确认题目已加载。',
        ],
      };
    const block = blocks[0]!;
    const type = block
      .querySelector(':scope > .header > .type')
      ?.textContent?.trim();
    const formats: Record<string, Classification['format']> = {
      单选: 'single-choice',
      单选题: 'single-choice',
      多选: 'multiple-choice',
      多选题: 'multiple-choice',
      不定项: 'multiple-choice',
      不定项选择: 'multiple-choice',
      不定项选择题: 'multiple-choice',
      判断: 'true-false',
      判断题: 'true-false',
      是非题: 'true-false',
      填空: 'fill-blank',
      填空题: 'fill-blank',
      问答: 'subjective',
      问答题: 'subjective',
      简答: 'subjective',
      简答题: 'subjective',
      编程: 'programming',
      编程题: 'programming',
      主观题: 'subjective',
    };
    const format = type ? formats[type] : undefined;
    if (!format || format === 'programming') {
      const acm = extractAcm(block);
      if (acm) return { platform: meta, questions: [acm], warnings: [] };
    }
    if (!format)
      return {
        platform: meta,
        questions: [],
        warnings: [
          '当前牛客题型尚未适配，仍在识别；进入已支持题型后自动继续。',
        ],
      };
    const classification: Classification = {
      domain: 'unknown',
      format,
      intent: 'knowledge',
    };
    const kind = interactionKind(classification);
    const template = defineTemplate({
      meta,
      match: {
        hosts: ['exam.nowcoder.com'],
        pathPrefix: '/cts/',
        marker: '.question-preview-container',
      },
      readOpenShadowRoots: true,
      rules: [
        {
          root: '.question-preview-container',
          classification,
          stem: '.body > .order-content > .rich-text',
          ...(kind === 'text'
            ? {}
            : {
                options: {
                  root: '.answers > .option-item',
                  text: '.option-content',
                  label: '.option-order',
                },
              }),
        },
      ],
    });
    const result = template.extract(context);
    const question = result.questions[0];
    if (question) {
      question.typeLabel = type!;
      question.id += `:${type}`;
      // The page is an SPA. Bind identity to the visible question number too.
      const number = block
        .querySelector('.order-content > .tw-text-size-head-pure')
        ?.textContent?.trim();
      if (number && /^\d+\.$/.test(number)) {
        const index = Number(number.slice(0, -1));
        question.id += `:${index}`;
        if (index > 0 && index <= 1000)
          question.section = { id: `nowcoder:${type}`, index };
      }
      const options = Array.from(
        block.querySelectorAll('.answers > .option-item'),
      ).filter(visible);
      const labels = options.map((option) =>
        option.querySelector('.option-order')?.textContent?.trim(),
      );
      if (
        labels.some((label) => !label) ||
        new Set(labels).size !== labels.length
      )
        question.warnings.push('选项标号缺失或重复，请核对页面结构。');
      if (
        ['判断', '判断题', '是非题'].includes(type!) &&
        question.options.length !== 2
      )
        question.warnings.push(
          '判断题必须有两个可读取选项；当前布局尚未确认。',
        );
      // Do not silently discard additional material whose layout has not been verified.
      const extras = Array.from(block.querySelectorAll('.rich-text')).filter(
        (element) =>
          visible(element) &&
          !element.matches(
            '.body > .order-content > .rich-text, .answers > .option-item > .option-content',
          ),
      );
      if (extras.length)
        question.warnings.push(
          '本题包含尚未适配的补充材料，请核对材料布局后再使用模型。',
        );
    }
    return result;
  },
};

export default nowcoder;
