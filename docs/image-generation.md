# 订阅图片生成与编辑

`image_generation: { "upstream": "chatgpt" }` 让支持图片输入的工作模型共用指定订阅连接的图片生成、编辑能力。连接使用 `auth.type: "chatgpt"`，省略配置时关闭；它与 `web_search` 分别配置，可以共用同一连接。完整配置见 [ChatGPT＋Claude 示例](../examples/chatgpt-claude.json)。

## 客户端配置与登录

重新运行 `config-snippet` 并合并到 codeks 配置，关键项为：

```toml
[features]
image_generation = true

[model_providers.bridge]
requires_openai_auth = true
```

每个 codeks 客户端都需要自己的有效 ChatGPT 登录，可运行 `codex login`。当前客户端根据本地登录状态决定是否显示 `image_gen.imagegen`：Free 账号和纯文本模型不会获得该工具。bridge 进程还需能读取所选订阅连接的文件登录；同机默认配置通常复用同一份 `~/.codex/auth.json`。

bridge token 与订阅凭据仍分开。片段保留 `env_key` 或 `experimental_bearer_token`，codeks 用它连接 bridge；bridge 再读取所选连接的 token 与账号 ID 调用图片接口，并复用已有续期和 HTTP 401 恢复逻辑。客户端本地登录用于工具启用判断，不要求把该凭据作为 bridge token。两端可以使用不同账号，但客户端仍受自己登录状态的门槛影响。见[订阅鉴权](backends-responses.md#订阅凭据与续期)。

用户选择这条配置路径，是因为同机自用已有 `codex login`，无需为工具启用条件增加 codeks 源码补丁。代价是仅在 bridge 服务器保存登录、客户端没有登录时，工具仍不会出现。

## 独立图片协议

工作模型调用原生 `image_gen.imagegen` 后，codeks 发出独立 JSON 请求：

| 操作 | bridge 路径 | 上游路径 |
| --- | --- | --- |
| 生成 | `POST /v1/images/generations` | `<base_url>/images/generations` |
| 编辑 | `POST /v1/images/edits` | `<base_url>/images/edits` |

bridge 也接受没有 `/v1` 前缀的这两个路径。图片请求按 `image_generation.upstream` 选路，不按 `models` 查找，也不经过推理 adapter、reasoning 筛选或压缩。工作模型和连接的推理 `options` 不注入图片请求。

Codex `0.164.0` 使用固定图片模型 `gpt-image-2`，默认 `quality: "auto"`、`size: "auto"`，由工具参数决定背景是否透明。这些值来自客户端，bridge 原样转发；无需再建立图片模型目录或 GPT 推理别名。生成请求包含 prompt，编辑请求另带所选图片，不发送完整会话历史。

编辑同样使用 JSON。codeks 可读取 `referenced_image_paths` 中的本地文件，转换成 data URL；也可用 `num_last_images_to_include` 选择最近的 1–5 张会话图片，两种选择方式互斥。默认客户端附件存储使用内联图片；宿主自定义远端附件存储时，`file_id` 也会原样传递，其所属账号和有效性由上游判断。

图片协议中的 `background` 是背景选项，不是 Responses 的后台任务开关。bridge 仅检查独立请求所需的 JSON 形状，保留其他字段，以及 `x-codex-image-turn-id` 等诊断 header；传输和凭据使用现有[转发边界](responses-stream.md#header-与转发边界)。

## 结果、用量与失败

上游返回完整 JSON，其中 `data[].b64_json` 是图片内容，可另带 `generation_id`、`usage` 和未知字段。bridge 保留正文、HTTP 状态与 header。codeks 负责图片保存、UI 事件和普通工具结果；Code Mode 可通过 `generatedImage(result)` 输出结果。返回后工作模型可读取图片继续处理，不依赖 GPT 私有密文或原推理会话。

当前 codeks 保存到 `$CODEX_HOME/generated_images/<thread>/<call>.png`，使用第一张输出图片。工具结果包含图片与保存路径提示。客户端行为依据 Codex `rust-v0.164.0` 的 [ImagesClient](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/images.rs)、[图片工具](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/image-generation/src/tool.rs)和[工具启用条件](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/spec_plan.rs)；升级时应复核这些边界。

上游错误直接交回 codeks，不由 bridge 自动更换来源或重试生成。图片失败走客户端工具错误路径；凭据过期时仅复用一次 HTTP 401 恢复。请求体上限沿用 `request_max_mib`，等待时间沿用订阅连接的 `headers_timeout_ms` 与 `stream_idle_timeout_ms`。客户端断开会取消 bridge 的请求，但已开始的远端作业不保证立即停止或退还额度。

[Inspector](inspect.md) 以 `image_generation` 记录生成和编辑请求，保留 prompt、图片、实际订阅连接、诊断信息及上游报告的 usage。图片用量不累加到下一次普通推理响应。图片 JSON/base64 与其他正文一样完整捕获，受现有内存软上限管理。

## 验证范围

开发调查直接调用订阅图片端点，使用 codeks 同形状的 `gpt-image-2` 请求：生成白底蓝色圆形，再用返回图片编辑为绿色，两次均 HTTP 200，分别约 12 秒、13 秒。返回完整 PNG、`generation_id`、usage 与 `x-codex-imagegen-request-id`，没有先建立 Responses 会话。这里只验证两种接口及图片可独立使用，不评估复杂生成质量或额度。

另用真实 codeks `0.164.0` 二进制、合成登录和本地模拟上游验证工具门槛：开启 feature 但没有 provider 登录声明时工具不可见；加入 `requires_openai_auth` 与非 Free 登录后，静态目录和动态目录均可生成图片，并将图片带入下一次模型请求。动态目录覆盖仅登录、显式 bearer token 和 `env_key` 三种入口鉴权配置；纯文本模型仍不暴露图片工具。该项没有调用真实推理模型。

[客户端联动测试](../test/image-generation-e2e.test.ts)使用生成的配置片段，覆盖静态及动态目录，分别验证 Claude、DeepSeek 的 Code Mode 生成 → 保存 PNG → 读取保存路径编辑 → 新图片回到模型历史；客户端与 bridge 使用不同的合成订阅账号，并验证普通推理请求不携带本地订阅账号信息。另验证图片 HTTP 400 作为工具错误返回模型，bridge 只发出一次图片请求。这些测试使用真实 codeks，模型与图片上游均为模拟服务。

实际 bridge HTTP 转发另完成一次订阅编辑请求：发送已有蓝色圆形图片，要求改为橙色，约 13 秒返回 HTTP 200 和约 1.37 MB PNG。Inspector 记录一次图片上游调用，usage、图片正文和请求 ID 与实际响应一致。真实凭据、原始响应和图片留在仓库外；公开测试仅含合成数据。
