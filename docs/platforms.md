# 平台模板接入

平台是 `PlatformAdapter`：元数据、`matches(context)`、`extract(context)` 及可选 `actions`。普通页面使用 `defineTemplate()`；特殊结构可以实现同一接口，保持核心与 UI 不变。

## 新平台最小单元

```sh
npm run platform:new -- example "示例平台"
```

生成：

```text
src/platforms/example/index.ts
src/platforms/example/README.md
tests/fixtures/example.html
tests/example.test.ts
```

脚手架中的 `example.example.invalid` 是占位域名。请替换为实际验证域名，收紧路径，并添加能唯一标识测评页的 DOM marker。不要仅凭页面含有 radio 就判定平台。

在 `src/platforms/registry.ts` 加入导入并添加到 `platforms` 数组。平台 ID 必须唯一；多个模板同时匹配会报诊断，不根据数组顺序猜测。

## 声明式模板

```ts
export default defineTemplate({
  meta: {
    id: 'example',
    name: '示例平台',
    version: '0.1.0',
    status: 'experimental',
  },
  match: {
    hosts: ['practice.example.invalid'],
    pathPrefix: '/practice/',
    marker: '#assessment-root',
  },
  rules: [
    {
      root: '.question.single',
      classification: {
        domain: 'unknown',
        format: 'single-choice',
        intent: 'knowledge',
      },
      stem: '.question-title',
      material: '.local-passage',
      options: {
        root: '.choice',
        text: '.choice-text',
        label: '.choice-label',
      },
    },
  ],
});
```

`root` 在文档中查找，其余选择器默认相对该题目块；选项的 `text` 和 `label` 相对选项块。`sharedMaterial` 是文档级选择器，用于同一阅读材料下的多个问题。若每题对应不同材料，使用自定义适配器关联，不要把全页材料填给每道题。

新模板使用 `classification`，分别描述领域、题目形式和作答意图，见 [题目模型](question-model.md)。旧模板的 `kind`（single / multiple / text / personal）保持兼容，新模板由引擎自动投影生成。分组规则不应重叠；引擎遇到重复题块会返回诊断。需要更复杂判别时实现自定义适配器，不把平台分支写入后台或 Provider。

富文本位于开放 Shadow DOM 时，可在模板顶层设置 `readOpenShadowRoots: true`。选择器仍匹配外层可见题目/选项容器，引擎只在这些范围内递归读取开放 shadow root，并检测其中的图片、公式。隐藏宿主内的内容会被过滤；不读取封闭 shadow root，不改变页面的 `attachShadow` 行为。参考牛客模板。

## 提取契约

- 题干必须完整，包含否定词、多选要求、限定条件。
- 选项保留 DOM 顺序，并生成局部稳定 ID，不能只靠“A/B/C”推断对应关系。
- 关联材料进入 `material`。输入框中候选人的已填答案不属于题目。
- `hasVisual` 标识图片、SVG、canvas、MathML、音视频，与题型独立。`visuals` 提供匹配题目范围内的图像 ID、内容指纹、选项关联、矩形、加载和遮挡状态；不暴露源 URL。图像路由直接使用启用视觉能力的通用模型，无法定位或音视频则跳过。题目身份排除坐标等易变字段，截图前后仍校验几何状态。
- 默认引擎不读取 CSS 背景图、封闭 Shadow DOM 或跨源 iframe；有这些内容的平台必须自行检测、添加警告或暂不支持。
- 隐藏、`aria-hidden`、脚本与样式文本被过滤。不要把答案提示、导航、用户资料加入题干。
- `warnings` 表示题目内容可能不完整，会阻止发送模型；页面级诊断放在 `Scan.warnings`。
- 题目 ID 随题干/材料/选项等内容变化。它用于 UI 关联，不能作为安全摘要；后台另外比较完整问题和文档 ID。

## 合入所需证据

至少覆盖：一个正常题、一个相关材料题、不匹配页、缺少题干/选项、图片题，以及平台特有边界。模板说明中记录实际验证日期、样例来源、支持题型和限制。

尚未拿到真实页面时，可以提交 `experimental` 模板及合成样例，但不应标注“已支持”或升级为 `verified`。不要为前程无忧、北森等平台凭猜测填写选择器。

## 可选动作与统一运行接口

只识题的平台不需要 actions。自动模式仍会请求建议，报告记为 reference，等待手动操作；没有翻页能力时不会把平台误判为末题。公共内容脚本通过 `platforms/runtime.ts` 调用平台，不加入特定平台分支。

需要自动选答时，按牛客的结构组织：

```text
platforms/example/
  index.ts       # 组合 extractor 与 actions，提供一个注册入口
  extractor.ts   # matches / extract，只读
  actions.ts     # DOM 交互与验证，可以导入 extractor，不导入 index
  README.md      # 分类、能力、验证记录、fixture 来源、维护人
```

`PlatformActions` 声明：

- `answerKinds`：已经支持自动写入的 single / multiple；仅列出已实现并测试的类型。
- `assertReady(context, expected)`：检查平台特有的阻塞弹窗、页面状态；不能产生页面写入。
- `apply(context, question, suggestion, signal, reviewed)`：可选，写入并回读验证，再翻到下一题；返回 advanced 或 section-end。
- `skip(context, question, signal)`：可选，只翻页，不改已选答案。返回值与 apply 相同。

apply 和 skip 是独立能力。只实现 skip 的平台仍只能手动选答；实现 apply 但没有 skip 时，低置信度会保留记录并等待手动切题。apply 当前包含翻页，所以它不适用于“只写入但仍停留当前题”的实现；此场景需要后续扩展结果协议，不得虚报 advanced。

通用 runtime 检查唯一平台、当前题完整快照、取消、题目可推断性、复核状态和选项 ID。平台 actions 仍必须在每次异步等待和点击前确认题目未变、信号未取消，验证控件可见且未被遮挡，最后回读选中状态和新题身份。模板不提供提交/交卷能力。

## 共用测试契约

脚手架生成的测试使用 `tests/platform-contract.ts` 中的 `assertPlatformContract(adapter, context)`，检查 schema、平台 ID、题目/选项 ID 唯一性、读取稳定性、DOM 不变和错误域名。还必须编写实际题干、选项、分类、材料等断言；共用契约不能证明提取内容正确，也不能替代真实 Chrome 中的动作验收。

Registry 对自定义提取器也执行 ScanSchema 校验，并拒绝重复平台注册 ID、多个匹配及返回其他平台身份。新增平台只需在同一个 registry 注册，无需修改内容层或模型层。
