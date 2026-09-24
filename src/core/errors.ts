export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError)
    return { code: error.code, message: error.message };
  // Never reflect provider bodies, page data, or credentials into logs/UI.
  return {
    code: 'INTERNAL',
    message: '操作未完成，请重试；若仍失败，请提交脱敏后的复现步骤。',
  };
}
