# 架构与约定

本轮改动与演进顺序见 [架构评估](architecture-review.md)，分类和兼容规则见 [题目模型](question-model.md)。

## 为什么分这几层

维护平台的人应只需要理解它的 HTML，维护模型的人不应修改 DOM 代码。两者通过 Zod 校验的 `Question` / `Suggestion` 结构衔接。

| 层         | 负责                               | 不负责                        |
| ---------- | ---------------------------------- | ----------------------------- |
| Core       | 运行时 schema、消息协议、能力判定  | 平台和供应商细节              |
| Platform   | 页面匹配、提取、诊断；独立动作模块 | Key、API                      |
| Solver     | 分类、求解模式与领域提示           | DOM、网络、凭据               |
| Provider   | 输入映射、网络调用、响应验证       | 网页与扩展权限                |
| Controller | 扫描快照、生命周期、取消、凭据     | 页面选择器                    |
| UI         | 题目展示、设置和用户操作           | 直接访问页面 DOM 或供应商 API |

## 生命周期

1. 用户点击扩展图标，通过 `action.default_popup` 打开 `popup.html`，获得 activeTab 临时授权；保存配置、选择自动作答模式后启用网页悬浮球。配置窗口不持有题目会话，关闭或翻页不会取消网页工作。
2. 点击「开始」后，后台注入 IIFE 内容脚本至主文档的隔离环境。脚本显式注册 `globalThis.AutofferContent`，第二次读取绑定到第一次注入返回的 `documentId`。扫描可重复注入；全屏工具实例通过单独的隔离全局保留，避免重复监听器。
3. Registry 必须唯一匹配，对模板和自定义 Adapter 的返回值统一执行 schema 校验。题目分类保留领域、形式、意图，kind 为兼容交互协议。
4. 后台存储扫描 ID、文档 ID、题目快照。最多缓存 10 个标签页；扫描快照仅存内存；结束后的报告单独存入 storage.session。
5. 网页会话对稳定的新题自动请求建议，消息仅带标签页、扫描 ID 和题目 ID。后台从缓存取题，前后重新扫描以防页面变化。
6. 后台读取 Key 并调用 Provider。总请求有 90 秒超时（Jev 单次 15 秒、Chat 单次 60 秒）、手动停止、每标签页单请求、全扩展最多 3 个并发请求。保存设置会中止旧渠道的在途请求。
7. 页面变化、标签页关闭、扫描重做会使旧快照失效；延迟返回的答案丢弃。Service worker 重启后需重新识题。

Jev HTTP 429/529 展示可重试状态，当前不自动重试，以避免隐藏用量。多选采用每个选项独立 `Noul`，不把独立概率伪装为整题置信度。以每项 max(p, 1-p) 对比用户阈值；任一项不达标、恰为 0.5 或集合为空时整题跳过，只有全部判定达标才自动填入完整选项集。单选使用 `Choice` 并检查选项集合、概率范围、总和和选中项。

页面读取错误按阶段分类：`PAGE_PERMISSION`（权限）、`INJECT_FAILED`（注入）、`SCANNER_MISSING`（脚本入口）、`SCAN_INVALID`（返回结构）、`PAGE_CHANGED`（导航）。不向 UI 回传原始浏览器异常中的考试 URL 或凭证。

## 消息与凭据边界

后台只接受扩展自己的消息。设置及打开全屏工具仅允许本扩展的 `popup.html` 主文档；扩展 UI 可能带 sender.tab，因此必须先判断精确 UI URL 与 frameId，再区分网页内容脚本，不能仅根据 tab 的存在授予权限。用户启用工具后，其主文档 content script 可发送 scan/suggest/cancel/report:save。授权绑定 tabId + documentId + frameId=0，强制使用发送者 tabId，不能读写设置。网页会话仅能由配置弹窗启用；网页控制按钮要求真实用户点击，没有页面 DOM 事件转发接口。消息经过 Zod 校验。

Key 存在 `chrome.storage.local`，读取权限设置为 `TRUSTED_CONTEXTS`。UI 只收到 `hasKey`，内容脚本从不接触 Key。固定渠道及用户保存的 HTTPS 自定义基础地址由后台解析；请求前检查该域名的浏览器权限，禁用重定向和 Cookie。日志/错误不回显供应商原始错误响应。403 的已知账户验证错误单独映射，其他 403 不再武断归因为无效 Key。

渠道定义位于 `core/connections.ts`：TypeSafe 官方使用 `/v1/systemone` 与 `jev-latest`；Vercel 使用 `https://ai-gateway.vercel.sh/typesafe/v1/systemone` 与 `typesafe-ai/jev`。Vercel 的 TypeSafe 兼容协议保留 `noul`、`choice` 与原响应结构，无需引入 AI SDK 或增加后端。[协议来源](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)。

