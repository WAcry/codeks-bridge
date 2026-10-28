# 压缩与交接 benchmark

这是手动运行的质量实验，不进入 CI，也不影响 bridge 的运行时。材料都是合成数据；不读取本机会话、登录文件或真实项目。目标是比较压缩后可恢复的任务信息，保留可重复的方法、输入和实测产物，供以后换模型重跑。

## 固定的四条路线

`H` 是完整历史，`U` 是保留的用户消息，`K` 是交付给下一次请求的压缩产物。

| 产物 | 生成请求 | 类型 |
| --- | --- | --- |
| K1 | H + [Codex 内置 prompt](prompts/builtin.txt) | 文字 |
| K2 | H + [用户提供的 Claude Code 式 prompt](prompts/claude-code.txt) | 文字 |
| K3 | H + `compaction_trigger` | 原生检查点 |
| K4 | U + **同一份 K3** + [当前 handoff prompt](prompts/handoff.txt) | 文字 |

K2 强调记录所有真实用户消息，基于用户提供的全文，不声称与某个 Claude Code 发布版本逐字相同。核对时发现冻结快照有一处示例占位措辞不同：原文 `[User feedback on the error if any]`，实际为 `[User feedback on the fix, if any]`。实测使用后者；保留实测字节。K4 使用当前生产 handoff 的快照，包含 text-only 约束。[manifest.json](prompts/manifest.json) 记录各份 prompt 的来源和 UTF-8 字节 hash；调整生产代码不会自动改变实验文本。

**四种产物的最终问答全部只使用各自产物，不附带 U、H 或生成过程的 reasoning。** K4 生成时仍使用 U，以复现 bridge 的交接输入。因此 K4 是整个交接流程的测试，不能把它相对 K3 的变化全部归因于密文转明文。

所有请求使用同一份固定基础指令和工具声明；这些公共协议前缀不包含题目答案或原任务历史。文字产物通过固定的 Codex summary prefix 作为一条用户消息载入，原生 K3 作为原生 item 载入。每次问答都是独立请求，没有 `previous_response_id`，不会串联前一组回答或 reasoning。**评分请求固定 `tool_choice: none`**，确保闭卷问答无法向工具查询答案；这个设置只影响控制组和恢复测验，不改变压缩及 handoff 生成。默认另测空历史和完整 H 两个基线，分别检查猜测与题目本身的可回答性。

## 两种材料

### 高密度状态保留

[fixture.py](fixture.py) 从固定 seed 生成五类记录：精确参数、方向关系、工具结果、后续纠正值、任务状态与下一步。标准配置每类 200 条，合计 1,000 条记录，分布在十个阶段；填充到 220,000 个本地 `o200k_base` 序列化 JSON tokens。这个数不是服务端 input usage。

测验固定每类 30 题，加 5 道不存在记录的题。生成压缩产物时不发送测验、标准答案或评分元数据。问答按完整 canonical string 精确匹配；缺字段不等于正确回答 `null`。这适合测量精确信息保留，但不等于编程能力评估，也不能用 150 题全部正确证明 1,000 条记录全部无损。

K4 的 U 由 [retention.py](retention.py) 生成，使用 Codex V2 文本用户消息的 64k 近似预算：`ceil(UTF-8 bytes / 4)`，优先保留较新的消息，边界消息保留首尾。它只覆盖合成文本材料，不模拟图片、通知或完整客户端历史策略。截断标记在预算之外，近似 token 预算不能当成精确 tokenizer 上限。

### 开发任务 handoff

[normal.json](fixtures/normal.json) 是虚构 TypeScript 上传 CLI 的开发对话，包含 103 个 items、12 条用户消息和 42 对工具调用/结果。代码、路径、输出和操作都是叙事材料；runner 不访问其中的路径，也不执行其中的命令。

材料覆盖设计被替换、提交授权被撤回、旧测试通过后发现新问题、修复仍待执行等状态。材料由代理整理；冻结 fixture 的 description 中“No model ... was used”措辞不准确，该元数据不进入模型请求或评分。[normal-questions.json](fixtures/normal-questions.json) 将这些事实细化成可核验的问答，包括数值、字段名、权限、最终设计和验证状态，并增加不存在信息的题目。

