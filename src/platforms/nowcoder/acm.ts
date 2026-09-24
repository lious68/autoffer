import { QuestionSchema, type Question } from '../../core/schema';
import { visible, fingerprint } from '../template';

// Only inspect the already matched question container. Editable answers and
// toolbar controls are never part of a programming problem statement.
const excluded =
  'button, input, textarea, select, [role="textbox"], [role="combobox"], [contenteditable]:not([contenteditable="false"]), .monaco-editor, .CodeMirror, .ncicon';
const blocks = /^(DIV|P|PRE|UL|OL|LI|SECTION|ARTICLE|H[1-6]|TABLE|TR)$/;

function problemText(root: Element) {
  const chunks: string[] = [];
  let visual = false;
  function visit(node: Node, pre = false) {
    if (node.nodeType === 3) {
      const value = (node.textContent ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n?/g, '\n');
      chunks.push(pre ? value : value.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (!visible(element) || element.matches(excluded)) return;
    if (element.matches('img, svg, canvas, math, video, audio, [role="img"]')) {
      visual = true;
      return;
    }
    if (element.tagName === 'BR') {
      chunks.push('\n');
      return;
    }
    const isBlock = blocks.test(element.tagName);
    if (isBlock && !pre) chunks.push('\n');
    const whiteSpace =
      element.ownerDocument.defaultView?.getComputedStyle(element).whiteSpace;
    const preserve =
      pre ||
      element.tagName === 'PRE' ||
      element.tagName === 'CODE' ||
      ['pre', 'pre-wrap', 'break-spaces'].includes(whiteSpace ?? '');
    for (const child of element.shadowRoot?.childNodes ?? element.childNodes)
      visit(child, preserve);
    if (isBlock && !pre) chunks.push('\n');
  }
  visit(root);
  return { text: chunks.join('').trim(), visual };
}

/** Semantic ACM anchors also work when the page omits the normal 题型 header. */
export function extractAcm(block: Element): Question | null {
  const exampleTag = block.querySelector(':scope > .header > .example-tag');
  const isExample = Boolean(
    exampleTag &&
    visible(exampleTag) &&
    exampleTag.textContent?.trim() === '例题' &&
    block
      .querySelector(':scope > .header > .defaultScore')
      ?.textContent?.trim() === '不计分',
  );
  const { text, visual } = problemText(block);
  const lines = text.split('\n');
  const input = lines.findIndex((line) => /^输入描述[：:]?$/.test(line.trim()));
  const output = lines.findIndex((line) =>
    /^输出描述[：:]?$/.test(line.trim()),
  );
  const samples = lines.flatMap((line, index) =>
    index > output && /^示例\s*\d*[：:]?$/.test(line.trim()) ? [index] : [],
  );
  const sample = samples[0] ?? -1;
  // A prose mention of input/output is not enough to classify a question as code.
  const prefix = lines.slice(0, input).join('\n');
  if (
    input < 0 ||
    output <= input ||
    !/时间限制[：:]|空间限制[：:]|\bACM\b/i.test(prefix)
  )
    return null;
  const warnings: string[] = [];
  if (
    lines.filter((line) => /^输入描述[：:]?$/.test(line.trim())).length !== 1 ||
    lines.filter((line) => /^输出描述[：:]?$/.test(line.trim())).length !== 1
  )
    warnings.push('编程题输入输出描述存在重复分区，请核对页面。');
  if (
    !lines
      .slice(input + 1, output)
      .join('')
      .trim()
  )
    warnings.push('编程题输入描述尚未加载。');
  if (
    !lines
      .slice(output + 1, sample < 0 ? undefined : sample)
      .join('')
      .trim()
  )
    warnings.push('编程题输出描述尚未加载。');
  if (!prefix.trim()) warnings.push('编程题题干尚未加载。');
  for (const [index, start] of samples.entries()) {
    const example = lines.slice(start + 1, samples[index + 1]);
    const inputAt = example.findIndex((line) =>
      /^输入[：:]?$/.test(line.trim()),
    );
    const outputAt = example.findIndex((line) =>
      /^输出[：:]?$/.test(line.trim()),
    );
    if (
      inputAt < 0 ||
      outputAt <= inputAt ||
      !example
        .slice(inputAt + 1, outputAt)
        .join('')
        .trim() ||
      !example
        .slice(outputAt + 1)
        .join('')
        .trim()
    )
      warnings.push(`编程题示例 ${index + 1} 未完整展开或加载。`);
  }
  if (visual) warnings.push('编程题包含图像或公式，需补充该布局的图像提取。');
  const stem = prefix.trim();
  const material = lines.slice(input).join('\n').trim();
  if (!stem) return null;
  return QuestionSchema.parse({
    id: `nowcoder:acm:${fingerprint(JSON.stringify({ stem, material, visual, warnings, isExample }))}`,
    kind: 'text',
    typeLabel: isExample ? '编程例题（不计分）' : '编程题（ACM）',
    isExample,
    classification: {
      domain: 'professional',
      format: 'programming',
      intent: 'knowledge',
      subject: '程序设计',
    },
    stem,
    material,
    options: [],
    hasVisual: visual,
    warnings,
  });
}
