import { interactionKind } from '../core/classification';
import { ScanSchema, semanticQuestion, type Question } from '../core/schema';
import type { PlatformAdapter, PlatformTemplate } from './types';

function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return 'host' in root ? (root as ShadowRoot).host : null;
}

export function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = composedParent(node)) {
    if (
      node.matches(
        '[hidden], [aria-hidden="true"], template, script, style, noscript',
      )
    )
      return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse'
    )
      return false;
  }
  return true;
}

function find(root: ParentNode, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter(visible);
}
function cleanText(element: Element, readShadow: boolean): string {
  const chunks: Array<{ text: string; pre: boolean }> = [];
  function visit(node: Node, pre = false): void {
    if (node.nodeType === 3) {
      chunks.push({ text: node.textContent ?? '', pre });
      return;
    }
    if (node.nodeType !== 1) return;
    const current = node as Element;
    if (!visible(current)) return;
    const preserve =
      pre || current.tagName === 'PRE' || current.tagName === 'CODE';
    if (current.tagName === 'BR') {
      chunks.push({ text: '\n', pre: true });
      return;
    }
    if (!pre && preserve) chunks.push({ text: '\n', pre: true });
    const children =
      readShadow && current.shadowRoot
        ? current.shadowRoot.childNodes
        : current.childNodes;
    for (const child of children) visit(child, preserve);
    if (!pre && preserve) chunks.push({ text: '\n', pre: true });
  }
  visit(element);
  let result = '';
  let normal = '';
  function flush() {
    result += normal.replace(/\s+/g, ' ');
    normal = '';
  }
  for (const chunk of chunks) {
    if (chunk.pre) {
      flush();
      // Rich text encodes Python indentation as NBSP; normalize it without collapsing it.
      result += chunk.text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
    } else normal += `${chunk.text} `;
  }
  flush();
  return result.trim();
}
function text(
  root: ParentNode,
  selector: string | undefined,
  readShadow: boolean,
): string {
  return selector
    ? find(root, selector)
        .map((element) => cleanText(element, readShadow))
        .join('\n')
    : '';
}
function hasVisual(root: ParentNode, readShadow: boolean): boolean {
  if (find(root, 'img, svg, canvas, math, video, audio, [role="img"]').length)
    return true;
  if (!readShadow) return false;
  return Array.from(root.querySelectorAll('*')).some(
    (element) =>
      visible(element) &&
      element.shadowRoot &&
      hasVisual(element.shadowRoot, true),
  );
}
export function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function visualElements(root: ParentNode, readShadow: boolean): Element[] {
  const own = find(root, 'img,svg,canvas,math,video,audio,[role="img"]');
  if (readShadow)
    for (const element of root.querySelectorAll('*'))
      if (visible(element) && element.shadowRoot)
        own.push(...visualElements(element.shadowRoot, true));
  return [...new Set(own)].filter(
    (el) => !own.some((other) => other !== el && other.contains(el)),
  );
}
function visualAsset(
  element: Element,
  id: string,
  optionId?: string,
): NonNullable<Question['visuals']>[number] {
  const rect = element.getBoundingClientRect(),
    view = element.ownerDocument.defaultView;
  const kinds: Record<
    string,
    NonNullable<Question['visuals']>[number]['kind']
  > = {
    IMG: 'image',
    svg: 'svg',
    SVG: 'svg',
    CANVAS: 'canvas',
    math: 'math',
    MATH: 'math',
  };
  // Check edges as well as the centre: a floating panel can cover part of a figure.
  const obscured = [0.01, 0.5, 0.99].some((x) =>
    [0.01, 0.5, 0.99].some((y) => {
      const hit = element.ownerDocument.elementFromPoint?.(
        rect.left + rect.width * x,
        rect.top + rect.height * y,
      );
      if (!hit || hit === element || element.contains(hit)) return false;
      for (
        let parent: Element | null = element;
        parent;
        parent = composedParent(parent)
      )
        if (parent === hit) return false;
      return true;
    }),
  );
  return {
    id,
    fingerprint: fingerprint(element.outerHTML),
    kind:
      kinds[element.tagName] ??
      (element.getAttribute('role') === 'img' ? 'image' : 'unsupported'),
    ...(optionId ? { optionId } : {}),
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: view?.innerWidth ?? 0,
    viewportHeight: view?.innerHeight ?? 0,
    ready:
      element.tagName !== 'IMG' ||
      Boolean(
        (element as HTMLImageElement).complete &&
        (element as HTMLImageElement).naturalWidth,
      ),
    obscured,
  };
}