问答要求明确的 JSON 类型和格式；无序集合按题目约定比较，不能用自由文本措辞差异代替事实错误。逐题结果包含预期与实际答案，便于人工复核。它测试从产物恢复工作状态，没有真的让接手 agent 完成后续开发。

## 手动运行

需要 Node >= 22.18。只有生成高密度材料时需要 Python 和单独的 tokenizer 依赖；不增加项目运行时依赖。

在仓库根目录：

```sh
python3 -m venv benchmarks/compaction/.venv
benchmarks/compaction/.venv/bin/python -m pip install -r benchmarks/compaction/requirements.txt
mkdir -p benchmarks/compaction/runs/fixtures
benchmarks/compaction/.venv/bin/python benchmarks/compaction/fixture.py \
  --seed 3617031 --density 200 --tokens 220000 --retained-tokens 64000 \
  --out benchmarks/compaction/runs/fixtures/stress.json
```

先离线查看计划，不读取凭据、不调用网络、不生成结果目录：

```sh
node benchmarks/compaction/run.mjs \
  --fixture benchmarks/compaction/runs/fixtures/stress.json \
  --model gpt-6.1-sol --out benchmarks/compaction/runs/stress-medium

node benchmarks/compaction/run.mjs \
  --fixture benchmarks/compaction/fixtures/normal.json \
  --questions benchmarks/compaction/fixtures/normal-questions.json \
  --model gpt-6.1-sol --out benchmarks/compaction/runs/normal-medium
```

实际调用时，在环境中提供 `BENCHMARK_URL`（完整 `/responses` URL）和 `BENCHMARK_HEADERS`（请求 headers 的 JSON 对象），再给命令加 `--execute`。按目标服务准备鉴权；runner 不绑定某种登录机制、账号或本机目录。它发送 Responses Lite；测试其他协议的模型时可使用支持该模型的 bridge。K3/K4 要求目标支持原生压缩，仅测试文字路线可用 `--products K1,K2`。

默认使用 `reasoning.effort: medium`、`summary: auto`、`context: all_turns`，生成时保留 `tool_choice: auto`，不设置输出 token 上限。`--options FILE` 可覆盖请求参数，`--instructions FILE` 可替换基础指令，`--controls none` 可省略基线。更换模型时记录这些变化，不自动假定它支持相同参数。

原生压缩与所有文字生成分别记 usage。若文字生成意外调用工具、流未成功结束或接口拒绝请求，该运行直接失败并保留记录；不会执行工具、自动换 prompt 或偷偷重试。失败时先调查原因，新的尝试使用新目录，报告中保留失败尝试。

已有完整产物但需要重新测验时，可以给原命令加 `--reuse-products OLD_RUN_DIR`，并指定新的 `--out`。runner 核对产物定义、模型、材料、prompt、参数和题目，原样复用已成功生成的产物，包括同一份 K3；不重新压缩，也不覆盖旧测验。新记录明确标记复用来源，旧生成 usage 不计入这次新增调用。

原始产物保存在 `runs/`（已由 Git 忽略），包含请求体、事件、原生密文、文字、usage、耗时和参数快照；不会保存请求鉴权 headers。不要将运行目录直接提交。公开报告只整理合成文本、去标识化评分和必要数值，原生密文及服务端标识留在本地。

## 结果怎么读

- 分开看已知事实正确率、无答案题是否返回 `null`、各类别错误，以及空历史和完整历史基线。开发题还要复核权限与工作状态，不能仅看总分。
- native、handoff、quiz 分开计算 usage。问答基线和恢复测验是实验成本，不是产品每次压缩的必需开销。K4 的完整生成成本包含 K3 和 handoff，但共享 K3 的实验总成本只计算它一次。
- 同时记录产物生成 tokens 和恢复时占用的 input tokens。前者优先取服务端 output item attribution，排除生成 reasoning；后者从测验 input 中扣除新输出 item 的 input framing，再减去同条件空历史基线。原生 item 的 input attribution 可直接交叉核对。文字的 summary prefix 和 framing 可能使两种计数不同，两种口径分别报告。
- cached input 已包含在 input tokens 中。总 output 通常包含 reasoning。长度只是辅助信息，不能替代质量评分，也不能按密文字节数推断信息量。
- 每轮只有一份检查点时，150 道答案不是 150 次独立压缩实验。比较稳定性需要固定参数后增加 seed 和独立重复，不在看到坏结果后只保留重跑成绩。
- 这是质量实验，不模拟完整工作会话的缓存路由。缓存 usage 和耗时可记录，但不能据此断言正常客户端的缓存命中率或通用延迟。

