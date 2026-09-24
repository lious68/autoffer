import type { Question } from '../core/schema';
import { AppError } from '../core/errors';

export function cropRegions(
  question: Question,
  pixelWidth: number,
  pixelHeight: number,
) {
  const visuals = question.visuals ?? [];
  if (!visuals.length || visuals.length > 6)
    throw new AppError('IMAGE_CAPTURE', '每题最多支持 6 个可见图像区域。');
  return visuals.map((v) => {
    if (
      !v.ready ||
      v.obscured ||
      v.width <= 0 ||
      v.height <= 0 ||
      v.viewportWidth <= 0 ||
      v.viewportHeight <= 0 ||
      v.x < 0 ||
      v.y < 0 ||
      v.x + v.width > v.viewportWidth + 1 ||
      v.y + v.height > v.viewportHeight + 1
    )
      throw new AppError(
        'IMAGE_CAPTURE',
        '题目图片尚未加载、被遮挡或未完整显示。请让图片完整可见后继续。',
      );
    const sx = pixelWidth / v.viewportWidth,
      sy = pixelHeight / v.viewportHeight;
    if (Math.abs(sx - sy) > 0.05)
      throw new AppError(
        'IMAGE_CAPTURE',
        '截图与页面尺寸不一致，请保持页面大小后重试。',
      );
    return {
      id: v.id,
      x: Math.max(0, Math.floor(v.x * sx)),
      y: Math.max(0, Math.floor(v.y * sy)),
      width: Math.min(
        pixelWidth - Math.floor(v.x * sx),
        Math.ceil(v.width * sx),
      ),
      height: Math.min(
        pixelHeight - Math.floor(v.y * sy),
        Math.ceil(v.height * sy),
      ),
    };
  });
}

/** Capture stays in memory; ONLY question image crops leave the worker, never the full viewport. */
export async function captureQuestionImages(tabId: number, question: Question) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active)
    throw new AppError('IMAGE_CAPTURE', '请保持题目标签页为当前页再解析图片。');
  const active = async () => {
    const [current] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (current?.id !== tabId)
      throw new AppError('PAGE_CHANGED', '活动标签已切换，图片已丢弃。');
  };
  await active();
  let screenshot: string;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    });
  } catch {
    throw new AppError(
      'IMAGE_CAPTURE',
      '浏览器无法截取题目图片，请重新点击扩展图标授予当前页权限。',
    );
  }
  await active();
  const decoded = atob(screenshot.slice(screenshot.indexOf(',') + 1));
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(decoded, (c) => c.charCodeAt(0))], {
      type: 'image/png',
    }),
  );
  try {
    const regions = cropRegions(question, bitmap.width, bitmap.height);
    const images = [];
    let total = 0;
    for (const region of regions) {
      const scale = Math.min(1, 1600 / Math.max(region.width, region.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(region.width * scale)),
        Math.max(1, Math.round(region.height * scale)),
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new AppError('IMAGE_CAPTURE', '浏览器无法处理题目图片。');
      ctx.drawImage(
        bitmap,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const bytes = new Uint8Array(
        await (
          await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
        ).arrayBuffer(),
      );
      total += bytes.length;
      if (total > 4_000_000)
        throw new AppError(
          'IMAGE_CAPTURE',
          '题目图像总大小超过 4 MB，暂不发送。',
        );
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      images.push({
        id: region.id,
        dataUrl: 'data:image/jpeg;base64,' + btoa(binary),
      });
    }
    return images;
  } finally {
    bitmap.close();
  }
}
