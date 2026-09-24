import { AppError } from '../core/errors';

/** Read only a bounded error envelope; never display upstream messages or URLs. */
export async function providerHttpError(
  response: Response,
  label: string,
): Promise<AppError> {
  let type: unknown;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size <= 8192) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) break;
        chunks.push(value);
      }
      if (size <= 8192) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const raw = JSON.parse(new TextDecoder().decode(bytes));
        type = raw?.error?.type ?? raw?.error?.code;
      }
    } catch {
      /* Status-only fallback for non-JSON, truncated or unreadable errors. */
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  if (response.status === 403 && type === 'customer_verification_required')
    return new AppError(
      'BILLING_VERIFICATION',
      `${label} 要求账户验证（HTTP 403 / customer_verification_required）。请在该 Key 所属 Vercel 团队添加有效信用卡后再试；这不是 Key 无效的提示。`,
    );
  if (response.status === 401)
    return new AppError(
      'AUTH',
      `${label} 鉴权失败（HTTP 401），请确认保存的是该渠道的 API Key。`,
    );
  if (response.status === 403)
    return new AppError(
      'FORBIDDEN',
      `${label} 拒绝访问（HTTP 403）。请检查 Key 所属团队的账户验证、模型权限和访问限制。`,
    );
  if (response.status === 402)
    return new AppError('CREDIT', `${label} 额度不足，请检查账户额度。`);
  if (response.status === 429 || response.status === 529)
    return new AppError('RATE_LIMIT', `${label} 暂时限流或繁忙，请稍后重试。`);
  return new AppError(
    'PROVIDER',
    `${label} 请求失败（HTTP ${response.status}）。`,
  );
}
