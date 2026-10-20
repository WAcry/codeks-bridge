# 压缩与交接 benchmark

这是手动运行的质量实验，不进入 CI，也不影响 bridge 的运行时。材料都是合成数据；不读取本机会话、登录文件或真实项目。目标是比较压缩后可恢复的任务信息，保留可重复的方法和历史证据，供以后换模型重跑。

## 固定的五条路线

`H` 是完整历史，`U` 是保留的用户消息，`K` 是交付给下一次请求的压缩产物。

| 产物 | 生成请求 | 类型 |
| --- | --- | --- |
| K1 | H + [Codex 内置 prompt](prompts/builtin.txt) | 文字 |
| K2 | H + [bridge 标准 prompt](prompts/standard.txt) | 文字 |
| K3 | H + [用户提供的 Claude Code 式 prompt](prompts/claude-code.txt) | 文字 |
| K4 | H + `compaction_trigger` | 原生检查点 |
| K5 | U + **同一份 K4** + [当前 handoff prompt](prompts/handoff.txt) | 文字 |

K3 强调记录所有真实用户消息，按用户提供的全文冻结，不声称与某个 Claude Code 发布版本逐字相同。K5 使用当前生产 handoff 的快照，包含 text-only 约束。[manifest.json](prompts/manifest.json) 记录各份 prompt 的来源和 UTF-8 字节 hash；调整生产代码不会自动改变实验文本。

**五种产物的最终问答全部只使用各自产物，不附带 U、H 或生成过程的 reasoning。** K5 生成时仍使用 U，以复现 bridge 的交接输入。因此 K5 是整个交接流程的测试，不能把它相对 K4 的变化全部归因于密文转明文。

所有请求使用同一份固定基础指令和工具声明；这些公共协议前缀不包含题目答案或原任务历史。文字产物通过固定的 Codex summary prefix 作为一条用户消息载入，原生 K4 作为原生 item 载入。每次问答都是独立请求，没有 `previous_response_id`，不会串联前一组回答或 reasoning。**评分请求固定 `tool_choice: none`**，确保闭卷问答无法向工具查询答案；这个设置只影响控制组和恢复测验，不改变压缩及 handoff 生成。默认另测空历史和完整 H 两个基线，分别检查猜测与题目本身的可回答性。

## 两种材料

### 高密度状态保留

[fixture.py](fixture.py) 从固定 seed 生成五类记录：精确参数、方向关系、工具结果、后续纠正值、任务状态与下一步。标准配置每类 200 条，合计 1,000 条记录，分布在十个阶段；填充到 220,000 个本地 `o200k_base` 序列化 JSON tokens。这个数不是服务端 input usage。

测验固定每类 30 题，加 5 道不存在记录的题。生成压缩产物时不发送测验、标准答案或评分元数据。问答按完整 canonical string 精确匹配；缺字段不等于正确回答 `null`。这适合测量精确信息保留，但不等于编程能力评估，也不能用 150 题全部正确证明 1,000 条记录全部无损。

K5 的 U 由 [retention.py](retention.py) 生成，使用历史 Codex V2 文本用户消息的 64k 近似预算：`ceil(UTF-8 bytes / 4)`，优先保留较新的消息，边界消息保留首尾。它只覆盖合成文本材料，不模拟图片、通知或完整客户端历史策略。截断标记在预算之外，近似 token 预算不能当成精确 tokenizer 上限。

### 开发任务 handoff

[normal.json](fixtures/normal.json) 是虚构 TypeScript 上传 CLI 的开发对话，包含 103 个 items、12 条用户消息和 42 对工具调用/结果。代码、路径、输出和操作都是叙事材料；runner 不访问其中的路径，也不执行其中的命令。

材料覆盖设计被替换、提交授权被撤回、旧测试通过后发现新问题、修复仍待执行等状态。原先冻结的 50 项事实保留在 fixture 中。[normal-questions.json](fixtures/normal-questions.json) 将这些事实细化成可核验的问答，包括数值、字段名、权限、最终设计和验证状态，并增加不存在信息的题目。

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

