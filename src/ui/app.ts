import {
  ToolStateSchema,
  idleToolState,
  type ToolState,
} from '../core/tool-state';
import { brandIcon } from './brand';
import { icon } from './icons';
import type { Client } from '../core/protocol';
import { parseRequest } from '../core/protocol';
import { connectionFor, astraFlow, modelPresets } from '../core/connections';
import {
  modelEnabled,
  type ModelSlot,
  type ModelState,
  RoutingViewSchema,
  type RoutingView,
} from '../core/routing';
import { SettingsSchema, type Settings } from '../core/schema';
import { EndResultSchema, reportSummary } from '../core/report';

export function mountApp(root: HTMLElement, client: Client): () => void {
  const document = root.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    cls = '',
  ) => {
    const n = document.createElement(tag);
    n.textContent = text;
    n.className = cls;
    return n;
  };
  const button = (text: string, fn: () => void, cls = 'secondary') => {
    const b = el('button', text, cls);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  let runtime: ToolState = { ...idleToolState };
  let ready = false,
    busy = false,
    disposed = false,
    stateRevision = 0;
  let activeTab: number | null = null;
  const modelEpoch = { jev: 0, chat: 0 };
  const pendingToggles = new Set<ModelSlot>();
  let viewChosen = false;
  let view: RoutingView | null = null;
  let downloadFailed = false;
  const header = el('header', '', 'app-header'),
    brand = el('div', '', 'brand');
  brand.append(brandIcon(document, 'logo'), el('strong', 'AutOffer'));
  const version = globalThis.chrome?.runtime?.getManifest?.().version;
  if (version) brand.append(el('small', `v${version}`, 'app-version'));
  header.append(brand, el('span', '测评助手', 'app-caption'));
  const tabs = el('nav', '', 'tabs');
  tabs.setAttribute('aria-label', '插件页面');
  tabs.setAttribute('role', 'tablist');
  const runTab = button('运行', () => activate('run'), 'tab');
  const modelsTab = button('设置', () => activate('models'), 'tab');
  runTab.prepend(icon(document, 'play'));
  modelsTab.prepend(icon(document, 'sliders'));
  const runPanel = el('section', '', 'view run-view');
  const modelsPanel = el('section', '', 'view models-view');
  for (const [tab, panel, id] of [
    [runTab, runPanel, 'run'],
    [modelsTab, modelsPanel, 'models'],
  ] as const) {
    tab.id = `tab-${id}`;
    panel.id = `panel-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const target =
          event.key === 'Home'
            ? 'run'
            : event.key === 'End'
              ? 'models'
              : id === 'run'
                ? 'models'
                : 'run';
        activate(target);
        (target === 'run' ? runTab : modelsTab).focus();
      }
    });
  }
  tabs.append(runTab, modelsTab);
  function activate(page: 'run' | 'models', remember = true) {
    if (remember) {
      viewChosen = true;
      void client.setPanelView?.(page).catch(() => {});
    }
    if (root.contains(modelsPanel)) notice('');
    runPanel.hidden = page !== 'run';
    modelsPanel.hidden = page !== 'models';
    runTab.setAttribute('aria-selected', String(page === 'run'));
    modelsTab.setAttribute('aria-selected', String(page === 'models'));
    runTab.tabIndex = page === 'run' ? 0 : -1;
    modelsTab.tabIndex = page === 'models' ? 0 : -1;
  }
  activate('run', false);
  const modelCards = el('div');
  const intro = el('p', '输入自动保存，点击确认后验证并启用。', 'section-note');
  function card(slot: ModelSlot, label: string) {
    const details = el('details', '', 'model-card'),
      summary = el('summary'),
      body = el('fieldset');
    const summaryName = el('strong', label),
      summaryState = el('span', '', 'connection-state');
    summaryName.append(
      el('span', slot === 'jev' ? '主要' : '辅助', 'model-role'),
    );
    summary.append(summaryName, summaryState, icon(document, 'chevron'));
    details.append(summary, body);
    let editRevision = 0;
    let baseline = '';
    let savedKeyInput = '';
    let observed = '';
    let savedProfile = false;
    const markDirty = (event: Event) => {
      if (event.target === enabled) return;
      const next = JSON.stringify([config(), key.value]);
      if (next === observed) return;
      observed = next;
      editRevision++;
      feedback.hidden = true;
      void saveModel(slot);
    };
    details.addEventListener('input', markDirty);
    details.addEventListener('change', markDirty);
    const enableLabel = el('label', '', 'toggle model-enable'),
      enabled = el('input');
    enabled.type = 'checkbox';
    enabled.name = `${slot}-enabled`;
    enabled.setAttribute('aria-label', `启用${label}`);
    enableLabel.title = `启用${label}`;
    enableLabel.append(enabled);
    enableLabel.addEventListener('click', (event) => event.stopPropagation());
    summary.insertBefore(enableLabel, summary.lastChild);
    const keyLabel = el('label', 'API Key'),
      key = el('input');
    key.type = 'password';
    key.autocomplete = 'off';
    key.name = `${slot}-key`;
    key.id = `${slot}-key`;
    keyLabel.htmlFor = key.id;
    keyLabel.className = 'key-label';
    const confirm = button(
      '确认',
      () => {
        if (!pendingToggles.has(slot)) void toggleModel(slot, true);
      },
      'primary key-confirm',
    );
    confirm.name = `${slot}-confirm`;
    confirm.setAttribute('aria-label', `确认并启用${label}`);
    const keyRow = el('div', '', 'key-entry');
    keyRow.append(key, confirm);
    key.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirm.click();
      }
    });
    function confirmation(checking: boolean) {
      confirm.disabled = checking;
      confirm.textContent = checking ? '验证中…' : '确认';
    }
    const saveState = el('p', '修改自动保存', 'save-state');
    const feedback = el('p', '', 'model-feedback');
    feedback.setAttribute('role', 'alert');
    feedback.hidden = true;
    details.append(feedback);
    body.append(
      el('p', modelPresets[slot].model, 'model-preset'),
      keyLabel,
      keyRow,
      saveState,
    );
    enabled.addEventListener('change', () => {
      void toggleModel(slot, enabled.checked);
    });
    function load(
      profile: Settings | null,
      hasKey: boolean,
      isEnabled = false,
    ) {
      savedProfile = Boolean(profile);
      enabled.checked = isEnabled;
      key.value = '';
      saveState.textContent = hasKey ? 'Key 已保存到本机' : '填写后点击确认';
      key.placeholder = hasKey ? '已保存，输入可替换' : '输入 API Key';
      details.open = Boolean(profile) && !hasKey;
      baseline = JSON.stringify(config());
      savedKeyInput = '';
      observed = JSON.stringify([config(), key.value]);
      feedback.hidden = true;
      sync(isEnabled, hasKey);
    }
    function config(): Settings {
      return { ...modelPresets[slot] };
    }
    function dirty() {
      return (
        key.value !== savedKeyInput || JSON.stringify(config()) !== baseline
      );
    }
    function sync(
      isEnabled: boolean,
      hasKey: boolean,
      modelState?: ModelState,
    ) {
      confirmation(modelState?.phase === 'checking');
      enabled.checked = modelState?.phase === 'checking' || isEnabled;
      summaryState.textContent =
        modelState?.phase === 'checking'
          ? '验证中'
          : modelState?.phase === 'failed'
            ? '验证失败'
            : isEnabled
              ? '已启用'
              : savedProfile
                ? '已关闭'
                : '未配置';
      if (modelState) {
        if (modelState.phase === 'failed') {
          const message = modelState.message ?? '请检查配置后重新启用。';
          if (feedback.textContent !== message) feedback.textContent = message;
          feedback.hidden = false;
        } else feedback.hidden = true;
      }
      summaryState.classList.toggle('configured', isEnabled);
      summaryState.classList.toggle('failed', modelState?.phase === 'failed');
      summaryState.classList.toggle(
        'checking',
        modelState?.phase === 'checking',
      );
      saveState.textContent = hasKey ? 'Key 已保存到本机' : '填写后点击确认';
      key.placeholder = hasKey ? '已保存，输入可替换' : '输入 API Key';
    }
    function error(message: string) {
      confirmation(false);
      feedback.textContent = message;
      feedback.hidden = false;
    }
    load(null, false);
    return {
      details,
      key,
      load,
      config,
      dirty,
      sync,
      error,
      revision: () => editRevision,
      saved: (keyInput: string) => {
        baseline = JSON.stringify(config());
        savedKeyInput = keyInput;
        savedProfile = true;
        saveState.textContent = '已自动保存';
      },
      saving: () => {
        confirmation(false);
        enabled.checked = false;
        summaryState.textContent = '已关闭';
        saveState.textContent = '保存中…';
        summaryState.classList.remove('configured', 'failed', 'checking');
      },
      setEnabled: (value: boolean) => {
        confirmation(false);
        enabled.checked = value;
      },
      checking: () => {
        confirmation(true);
        enabled.checked = true;
        summaryState.textContent = '验证中';
        summaryState.classList.remove('configured', 'failed');
        summaryState.classList.add('checking');
      },
      clearError: () => {
        feedback.hidden = true;
      },
    };
  }
  const thresholdLabel = el('label', '', 'preference-row'),
    threshold = el('input');
  threshold.type = 'number';
  threshold.name = 'threshold';
  threshold.min = '50';
  threshold.max = '100';
  threshold.step = '5';
  threshold.value = '80';
  threshold.setAttribute('aria-label', '最低确定度（百分比）');
  const thresholdInput = el('span', '', 'threshold-input');
  thresholdInput.append(threshold, el('span', '%'));
  const thresholdCopy = el('span', '', 'preference-copy');
  thresholdCopy.append(
    el('strong', '最低确定度'),
    el('small', '模型补充后仍低于此值则跳过'),
  );
  thresholdLabel.append(thresholdCopy, thresholdInput);
  const autoLabel = el('label', '', 'toggle preference-row'),
    autoAnswer = el('input');
  autoAnswer.type = 'checkbox';
  autoAnswer.checked = true;
  autoAnswer.name = 'auto-answer';
  const autoCopy = el('span', '', 'preference-copy');
  autoCopy.append(
    el('strong', '连续作答'),
    el('small', '自动选答并切题，题型提交需手动'),
  );
  autoAnswer.setAttribute('aria-label', '自动选择客观题答案并进入下一题');
  autoLabel.append(autoCopy, autoAnswer);
  const jev = card('jev', 'Jev');
  const chat = card('chat', astraFlow.label);
  modelCards.append(jev.details, chat.details);
  modelsPanel.append(intro, modelCards);
  const preferences = el('div', '', 'preferences');
  preferences.append(autoLabel, thresholdLabel);

  const start = button(
    '开始',
    () => {
      void perform();
    },
    'primary start-button',
  );
  const primaryActions = el('div', '', 'run-actions');
  primaryActions.append(start);
  const status = el('p', '', 'status');
  status.setAttribute('role', 'status');
  const privacy = el('details', '', 'privacy');
  const privacyTitle = el('summary', '数据与隐私');
  privacyTitle.prepend(icon(document, 'shield'));
  const footer = el('footer', '', 'muted');
  privacy.append(privacyTitle, footer);
  runPanel.append(preferences, primaryActions);
  modelsPanel.append(privacy);
  root.replaceChildren(header, tabs, runPanel, modelsPanel, status);
  function renderControls() {
    const active = runtime.started && !runtime.ended;
    const label = !ready
      ? '读取状态…'
      : busy
        ? '处理中…'
        : downloadFailed || runtime.reportDownloadPending
          ? '重试下载'
          : active
            ? '结束'
            : '开始';
    start.replaceChildren(
      icon(document, active ? 'stop' : 'play'),
      document.createTextNode(label),
    );
    start.disabled = !ready || busy;
    start.classList.toggle('running', active);
  }
  async function refreshControls(force = false) {
    if (disposed || (busy && !force)) return;
    const revision = ++stateRevision;
    try {
      const tabId = await client.activeTabId();
      const next = ToolStateSchema.parse(
        await client.request({ type: 'tools:state', tabId }),
      );
      if (disposed || revision !== stateRevision) return;
      if (activeTab !== null && activeTab !== tabId) {
        downloadFailed = false;
        notice('');
      }
      activeTab = tabId;
      runtime = next;
      ready = true;
    } catch (error) {
      if (disposed || revision !== stateRevision) return;
      ready = false;
      notice(
        error instanceof Error ? error.message : '无法读取运行状态。',
        true,
      );
    }
    renderControls();
  }
  async function perform() {
    if (busy || !ready) return;
    busy = true;
    stateRevision++;
    renderControls();
    try {
      await refreshControls(true);
      if (!ready || activeTab === null) return;
      const tabId = activeTab;
      if (
        downloadFailed ||
        runtime.reportDownloadPending ||
        (runtime.started && !runtime.ended)
      )
        await finish(tabId);
      else await begin(tabId);
      await refreshControls(true);
    } finally {
      busy = false;
      renderControls();
    }
  }
  renderControls();
  function notice(text: string, error = false) {
    status.textContent = text;
    status.className = `status${error ? ' error' : ''}`;
  }
  const cards = { jev, chat };
  const saves: Record<
    ModelSlot,
    { signature: string; task: Promise<boolean> }
  > = {
    jev: { signature: '', task: Promise.resolve(true) },
    chat: { signature: '', task: Promise.resolve(true) },
  };
  const hasKey = (state: RoutingView, slot: ModelSlot) =>
    slot === 'jev' ? state.hasJevKey : state.hasChatKey;
  function setView(state: RoutingView) {
    view = state;
    const destinations = [
      ...new Set(
        (['jev', 'chat'] as const)
          .filter((slot) => modelEnabled(state, slot) && state[slot])
          .map((slot) => new URL(connectionFor(state[slot]!).endpoint).origin),
      ),
    ];
    footer.replaceChildren(
      el(
        'p',
        destinations.length
          ? `题目、材料和选项按需发送至：${destinations.join('、')}。`
          : '当前未启用模型，不会发送题目。',
      ),
      el(
        'p',
        '设置与 Key 保存在本机；Key 仅用于对应接口鉴权，本地存储未加密。',
      ),
      el(
        'p',
        '修改配置不调用模型；点击确认或启用时发送测试请求，开始后按题请求，均可能产生用量。',
      ),
      el('p', '结束后报告下载到本机，不上传；项目无账号系统或分析埋点。'),
    );
  }
  async function readView() {
    const state = RoutingViewSchema.parse(
      await client.request({ type: 'routing:get' }),
    );
    setView(state);
    return state;
  }
  async function load() {
    let state = await readView();
    for (const slot of ['jev', 'chat'] as const) {
      const profile = state[slot];
      const preset = modelPresets[slot];
      if (
        profile?.provider !== preset.provider ||
        profile.model !== preset.model ||
        profile.baseUrl !== preset.baseUrl ||
        Boolean(profile.vision) !== Boolean(preset.vision)
      ) {
        await client.request({
          type: 'model:save',
          slot,
          settings: { ...preset },
        });
        state = await readView();
      }
    }
    threshold.value = String(Math.round(state.reviewThreshold * 100));
    autoAnswer.checked = state.autoAnswer;
    for (const slot of ['jev', 'chat'] as const) {
      cards[slot].load(
        state[slot],
        hasKey(state, slot),
        modelEnabled(state, slot),
      );
      cards[slot].sync(
        modelEnabled(state, slot),
        hasKey(state, slot),
        state.modelStates?.[slot],
      );
      if (state.modelStates?.[slot]?.phase === 'failed')
        cards[slot].details.open = true;
    }
  }
  async function refreshModelStates() {
    const epochs = { ...modelEpoch };
    const revisions = {
      jev: cards.jev.revision(),
      chat: cards.chat.revision(),
    };
    try {
      const state = await readView();
      if (disposed) return;
      for (const slot of ['jev', 'chat'] as const) {
        if (
          pendingToggles.has(slot) ||
          epochs[slot] !== modelEpoch[slot] ||
          revisions[slot] !== cards[slot].revision() ||
          cards[slot].dirty()
        )
          continue;
        cards[slot].sync(
          modelEnabled(state, slot),
          hasKey(state, slot),
          state.modelStates?.[slot],
        );
      }
    } catch {
      /* Keep the last known result while reconnecting. */
    }
  }
  function authorize(settings: Settings): Promise<boolean> {
    if (client.authorizeConnection) return client.authorizeConnection(settings);
    if (client.authorizeRoutes)
      return client.authorizeRoutes({
        jev: ['typesafe', 'vercel', 'jev-agent'].includes(settings.provider)
          ? settings
          : null,
        chat: ['custom', 'openrouter'].includes(settings.provider)
          ? settings
          : null,
        reviewThreshold: 0.8,
        autoAnswer: true,
      });
    return Promise.resolve(true);
  }
  async function toggleModel(slot: ModelSlot, enabled: boolean) {
    const card = cards[slot];
    const pendingSave =
      enabled && card.dirty() ? saveModel(slot) : saves[slot].task;
    const epoch = ++modelEpoch[slot];
    pendingToggles.add(slot);
    card.clearError();
    try {
      let permissionGranted = true;
      if (enabled) {
        card.checking();
        const parsed = SettingsSchema.safeParse(card.config());
        // Only permission prompting needs the UI gesture; validation and the final
        // outcome belong to the background and survive this panel closing.
        const permission = parsed.success
          ? authorize(parsed.data).catch(() => false)
          : Promise.resolve(false);
        if (!(await pendingSave))
          throw new Error('自动保存失败，请修改配置后重试。');
        permissionGranted = await permission;
        if (epoch !== modelEpoch[slot]) return;
      }
      await client.request({
        type: 'model:toggle',
        slot,
        enabled,
        permissionGranted,
      });
      const state = await readView();
      if (epoch !== modelEpoch[slot] || disposed) return;
      card.sync(
        modelEnabled(state, slot),
        hasKey(state, slot),
        state.modelStates?.[slot],
      );
      if (enabled && modelEnabled(state, slot)) card.details.open = false;
    } catch (error) {
      if (epoch !== modelEpoch[slot] || disposed) return;
      card.details.open = true;
      const state = await readView().catch(() => view);
      if (epoch !== modelEpoch[slot] || disposed) return;
      if (state)
        card.sync(
          modelEnabled(state, slot),
          hasKey(state, slot),
          state.modelStates?.[slot],
        );
      else card.setEnabled(false);
      if (state?.modelStates?.[slot]?.phase !== 'failed')
        card.error(
          error instanceof Error ? error.message : '操作失败，请重试。',
        );
    } finally {
      if (epoch === modelEpoch[slot]) pendingToggles.delete(slot);
    }
  }
  function saveModel(slot: ModelSlot): Promise<boolean> {
    const card = cards[slot];
    if (!card.dirty() && !saves[slot].signature) return saves[slot].task;
    const revision = card.revision();
    try {
      const keyInput = card.key.value;
      const request = parseRequest({
        type: 'model:save',
        slot,
        settings: card.config(),
        ...(keyInput ? { apiKey: keyInput } : {}),
      });
      if (request.type !== 'model:save') return Promise.resolve(false);
      const signature = JSON.stringify(request);
      if (saves[slot].signature === signature) return saves[slot].task;
      const epoch = ++modelEpoch[slot];
      pendingToggles.delete(slot);
      card.saving();
      // Dispatch immediately, not on a debounce timer: closing the panel must not
      // discard the last edit. The background vault serializes storage writes.
      const pending = client.request(request);
      const task = (async () => {
        try {
          await pending;
          if (disposed || revision !== card.revision()) return true;
          card.saved(keyInput);
          const state = await readView();
          if (
            disposed ||
            revision !== card.revision() ||
            epoch !== modelEpoch[slot]
          )
            return true;
          card.sync(false, hasKey(state, slot), state.modelStates?.[slot]);
          return true;
        } catch (error) {
          if (revision === card.revision()) saves[slot].signature = '';
          if (
            !disposed &&
            revision === card.revision() &&
            epoch === modelEpoch[slot]
          ) {
            card.error(
              `自动保存失败：${error instanceof Error ? error.message : '请重试。'}`,
            );
          }
          return false;
        }
      })();
      saves[slot] = { signature, task };
      return task;
    } catch (error) {
      card.error(
        `自动保存失败：${error instanceof Error ? error.message : '请重试。'}`,
      );
      return Promise.resolve(false);
    }
  }
  async function begin(tabId: number) {
    try {
      const state = await readView();
      if (
        !(['jev', 'chat'] as const).some(
          (slot) => modelEnabled(state, slot) && hasKey(state, slot),
        )
      ) {
        activate('models');
        notice('请先配置并启用至少一个模型。', true);
        return;
      }
      await client.request(
        parseRequest({
          type: 'routing:preferences',
          reviewThreshold: Number(threshold.value) / 100,
          autoAnswer: autoAnswer.checked,
        }),
      );
      await client.request({
        type: 'tools:open',
        tabId,
        autoAnswer: autoAnswer.checked,
      });
      downloadFailed = false;
      activate('run');
      notice('');
    } catch (error) {
      notice(error instanceof Error ? error.message : '启动失败。', true);
    }
  }
  async function finish(tabId: number) {
    try {
      const raw = await client.request({
        type: 'tools:end',
        tabId,
      });
      if (!raw) {
        notice('当前页尚无本轮报告。');
        return;
      }
      const result = EndResultSchema.parse(raw);
      downloadFailed = false;
      const s = reportSummary(result.report);
      notice(`本轮结束，报告已下载（${s.total} 题）。`);
    } catch (error) {
      downloadFailed = true;
      notice(
        error instanceof Error ? error.message : '报告下载失败，请重试。',
        true,
      );
    }
  }
  void load()
    .then(() => refreshControls())
    .catch(() => notice('读取配置失败，请重新加载扩展。', true));
  void client
    .getPanelView?.()
    .then((page) => {
      if (!viewChosen && !disposed) activate(page, false);
    })
    .catch(() => {});
  const timer = setInterval(() => {
    void refreshControls();
    void refreshModelStates();
  }, 1500);
  const onVisible = () => {
    if (!document.hidden) void refreshModelStates();
  };
  document.addEventListener('visibilitychange', onVisible);
  const unlisten = client.onPageChange(() => {
    ready = false;
    stateRevision++;
    renderControls();
    void refreshControls();
  });
  return () => {
    disposed = true;
    stateRevision++;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    unlisten();
    root.replaceChildren();
  };
}
