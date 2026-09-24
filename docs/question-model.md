# 题目分类与求解扩展

平台、领域、题目形式和输入模态彼此独立。同一个牛客页面可能出现专业知识题或行测题；专业知识题也可能是单选、判断、编程或图片题。不要为每种组合创建一个平台插件。

## 统一题目

`core/classification.ts` 定义三个分类轴，`Question.classification` 承载分类：

| 字段    | 值                                                | 含义                                                 |
| ------- | ------------------------------------------------- | ---------------------------------------------------- |
| domain  | unknown / professional / aptitude / psychological | 未知 / 专业测试 / 行测 / 心理相关                    |
| format  | single-choice / multiple-choice / true-false      | 单选 / 多选（含不定项）/ 判断                        |
| format  | fill-blank / subjective / programming             | 填空 / 主观 / 编程                                   |
| format  | scale / ranking / unknown                         | 量表 / 排序 / 未知；可识别记录，尚未实现通用求解     |
| intent  | knowledge / self-report / unknown                 | 有知识答案 / 本人情况与偏好 / 尚未确认               |
| subject | 可选短文本                                        | 如计算机、机械、数量关系、言语理解；来自明确页面信息 |

图像仍使用 `hasVisual` / `visuals`，不塞入 format。单选和多选都有可能包含图片。`typeLabel` 保留平台原始题型标签，如“不定项”。

```ts
classification: {
  domain: 'professional',
  format: 'true-false',
  intent: 'knowledge',
  subject: '计算机',
}
```

分类应来自平台题型、章节标记或已经验证的模板上下文。不能仅凭域名判断领域，也不能靠“你认为”等模糊关键词把题目判为个人问卷。无法确认 domain 时使用 unknown；无法确认作答意图时使用 unknown，并等待手动处理。本轮未实现 AI 自动领域分类。

心理学知识题可以是 `psychological + single-choice + knowledge`；性格问卷可以是 `psychological + single-choice/scale + self-report`。后者不会调用模型替候选人编造经历或偏好。当前只是明确分流，还没有问卷评分、人格画像或量表解释模块。

## 兼容旧模板

`kind` 暂时保留为旧交互协议：single / multiple / text / personal。新声明式模板只写 classification，引擎用 `interactionKind()` 自动投影；自定义提取器需返回一致的 kind 和 classification，冲突会被 schema 拒绝。

旧模板只写 kind 仍可运行：single → single-choice，multiple → multiple-choice，text → subjective，personal → self-report；domain 统一 unknown。`classificationOf()` 是唯一兼容入口。不要在 Provider 中解析中文 typeLabel 或另写一套分类推断。

判断题在分类中保留 true-false，交互仍走两个选项的 single，必须读取实际选项 ID，不假定 A=正确。填空、主观、编程目前统一返回 answerText 参考答案；它们没有实现结构化多空填写或编辑器写入。

分类参与题目内容指纹与前后快照比较，改变分类会使旧建议失效。本轮报告也保留分类；旧报告没有该字段仍可读取。

## 求解与模型传输

`solvers/policy.ts` 是本地纯函数：选择 choice / reference / manual 模式、优先模型协议，并提供领域和题型提示。`providers/` 负责具体 HTTP 协议、Key 使用、结果解析和校验；两个 Provider 共用求解提示。`core/routing.ts` 与 Provider Router 保持已有的一次回退和超时机制。

| 情形                                            | 当前行为                                 |
| ----------------------------------------------- | ---------------------------------------- |
| 文本知识选择题、判断题                          | Jev 优先，按原规则回退 Chat              |
| 含图片的知识选择题                              | 启用视觉能力的 Chat                      |
| 填空、主观、编程                                | Chat 参考答案，手动填写                  |
| self-report / 未知意图 / 未支持的量表和排序求解 | 不调用模型，按平台能力等待手动处理或跳过 |

专业与行测策略目前只是可维护的提示与路由规则，不代表已经引入专用数学引擎、题库或验证过领域正确率。扩展时先明确需要：增加 subject，调整求解提示，还是新增答案结构；不要把所有学科都升级成新的枚举和 Provider。

新增真正不同的题目形式时，需要同时更新 classification、interactionKind、求解模式、Provider 输出校验、平台动作和报告测试。排序答案不能伪装成无序 selectedIds；多空答案不能在没有控件绑定时直接写入页面。等有对应 fixture 后再引入专用答案结构。