Jev Agent 使用独立渠道 ID `jev-agent`、固定端点 `https://jev-agent.com/api/v1/systemone` 和默认模型 `jev-latest`。复用 Jev Provider，state 序列化为 JSON 文本，发送前限制 8000 字符 / 10 个判断项。其 HTTP 429 单独映射额度不足；有效 quota 字段作为结果提示展示，不依赖额外余额查询。该主机使用已有可选权限机制，保存时只申请 `https://jev-agent.com/*`。[该服务协议与限制](https://jev-agent.com/docs)。

`background/vault.ts` 按渠道隔离 Key，自定义渠道进一步按规范化完整 Base URL 隔离，串行处理存储修改。旧版单个 `apiKey` 只迁移到 TypeSafe；双配置存于 routingConfig；旧版当前活跃配置迁移到对应槽位。回退只使用目标槽位自己的凭据。

OpenRouter 使用 `https://openrouter.ai/api/v1/chat/completions`，自定义渠道在 Base URL 后追加 `/chat/completions`。统一非流式 `messages` 请求，仅提取完整 `stop` 响应中的 JSON 答案并核对选项集合；不支持工具调用、Responses 或 Messages 协议。协议参考 [OpenRouter 官方文档](https://openrouter.ai/docs/api/reference/overview)。

`content/session.ts` 在页面内维护自动状态机：唯一可见题目稳定后请求模型；相同 ID 去重/缓存，切题中止旧请求并丢弃旧结果。请求取消必须完成后才能发起新请求，避免迟到的 cancel 取消新题。页面隐藏和单题错误不关闭识别；只有显式暂停/结束停止运行。关闭配置弹窗不会影响会话。

`platforms/runtime.ts` 根据唯一匹配的平台与声明的能力分派选答/翻页，内容层不导入具体平台。没有 actions 的平台仍可识题和生成建议；没有写入能力时保留参考结果并等待手动处理。牛客由 index 组合 extractor 与 actions，`platforms/nowcoder/actions.ts` 分离选答与纯翻页。低于阈值只执行纯翻页，不改选项；缺少适用模型或不支持的题只纯翻页；图片题走视觉 Chat，主观/编程题显示参考答案并等待手动填写。页面身份校验与可作答能力判断分开，翻页不要求该题可生成答案；多选的 needsReview 不等于低置信度，由 Provider 的 lowConfidence 标志区分。连续模式没有题数上限，只允许精确「下一题」按钮，末题选答或跳过后继续观察；仅完整、无跳过的题型可调用 nextSection，不回退到提交按钮。

`content/tools.ts` 提供 Shadow DOM 悬浮球、外圈状态动画及隐藏/恢复控制，跟随 fullscreen 元素并使用可用的 popover 顶层。轮询也能感知开放 Shadow DOM 中的题干变化。`background/page-tools.ts` 使用 storage.session 保存 tabId/documentId 授权；哈希切换即使带 loading 也不撤销同文档授权，新文档的 sender.documentId 无法冒用。保存模型配置会暂停现有会话并清空答案缓存。没有监测规避逻辑。

## 双模型路由、图像和报告

`solvers/policy.ts` 集中题目分类、求解模式与领域提示，Jev/Chat 共用策略。`core/routing.ts` 根据策略与已配置凭据决定路线，模态保持独立。`providers/index.ts` 对纯文字客观题优先 Jev；缺失、请求失败、超时、低确定度或需复核时转 Chat 一次。图片/文本自由回答直接 Chat。全局取消不能触发回退。最终低确定度跳过，未知确定度复核，两个模型都失败则记录该题错误并继续观察新题。

`background/images.ts` 检查活动标签后临时截取可见页，按平台图像矩形用 OffscreenCanvas 裁剪；只返回裁剪的 data URL。Controller 前后重新扫描，拒绝题目/文档/图像几何变化。完整截图不传给 Provider。Chat 图片需要 vision 开关；每题最多 6 图、4 MB，尺寸缩至最长边 1600。图像 data URL 与模板 ID 一一核验；不把原图 URL、几何元数据发送给模型。

`core/report.ts` 定义有界的本轮报告与 Markdown 导出。`content/session.ts` 记录每题路线、状态、参考答案与耗时；暂停保留，结束快照，结束后重新开始清空本轮。报告由绑定主文档发送到后台，或由弹窗执行结束动作获取，存入 storage.session。导出内容按不可信文本放入动态长度代码围栏，无远程上传。

## 下一步扩展点

- 新平台：实现 `PlatformAdapter` 或声明式模板，注册并加入 fixture。
- 新 Provider：实现 `AnswerProvider`，增加后台显式选择和对应主机权限，明确告知数据目的地。
- 视觉布局：增加脱敏的真实页面样例。当前只支持完整可见且已加载的图像区域，不滚动拼接。
- iframe 支持：单独设计按需域名授权、frameId/documentId 绑定与合并顺序，避免简单使用全站权限。

目前 UI 使用原生 TypeScript/DOM，构建用 esbuild，测试用 Node test runner + JSDOM。没有运行时 UI 框架与后端依赖。接口允许将来替换 UI 或构建工具而不重写平台模板。

## 模型配置与启用生命周期

`routingConfig` 将 jev/chat 的已保存配置与 jevEnabled/chatEnabled 分开保存；旧配置根据对应 Key 的存在情况补齐启用状态。关闭只更新布尔状态，不清空配置或 Key；readRoutes 只返回启用模型的推理凭据，另提供 keysPresent 用于界面显示。

弹窗在字段变化时立即发送 model:save，通过 SettingsDraftSchema 逐模型自动保存草稿并设为关闭。没有保存按钮，自动保存不申请权限也不调用 model:toggle；草稿不校验模型名称、URL 和 Key 格式。model:toggle 才使用严格 SettingsSchema / ApiKeySchema 校验并检查权限，调用 providers/verify.ts 发送最小测试请求，成功后启用。格式错误、缺少 Key、拒绝权限或 API 验证失败都保留配置并告警。关闭请求只携带 slot + enabled=false，不依赖编辑中的表单。Vault 串行保存，避免两个模型同时修改互相覆盖。删除 Key 同时停用对应模型。网页内容脚本无权调用这些消息。

表单保持可编辑，input/change 事件去重并自动保存，立即发送消息避免关闭弹窗时丢失最后输入。后台串行落盘，前台忽略旧保存回执，保留持续编辑的新内容。仅手动开关触发校验与请求，并先等待最新草稿保存完成。自动保存只处理修改的模型，运行按钮使用已保存且启用的配置，运行阈值和自动模式通过 routing:preferences 单独更新。UI 对每个模型使用操作序号，保存或授权期间关闭会使旧的启用回调失效；保存期间继续编辑也不会被旧结果覆盖。更新配置/开关会取消当前请求并暂停网页会话，需手动开始或继续答题。验证使用独立的一次 HTTP 请求而不经过推理路由，因此不会回退或发送题目；HTTP 成功且响应符合对应协议才启用。验证最长 15 秒，响应最多 64 KB，不代表正式题目求解或视觉能力已验收。Vault 在存储队列之外等待网络，通过每模型的操作序号和 AbortController 拦截关闭、更新配置或删除 Key 后的迟到响应；等待验证不阻塞关闭和其他模型保存。

弹窗关闭前已输入的配置交由后台保存，重新打开恢复。模型验证状态单独存入 storage.local 的 modelStates（idle/checking/enabled/disabled/failed、更新时间、经过脱敏的失败原因）；新编辑清除旧失败。后台完成验证后写入状态，UI 只在对应卡片显示一次，并在弹窗可见时重新同步。Service worker 重启后，无在途检查对应的 checking 状态转成明确的中断提示。弹窗记住上次页面，但不因恢复页面触发付费请求。

AstraFlow 配置卡使用 `core/connections.ts` 中的固定预设（ModelVerse Base URL、deepseek-v4.1-flash），UI 只接收 Key，右侧确认按钮复用 model:toggle 校验流程。打开时初始化固定配置，不申请权限或调用模型，不提供旧自定义模型的兼容入口。后台仍使用通用 Chat 协议，Key 按地址隔离。

Jev 配置同样使用固定预设（TypeSafe 官方、jev-latest），不提供其他渠道表单。两张卡片共用 Key + 确认组件，确认点击先等待最新自动保存，再请求验证并启用。确认中按钮不可重复点击，输入和关闭开关保持可用。

题型衔接由 PlatformActions.nextSection 提供，内容层只在 section.index 从 1 连续覆盖到末题且所有记录均为 answered 时调用。跳过、失败、参考答案和未观察的题目都阻止自动跨型；计数独立于整轮跳过历史，进入新题型才重置。牛客只允许明确的下一题型按钮；提交本题型与确认弹窗暂未取得实际 DOM，保持等待，不作为导航回退。最多记录 1000 个当前题型身份，超限不自动跨型。

## 卡片控制与自动报告

卡片以 started/ended 状态显示唯一「开始 / 结束」按钮；悬浮球仅展示进度与最多 60 条去重日志。tools:end 在后台先结束会话并保存报告，再由 report-downloads.ts 调用 downloads API，以 saveAs=false 下载到默认下载目录并等待 complete。下载 ID 和本轮身份保存在 session 中，重复结束或弹窗重开复用下载；失败可重试。页面内容脚本不能直接请求下载。

## ACM 编辑器与判题

后台在请求模型前通过 `PageTools.code` 注入独立 `acm-main.js`，取得当前编辑器语言和短期操作凭据；模型仅收到语言，不收到原有代码或凭据。MAIN 世界仅持有编辑器对象、题目语义快照和版本，没有模型 Key 或网络客户端。原文档授权、运行状态、题目、模型、语言和编辑版本都要匹配，才允许回填；停止状态通过同步 DOM 标记和后台状态双重检查。

`content/code-runner.ts` 驱动回填、自测、单题提交和轮询。结果必须来自点击后新增的运行 ID，且用例通过率为全部通过。失败、超时或取消不自动重放写入/提交；只有判题确认后会话才增加已答。报告的“未交卷”不表示单题代码未提交。该流程的真实页面写入和成功判题尚待验收，不能从只读识别推断已完成作答。
