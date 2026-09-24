import { EditorTicketSchema } from '../core/programming';
import { connectionOrigin } from '../core/connections';
import { AppError, publicError } from '../core/errors';
import { createProviderRouter } from '../providers';
import { createModelVerifier } from '../providers/verify';
import { Controller } from './controller';
import { createVault } from './vault';
import { createPageScanner } from './scanner';
import { createReportDownloads } from './report-downloads';
import { PageTools } from './page-tools';
import { parseRequest } from '../core/protocol';
import { captureQuestionImages } from './images';
import { isTrustedUiSender } from './ui-sender';

// Chrome storage.local is plaintext local storage, restricted to extension contexts.
const storageReady = chrome.storage.local.setAccessLevel({
  accessLevel: 'TRUSTED_CONTEXTS',
});
const vault = createVault(chrome.storage.local, storageReady);
const pageTools = new PageTools(chrome.scripting, chrome.storage.session);
const reportDownloads = createReportDownloads(
  chrome.downloads,
  chrome.storage.session,
);

const controller = new Controller({
  vault,
  prepareProgramming: async (tabId, question) =>
    EditorTicketSchema.parse(
      await pageTools.code(tabId, {
        action: 'prepare',
        questionId: question.id,
      }),
    ),
  verifyModel: createModelVerifier(),
  hasPermission: (settings) =>
    chrome.permissions.contains({ origins: [connectionOrigin(settings)] }),
  provider: createProviderRouter((origin) =>
    chrome.permissions.contains({ origins: [origin] }),
  ),
  scan: createPageScanner(chrome.scripting),
  captureImages: captureQuestionImages,
});

function invalidate(tabId: number) {
  controller.invalidate(tabId);
  void pageTools.invalidate(tabId);
}
chrome.tabs.onRemoved.addListener(invalidate);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) controller.invalidate(tabId);
  // A SPA hash change can also report loading. Authorization remains bound to
  // documentId; a genuinely new document cannot reuse the old document's grant.
});
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const trustedUi = isTrustedUiSender(
    sender,
    chrome.runtime.id,
    chrome.runtime.getURL('popup.html'),
  );
  if (!trustedUi && !sender.tab) return false;
  void (async () => {
    const request = trustedUi
      ? parseRequest(message)
      : await pageTools.request(message, sender);
    if (request.type === 'code:command') {
      if (request.action === 'fill' && !request.code)
        throw new AppError('BAD_REQUEST', '代码为空。');
      return pageTools.code(
        request.tabId,
        request.action === 'fill'
          ? { action: 'fill', token: request.token, code: request.code! }
          : { action: request.action, token: request.token },
      );
    }
    if (request.type === 'tools:state') {
      const state = await pageTools.state(request.tabId);
      const report = state.ended
        ? await pageTools.savedReport(request.tabId)
        : null;
      return report
        ? {
            ...state,
            reportDownloadPending: !(await reportDownloads.complete(
              request.tabId,
              report,
            )),
          }
        : state;
    }
    if (request.type === 'tools:open') {
      const routes = await vault.readRoutes!();
      if (!routes.credentials.jev?.apiKey && !routes.credentials.chat?.apiKey)
        throw new AppError('NO_KEY', '请先配置并启用至少一个模型。');
      return pageTools.open(request.tabId, request.autoAnswer ?? true);
    }
    if (request.type === 'tools:stop')
      return pageTools.control(request.tabId, 'stop');
    if (request.type === 'tools:show')
      return pageTools.control(request.tabId, 'show');
    if (request.type === 'tools:end') {
      const report = await pageTools.end(request.tabId);
      if (!report) return null;
      const downloaded = await reportDownloads.download(request.tabId, report);
      return {
        report,
        downloadId: downloaded.id,
        filename: downloaded.filename,
      };
    }
    if (request.type === 'report:save')
      return pageTools.saveReport(request.tabId, request.report);
    if (
      [
        'settings:save',
        'routing:save',
        'model:save',
        'model:toggle',
        'model:remove-key',
        'routing:preferences',
      ].includes(request.type)
    ) {
      // Queue storage mutations in message order before asynchronous page cleanup.
      // A late enable response must not overtake a subsequently requested disable.
      const result = await controller.handle(request);
      await pageTools.stopAll();
      return result;
    }
    return controller.handle(request);
  })()
    .then((data) => respond({ ok: true, data }))
    .catch((error: unknown) =>
      respond({ ok: false, error: publicError(error) }),
    );
  return true;
});
