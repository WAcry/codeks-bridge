# 五种压缩产物：GPT-6.1 Sol / medium

2026-10-20，America/Los_Angeles。真实调用 OpenAI ChatGPT 订阅的 Responses Lite 接口；所有工作材料均为合成数据。每种材料、每条生成路线各运行一次，最终只给产物 K 的闭卷测验也各运行一次。

**本次两份样本中，详细文字 K2/K3 都比原生 K4 和 handoff K5 保留了更多可精确恢复的细节。** 高密度组 K4/K5 的遗漏集中在早期工具结果；开发组各产物都保留了当前权限与待办。当前结果不支持“原生压缩总是最好”，也不据此更改生产压缩策略。

## 最终闭卷结果

表中只统计有答案题；开发共 89 题，高密度共 150 题。开发的 4 道、高密度的 5 道无答案题，所有产物与两个基线都正确返回 `null`。没有 JSON 解析失败、缺少题号或多余题号。

| 唯一任务上下文 | 开发任务 | 高密度状态 |
|---|---:|---:|
| 空历史基线 | 0/89 (0.0%) | 0/150 (0.0%) |
| 完整历史基线 | 89/89 (100.0%) | 150/150 (100.0%) |
| K1 · Codex 内置 prompt | 65/89 (73.0%) | 0/150 (0.0%) |
| K2 · bridge 标准 prompt | 87/89 (97.8%) | 150/150 (100.0%) |
| K3 · 用户提供的 Claude Code 式 prompt | 87/89 (97.8%) | 150/150 (100.0%) |
| K4 · 原生压缩 | 67/89 (75.3%) | 129/150 (86.0%) |
| K5 · 同一 K4 后 handoff | 68/89 (76.4%) | 129/150 (86.0%) |

已知题与无答案题分开计算，避免把正确弃答加入已知信息保留率。开发题中的复合答案须全部字段正确；无序集合按题目声明比较。原始逐题预期值、回答和判定都在 [results.json](results.json)，不是 LLM 评分。

## 产物大小与生成用量

“产物 tokens”来自服务端 output item attribution：文字只算交付的 assistant 文本，K4 只算 compaction item；不按密文长度 tokenize。output 总数包含 reported reasoning。所有十次生成的 cached input 都为 0；这不是工作会话缓存实验，不能据此推断正常原生压缩的缓存能力。

| 材料 | 产物 | Input | Output 总数 | Reasoning | 产物 tokens | 秒 |
|---|---|---:|---:|---:|---:|---:|
| 开发 | K1 | 31,487 | 2,093 | 0 | 2,093 | 26.697 |
| 开发 | K2 | 32,601 | 5,386 | 0 | 5,386 | 87.138 |
| 开发 | K3 | 32,685 | 5,916 | 0 | 5,916 | 85.224 |
| 开发 | K4 | 31,412 | 1,788 | 0 | 1,788 | 31.577 |
| 开发 | K5 | 7,198 | 2,973 | 0 | 2,973 | 48.559 |
| 高密度 | K1 | 214,870 | 957 | 91 | 866 | 21.177 |
| 高密度 | K2 | 215,984 | 21,058 | 516 | 20,542 | 276.691 |
| 高密度 | K3 | 216,068 | 22,638 | 647 | 21,991 | 298.856 |
| 高密度 | K4 | 214,795 | 16,025 | 0 | 16,025 | 198.010 |
| 高密度 | K5 | 90,877 | 16,434 | 177 | 16,257 | 200.785 |

K5 行只计 handoff 请求。若从原历史开始走完整 K5 路线，还需加上同一材料的 K4 生成；本实验共享 K4，实验总用量只计它一次。原生报告零 reasoning 不证明内部没有推理。长度可帮助解释信息遗漏，不能直接充当质量分数。

