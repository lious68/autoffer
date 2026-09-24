import { AppError } from '../core/errors';
import { formatReport, reportFilename, type RunReport } from '../core/report';

interface Storage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}
type Downloads = Pick<
  typeof chrome.downloads,
  'download' | 'search' | 'onChanged'
>;
interface Receipt {
  run: string;
  id: number;
  filename: string;
}

/** Background-owned downloads survive popup closure. A retained ID prevents duplicate exports. */
export function createReportDownloads(
  downloads: Downloads,
  storage: Storage,
  timeoutMs = 30_000,
) {
  const pending = new Map<string, Promise<Receipt>>();
  const key = (tabId: number) => `tool-report-download:${tabId}`;
  const identity = (report: RunReport) =>
    `${report.startedAt}/${report.endedAt}`;
  async function receipt(
    tabId: number,
    report: RunReport,
  ): Promise<Receipt | undefined> {
    const value = (await storage.get(key(tabId)))[key(tabId)] as
      Partial<Receipt> | undefined;
    return value?.run === identity(report) &&
      typeof value.id === 'number' &&
      typeof value.filename === 'string'
      ? (value as Receipt)
      : undefined;
  }
  async function wait(id: number) {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        downloads.onChanged.removeListener(changed);
        if (error) reject(error);
        else resolve();
      };
      const failed = () =>
        new AppError(
          'REPORT_DOWNLOAD',
          '报告已生成，但下载未完成，请点击重试下载。',
        );
      const changed = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') finish();
        else if (delta.state?.current === 'interrupted' || delta.error)
          finish(failed());
      };
      const timer = setTimeout(() => finish(failed()), timeoutMs);
      downloads.onChanged.addListener(changed);
      void downloads.search({ id }).then(
        ([item]) => {
          if (!item || item.state === 'interrupted') finish(failed());
          else if (item.state === 'complete') finish();
        },
        () => finish(failed()),
      );
    });
  }
  return {
    async complete(tabId: number, report: RunReport) {
      const saved = await receipt(tabId, report);
      if (!saved) return false;
      const [item] = await downloads.search({ id: saved.id });
      return item?.state === 'complete';
    },
    download(tabId: number, report: RunReport): Promise<Receipt> {
      const jobKey = `${tabId}/${identity(report)}`;
      const existing = pending.get(jobKey);
      if (existing) return existing;
      const job = (async () => {
        try {
          let saved = await receipt(tabId, report);
          if (saved) {
            const [item] = await downloads.search({ id: saved.id });
            if (!item || item.state === 'interrupted') saved = undefined;
          }
          if (!saved) {
            const filename = reportFilename(report);
            const id = await downloads.download({
              url: `data:text/markdown;charset=utf-8,${encodeURIComponent(formatReport(report))}`,
              filename,
              conflictAction: 'uniquify',
              saveAs: false,
            });
            saved = { run: identity(report), id, filename };
            await storage.set({ [key(tabId)]: saved });
          }
          await wait(saved.id);
          return saved;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            'REPORT_DOWNLOAD',
            '报告已生成，但下载失败，请点击重试下载。',
          );
        }
      })();
      pending.set(jobKey, job);
      void job.then(
        () => pending.delete(jobKey),
        () => pending.delete(jobKey),
      );
      return job;
    },
  };
}
