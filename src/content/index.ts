import { scanPage } from '../platforms/registry';
import type { Scan } from '../core/schema';
import { mountTools } from './tools';

export function scanCurrentPage(): Scan {
  return scanPage({ document, url: new URL(location.href) });
}

// Explicitly publish into the isolated world's global scope. A bundler's
// top-level var is not a reliable bridge between separate script injections.
export function openTools(autoAnswer = true) {
  // Replace older widgets that cannot render per-question skip history.
  if (
    globalThis.AutofferPageTools &&
    (globalThis.AutofferPageTools.historyVersion !== 6 ||
      typeof globalThis.AutofferPageTools.getState !== 'function')
  ) {
    globalThis.AutofferPageTools.dispose();
    globalThis.AutofferPageTools = undefined;
  }
  if (!globalThis.AutofferPageTools?.show())
    globalThis.AutofferPageTools = mountTools(document, new URL(location.href));
  globalThis.AutofferPageTools.start(autoAnswer);
  return true;
}
export function stopTools() {
  globalThis.AutofferPageTools?.stop(true);
}
export function showTools() {
  return globalThis.AutofferPageTools?.show() ?? false;
}
export function getToolsState() {
  return globalThis.AutofferPageTools?.getState() ?? null;
}
export function endTools() {
  return globalThis.AutofferPageTools?.end() ?? null;
}
globalThis.AutofferContent = {
  scanCurrentPage,
  openTools,
  stopTools,
  showTools,
  endTools,
  getToolsState,
};

declare global {
  var AutofferContent:
    | {
        scanCurrentPage: typeof scanCurrentPage;
        openTools: typeof openTools;
        stopTools: typeof stopTools;
        showTools: typeof showTools;
        endTools: typeof endTools;
        getToolsState: typeof getToolsState;
      }
    | undefined;
  var AutofferPageTools: ReturnType<typeof mountTools> | undefined;
}