| 用量范围 | 调用数 | Input | Output |
|---|---:|---:|---:|
| 开发 · 五份产物生成（共享 K4） | 5 | 135,383 | 18,156 |
| 开发 · 两个基线和五次最终测验 | 7 | 98,684 | 11,244 |
| 高密度 · 五份产物生成（共享 K4） | 5 | 952,594 | 77,112 |
| 高密度 · 两个基线和五次最终测验 | 7 | 342,627 | 26,272 |

测验是实验开销，不是实际使用每次压缩的必需开销。先前方法调试调用另列在 JSON 中；上表不包含它们。Cached tokens 包含在 input 中，不能再次相加。订阅 token 用量不是美元账单。

## 开发任务：总分以外的区别

- 所有 K 都正确保留当前不得提交、push、merge、发布的授权状态（Q002），以及 `review` 的 10 题、`next_steps` 的 5 题、`checkpoint_state` 的 4 题。这个事后按类别检查用于解释总分，不替代完整题集，也不证明 agent 真能完成后续开发。
- K1/K4/K5 没有完整恢复早先的 commit 授权变化（Q079），但当前授权仍未给出、要等用户审查 diff 这两点答对。历史授权轨迹和当前能否行动要分开解释。
- K4 的 Q001 仅项目名大小写不同：`driftship` 对 `Driftship`。冻结评分仍记错；若只宽容这一项，诊断分为 68/89，仍不足以解释与 K2/K3 的差距。没有根据结果修改 gold。
- K2 的 Q087 无法给出 `minimum_chunk_bytes` / `maximum_chunk_bytes` 的精确字段名，虽然 Q088 的边界值正确。正文只保留了 minimum/maximum 的数值；不能把“知道意思”算作知道 wire field 名字。
- 原材料 `src/complete.ts` 使用回执字段 `bytes`（Q028）。[K3](normal-K3.txt) 写成 `path,size,hash,nonempty etag`；[K5](normal-K5.txt) 写成 `path,size,sha256,nonempty etag`。K3/K5 的问答也错。K4 的问答同样给出 `size`，但密文不可见，不能断言错误已经写在 K4 内部。
- Q035 的小数参数处理规则，K2 在初步测验答对、最终测验答 `null`；单次恢复正确不能证明摘要明确写下了规则。所有无答案题弃答正确，也不等于模型从不生成错误的具体答案。

完整失败题及答案都保留，读者可以采用其他明确的评分政策另算，但不能把事后调整悄悄替换为这次原始成绩。

## 高密度状态：遗漏集中在早期工具结果

| 类别（各 30 题） | K1 | K2 | K3 | K4 | K5 |
|---|---:|---:|---:|---:|---:|
| 精确参数 | 0 | 30 | 30 | 30 | 30 |
| 有向关系 | 0 | 30 | 30 | 30 | 30 |
| 工具结果 | 0 | 30 | 30 | 9 | 9 |
| 后续纠正值 | 0 | 30 | 30 | 30 | 30 |
| 任务状态与下一步 | 0 | 30 | 30 | 30 | 30 |

K4/K5 的 155 个回答完全相同。两者对 `tool_history-01` 至 `tool_history-21` 均回答 `null`，对应 epoch 0–6；epoch 7–9 的九道工具题全部正确。[K5 文字](stress-K5.txt)也明确说早期 probe 记录不可用，只保存最后三个 epoch 的结果。这个可见遗漏与答题一致；K4 本身不可读，不能把这句话当作它内部明文的证据。

因此，本次原生路线没有表现为所有类别普遍失败，而是失去了部分工具历史。复述没有在这份样本中补回这些数据。K1 只有 866 个文字 tokens，给出了概括性说明，所有精确数据题都弃答；K2/K3 则在全部 150 道已知题上达到上限。

## 为什么与以前的 K4/K5 优势不同