## 实测记录与离线核验

[四路压缩报告](results/2026-10-20/README.md)记录 GPT-6.1 Sol / medium 的八个高密度 seeds 和同一开发历史的三次独立生成。主表按讨论事后剔除一个极端低分的整案例，四路线统一使用七个高密度 seeds；完整八样本和全部原始产物保留在附录。报告并列展示正确率、产物 output tokens 和回放 input tokens。

[Opus K2 补充报告](results/2026-10-20-opus/README.md)复用同样材料，只测试详细文字摘要。记录六份成功高密度产物、两次生成拒绝、三个开发重复，以及原生 Messages 下默认 5 分钟缓存的实际命中。内容评分与严格 JSON 格式评分分开；其完整历史对照使用 auto 以复用生成前缀，专用调度与上述通用 Responses runner 有所不同。

[Gemini 4 Argon / high 对照](results/2026-10-28-gemini/README.md)复用八份高密度输入和三个开发重复，比较当前 bridge summary 与用户提供的 Antigravity prompt。两者分别标记 S、A，避免与历史 K2 混淆。该轮只新增文字摘要与问答，历史 GPT 原生压缩、handoff 和 Opus 结果从已保存记录读取。

[compare-prompts.mjs](compare-prompts.mjs) 通过 Responses 接口运行文字 prompt 对照；输入、题目、公共指令和 prompt 的 hash 固定在计划中。每份材料先做完整历史、空历史两个答题对照，再连续生成两种摘要；两种 prompt 的先后次序按案例交替。完整历史对照使用 auto，其余对照与恢复问答使用 none。相同开发历史的重复共享基线，闭卷问答仍只含 K。失败保留，不自动重试。Gemini 原生连接由单独运行的 bridge 配置提供，端点和鉴权不写进计划。

```sh
node benchmarks/compaction/compare-prompts.mjs \
  --plan benchmarks/compaction/results/2026-10-28-gemini/plan.json \
  --out benchmarks/compaction/runs/gemini-high
```

默认只校验输入和输出离线计划；提供 `BENCHMARK_URL`、`BENCHMARK_HEADERS` 并添加 `--execute` 才调用上游。`--cases normal-r1,normal-r2,normal-r3` 可只运行一组；每次使用新输出目录。Gemini Argon 使用隐式缓存，不添加显式缓存对象或 TTL；实际命中以 usage 为准。

本地假上游检查 runner 的实验隔离和数据处理；公开记录核验器检查文件 hash，并从原始回答和题目重算分数。两者都不调用模型：

```sh
node --test benchmarks/compaction/offline-test.mjs
node --test benchmarks/compaction/compare-prompts-test.mjs
node benchmarks/compaction/verify-record.mjs benchmarks/compaction/results/2026-10-20
node benchmarks/compaction/verify-record.mjs benchmarks/compaction/results/2026-10-20-opus
node benchmarks/compaction/verify-record.mjs benchmarks/compaction/results/2026-10-28-gemini
```

生成器改编自公开 MIT 项目 `algal/pi-openai-server-compaction`，完整许可在源文件内；Codex prompt 和文本保留算法的归属见仓库 [NOTICE](../../NOTICE)。

## 重绘已记录的结果

绘图是可选的独立步骤，只读取公开结果，不调用模型。安装单独的固定版本依赖，再生成 SVG 或 PNG；不加入项目运行时或 CI：

```sh
benchmarks/compaction/.venv/bin/python -m pip install -r benchmarks/compaction/requirements-plot.txt
benchmarks/compaction/.venv/bin/python benchmarks/compaction/plot.py \
  benchmarks/compaction/results/2026-10-20/results.json \
  benchmarks/compaction/runs/quality-vs-size.svg
```

横轴为实际回放 input tokens，纵轴为已知题正确率。高密度 seeds 与开发历史重复分图；箭头连接同一次生成的 K3 与其 K4，不把同一检查点的多次读取当作独立样本。

默认绘制全部样本。给命令增加 `--exclude-case stress-3617134` 可重绘最终报告的七样本主图；同一 case 的四条路线一并剔除，图中注明事后选择。此参数只控制图表，不修改原始结果或生成规则。