/** Declarative templates contain selectors only. No eval, remote templates, or page writes. */
export function defineTemplate(template: PlatformTemplate): PlatformAdapter {
  const readShadow = template.readOpenShadowRoots ?? false;
  return {
    meta: template.meta,
    matches({ document, url }) {
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        template.match.hosts.includes(url.hostname) &&
        url.pathname.startsWith(template.match.pathPrefix) &&
        Boolean(document.querySelector(template.match.marker))
      );
    },
    extract({ document }) {
      const warnings: string[] = [];
      const questions: Question[] = [];
      const visited = new Set<Element>();
      const blocks = template.rules.flatMap((rule) =>
        find(document, rule.root).map((block) => ({ rule, block })),
      );
      // Preserve page order even when question kinds are interleaved.
      blocks.sort((a, b) => {
        if (a.block === b.block) return 0;
        return a.block.compareDocumentPosition(b.block) & 4 ? -1 : 1;
      });
      for (const { rule, block } of blocks) {
        if (visited.has(block)) throw new Error('Overlapping question rules');
        visited.add(block);
        if (questions.length >= 100) {
          warnings.push('当前页超过 100 道题，仅识别前 100 道。');
          break;
        }
        const stem =
          text(block, rule.stem, readShadow) ||
          (find(block, rule.stem).some((area) => hasVisual(area, readShadow))
            ? '【图片题干】'
            : '');
        if (!stem) {
          warnings.push('有题目缺少题干，已跳过；请检查模板。');
          continue;
        }
        const material = [
          text(document, rule.sharedMaterial, readShadow),
          text(block, rule.material, readShadow),
        ]
          .filter(Boolean)
          .join('\n');
        const options = rule.options
          ? find(block, rule.options.root).map((option, index) => ({
              id: `o${index + 1}`,
              label:
                text(option, rule.options?.label, readShadow) ||
                String.fromCharCode(65 + index),
              text: text(option, rule.options?.text, readShadow),
            }))
          : [];
        const contentAreas = [
          block,
          ...find(document, rule.sharedMaterial ?? ':not(*)'),
        ];
        const containsVisual = contentAreas.some((area) =>
          hasVisual(area, readShadow),
        );
        const questionWarnings: string[] = [];
        const optionNodes = rule.options ? find(block, rule.options.root) : [];
        const visualNodes = [
          ...new Set(
            contentAreas.flatMap((area) => visualElements(area, readShadow)),
          ),
        ];
        const visuals = visualNodes.map((node, index) => {
          let optionIndex = -1;
          for (
            let parent: Element | null = node;
            parent;
            parent = composedParent(parent)
          ) {
            const found = optionNodes.indexOf(parent);
            if (found !== -1) {
              optionIndex = found;
              break;
            }
          }
          return visualAsset(
            node,
            `image${index + 1}`,
            optionIndex >= 0 ? `o${optionIndex + 1}` : undefined,
          );
        });
        if (
          options.some(
            (option) =>
              !option.text && !visuals.some((v) => v.optionId === option.id),
          )
        )
          questionWarnings.push('部分选项没有可读取文本。');
        if (find(block, rule.stem).length !== 1)
          questionWarnings.push('题干匹配到多个节点，请检查选择器。');
        const question = {
          kind: rule.kind ?? interactionKind(rule.classification!),
          ...(rule.classification
            ? { classification: rule.classification }
            : {}),
          stem,
          material,
          options,
          hasVisual: containsVisual,
          ...(visuals.length ? { visuals } : {}),
          warnings: questionWarnings,
        };
        questions.push({
          id: `${template.meta.id}:${questions.length + 1}:${fingerprint(JSON.stringify(semanticQuestion({ id: '', ...question })))}`,
          ...question,
        });
      }
      return ScanSchema.parse({
        platform: template.meta,
        questions,
        warnings: [...new Set(warnings)],
      });
    },
  };
}