1. [历史受控高密度实验](../../historical-controlled.md)中，四个 seed × 两次独立压缩的 native default 为 1,200/1,200；标准文字为 795/1,200。那是多个高密度 checkpoint 的统计，不能当作开发对话也必胜的证据。历史详细文字有多份满分产物，单次满分也不与旧均值矛盾。
2. [旧开发 handoff 对照](../../historical-handoff.md)用 `xhigh`、50 项事实的语义评分；本次是 `medium`、89 道有答案的精确问答。旧开发评测没有直接给原生 K 评分。两轮分数不是同一个指标，不能把差异单独归因于 effort、prompt 或模型变化。
3. 同一开发材料，这次 K4 只有 1,788 个产物 tokens，旧 xhigh K 为 3,938；本次 K5 为 2,973，旧用户版 handoff 为 5,738。这与本次细节遗漏同时出现，但没有隔离变量证明因果。
4. K5 生成时还有 U，可以从用户消息补回信息；最终测验没有 U。K5 相对 K4 的变化既可能来自复述，也可能来自 U 和答题过程，不能解释为纯粹的密文转明文质量。
5. 历史实验还有明确反例：对内置 prompt 增加同一条“旧历史会丢弃”的说明后，文字与 native 都达到 600/600。这说明任务边界、保留策略和产物长度很重要，不能把优势简单归因于加密格式。

本次不因结果与预期冲突而重新生成较好的 K；保留所有成功产物。要判断稳定性，应在事先固定条件后增加独立 seed 和重复，而不是对这一个样本继续调到符合预期。

## 精确请求合同

- 模型 `gpt-6.1-sol`；生成和答题均请求 `reasoning: {effort: medium, summary: auto, context: all_turns}`。上游响应将 summary 报为 `detailed`；请求与响应设置均记录。未设置 output 上限或 verbosity，`parallel_tool_calls: false`、`store: false`。
- 公共前缀是 Lite `additional_tools`（`role: developer`）和固定 developer 指令，见 [normal-prefix.json](normal-prefix.json) / [stress-prefix.json](stress-prefix.json)。指令来自公开 Codex 目录；不包含题目答案、个人环境或真实工作历史。
- K1/K2/K3 输入为前缀 + 完整 H + 各自 prompt；K4 为前缀 + H + trigger。K5 为前缀 + U + **同一个 K4** + 当前生产 handoff prompt。题目、gold 和事实索引不进入任何生成请求。
- 每次最终测验独立发送前缀 + **唯一 K** + quiz。文字 K 附固定 summary prefix；K4 按原生 item 发送。无 U、旧 H、生成 reasoning、`previous_response_id` 或 conversation 引用。空/完整历史控制组分别只给前缀和前缀 + H。
- 生成保持 `tool_choice: auto`；闭卷测验固定 `none`。不执行任何工具，不自动重试，不做坏 JSON 修复。最终回答按 `final_answer` phase 优先选取，避免把 commentary 拼入 JSON。
- 开发材料 103 items / 12 条用户消息 / 42 对工具交换；K5 保留全部 12 条用户消息。高密度材料 seed 3617031，每类 200 条共 1,000 条记录、1,200 个随机载荷；本地序列化 JSON 为 220,000 个 `o200k_base` tokens。K5 的 U 保留 19 条用户消息，其中 18 条完整、一条中段截断，近似预算含标记为 64,007；这些本地数量不等于 API usage。

材料由代理整理成虚构对话，并未执行其中叙述的工程操作。冻结的开发 fixture 的 `description` 中 “No model ... was used to build this fixture” 措辞不准确，不能作为非 AI 生成声明；这里保留实测时的原文件字节以核对 hash。该元数据不进入模型请求，也不参与评分。

已逐项核对实际请求中的 input、参数、K4 依赖及产物复用 hash。`results.json` 保存生成时与最终测验时的源码 hash；两版 runner 的生成逻辑相同，后者增加统一闭卷设置和显式复用产物支持。未验证其他模型、provider、跨模型阅读、真实代码续作、多轮连续压缩或缓存命中率。

## 方法调整与所有尝试

两组初次调用都因 Lite 声明缺少 `role` 被 HTTP 400 拒绝，没有 usage。补上 `role: developer` 后，成功生成当前十份产物。这个错误属于测试 runner，不是模型压缩失败。