实际调用时，在环境中提供 `BENCHMARK_URL`（完整 `/responses` URL）和 `BENCHMARK_HEADERS`（请求 headers 的 JSON 对象），再给命令加 `--execute`。按目标服务准备鉴权；runner 不绑定某种登录机制、账号或本机目录。它发送 Responses Lite；测试其他协议的模型时可使用支持该模型的 bridge。K4/K5 要求目标支持原生压缩，仅测试文字路线可用 `--products K1,K2,K3`。

默认使用 `reasoning.effort: medium`、`summary: auto`、`context: all_turns`，生成时保留 `tool_choice: auto`，不设置输出 token 上限。`--options FILE` 可覆盖请求参数，`--instructions FILE` 可替换基础指令，`--controls none` 可省略基线。更换模型时记录这些变化，不自动假定它支持相同参数。

原生压缩与所有文字生成分别记 usage。若文字生成意外调用工具、流未成功结束或接口拒绝请求，该运行直接失败并保留记录；不会执行工具、自动换 prompt 或偷偷重试。失败时先调查原因，新的尝试使用新目录，报告中保留失败尝试。

已有完整产物但需要重新测验时，可以给原命令加 `--reuse-products OLD_RUN_DIR`，并指定新的 `--out`。runner 核对模型、材料、prompt、参数和题目，原样复用已成功生成的产物，包括同一份 K4；不重新压缩，也不覆盖旧测验。新记录明确标记复用来源，旧生成 usage 不计入这次新增调用。这是显式操作，不是自动重试。

原始产物保存在 `runs/`（已由 Git 忽略），包含请求体、事件、原生密文、文字、usage、耗时和参数快照；不会保存请求鉴权 headers。不要将运行目录直接提交。公开报告只整理合成文本、去标识化评分和必要数值，原生密文及服务端标识留在本地。

## 结果怎么读

- 分开看已知事实正确率、无答案题是否返回 `null`、各类别错误，以及空历史和完整历史基线。开发题还要复核权限与工作状态，不能仅看总分。
- native、handoff、quiz 分开计算 usage。问答基线和恢复测验是实验成本，不是产品每次压缩的必需开销。K5 的完整生成成本包含 K4 和 handoff，但共享 K4 的实验总成本只计算它一次。
- cached input 已包含在 input tokens 中。总 output 通常包含 reasoning；文字长度、原生检查点归因 tokens 和 reasoning 分开记录。长度只是辅助信息，不能替代质量评分，也不能按密文字节数推断信息量。
- 每轮只有一份检查点时，150 道答案不是 150 次独立压缩实验。比较稳定性需要固定参数后增加 seed 和独立重复，不在看到坏结果后只保留重跑成绩。
- 这是质量实验，不模拟完整工作会话的缓存路由。缓存 usage 和耗时可记录，但不能据此断言正常客户端的缓存命中率或通用延迟。

## 历史记录与离线核验

[2026-10-20 的完整五路实测](results/2026-10-20-medium/README.md)使用 GPT-6.1 Sol / medium，保存两份输入、题目与 gold、八份文字产物、全部最终及初步回答、逐题评分和用量。开发任务与高密度状态分别报告；原生密文只保留公开元数据。

[历史受控状态实验](historical-controlled.md) 和 [历史 handoff 对照](historical-handoff.md) 保留之前的测量与限制。它们使用的 effort、prompt、恢复时是否附带 U 等条件不同，不能合并成当前五条路线的统一排名。

本地假上游检查 runner 的实验隔离和数据处理，不消耗模型额度，也不加入 `npm test` 或发布工作流：

```sh
node --test benchmarks/compaction/offline-test.mjs
```

生成器改编自公开 MIT 项目 `algal/pi-openai-server-compaction`，完整许可在源文件内；Codex prompt 和文本保留算法的归属见仓库 [NOTICE](../../NOTICE)。
