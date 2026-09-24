import { parseRequest, type Client, type Reply } from '../core/protocol';
import { connectionOrigin } from '../core/connections';

export const extensionClient: Client = {
  async getPanelView() {
    const value = (await chrome.storage.local.get('panelView')).panelView;
    return value === 'run' ? 'run' : 'models';
  },
  async setPanelView(panelView) {
    await chrome.storage.local.set({ panelView });
  },
  authorizeRoutes(config) {
    return chrome.permissions.request({
      origins: [
        ...new Set(
          [config.jev, config.chat]
            .filter((profile) => profile !== null)
            .map(connectionOrigin),
        ),
      ],
    });
  },
  authorizeConnection(settings) {
    // Called directly from the manual model-toggle gesture, before awaiting autosave.
    return chrome.permissions.request({
      origins: [connectionOrigin(settings)],
    });
  },
  async request(request) {
    const reply = (await chrome.runtime.sendMessage(parseRequest(request))) as
      Reply | undefined;
    if (!reply) throw new Error('扩展后台不可用，请重新加载扩展。');
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.data;
  },
  async activeTabId() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id === undefined) throw new Error('没有找到当前网页。');
    return tab.id;
  },
  onPageChange(callback) {
    const activated = () => callback();
    const updated = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (change.status === 'loading' || change.url) {
        void chrome.tabs
          .query({ active: true, currentWindow: true })
          .then(([tab]) => {
            if (tab?.id === tabId) callback();
          });
      }
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    return () => {
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
    };
  },
};