最初答题保持 `tool_choice: auto`：开发的七次测验完成；高密度的空历史基线请求了 `database_query`，runner 拒绝执行并中止。为保证闭卷，随后统一把两组的所有测验设为 `none`，**复用十份完全相同的产物**，重新执行十四次测验。没有重新压缩、改题或挑选更好的摘要。

| 开发产物 | 初步 auto 测验 | 最终 none 测验 |
|---|---:|---:|
| K1 | 66/89 | 65/89 |
| K2 | 88/89 | 87/89 |
| K3 | 87/89 | 87/89 |
| K4 | 67/89 | 67/89 |
| K5 | 73/89 | 68/89 |

两次产物相同，但答题配置与调用不同，不能把差值单独归因于 `tool_choice`；这同时提醒我们恢复测验本身也会波动。原始初步回答和逐题判定以 `normal-preliminary-*` 及 JSON 的 `preliminary_quizzes_with_tools_auto` 保留，不混入最终统计。

共发起 34 次请求：10 次产物生成、14 次最终测验、7 次初步开发测验、1 次请求工具而被实验中止的基线、2 次 HTTP 400。前三类 31 次均完成；中止基线已有上游 usage，单独记录。HTTP 400 没有可用 usage。没有隐去失败调用或用后来的好结果覆盖旧产物。

## 已提交材料与复跑

- 输入、题目和 gold：[开发完整材料](../../fixtures/normal.json)、[开发题目](../../fixtures/normal-questions.json)、[高密度完整材料与题目](stress-fixture.json)。高密度文件也保存实际 U；可以直接用它重跑，无需重新生成。
- 冻结提示词与来源：[prompts/manifest.json](../../prompts/manifest.json)。K3 基于用户提供的全文，不声称对应某个 Claude Code 官方发布版本。后续核对发现一个示例占位措辞差异：原文 `[User feedback on the error if any]`，实测快照为 `[User feedback on the fix, if any]`；保留实测文本与原始成绩。
- 开发产物：[K1](normal-K1.txt)、[K2](normal-K2.txt)、[K3](normal-K3.txt)、[K5](normal-K5.txt)；高密度产物：[K1](stress-K1.txt)、[K2](stress-K2.txt)、[K3](stress-K3.txt)、[K5](stress-K5.txt)。
- [开发 K4 元数据](normal-K4-metadata.json)、[高密度 K4 元数据](stress-K4-metadata.json)记录原生 item 类型和是否共用同一个 K4。密文及真实服务标识留在本地；元数据不能作为可重放检查点。复跑 K4/K5 要重新生成自己的 K4。
- 每份 `*-quiz-*.txt` 是实际回答；[results.json](results.json)链接它们并记录 hash、逐题预期/实际、分类分数、每次 usage、请求设置、响应设置与时间。公开文件可离线复算评分；不包含凭据、真实会话或设备专有路径。

执行命令和环境参数见[benchmark 用法](../../README.md#手动运行)。本轮五路 runner 固定在[提交 d766451](https://github.com/WAcry/codeks-bridge/tree/d766451c643e6b2e8c270f304a2d2b28ed203872/benchmarks/compaction)；当前入口已采用四路新编号，不能直接将新编号解释为本报告的五路编号。模型生成不保证逐字复现。通常的运行产物在忽略目录中，本次样本是显式整理提交；benchmark 不进入 CI 或 npm 包。

在仓库根目录离线复算已归档的全部最终与初步回答，不调用 API：

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { score } from './benchmarks/compaction/score.mjs';
const root = resolve('benchmarks/compaction/results/2026-10-20-medium');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
for (const c of read(resolve(root, 'results.json')).cases) {
  const questions = read(resolve(root, c.questions_file)).questions;
  for (const q of [...c.quizzes, ...c.preliminary_quizzes_with_tools_auto]) {
    const actual = score(readFileSync(resolve(root, q.response_file), 'utf8'), questions);
    assert.equal(JSON.stringify(actual), JSON.stringify(q.score));
  }
}
console.log('All archived scores match.');
JS
```
