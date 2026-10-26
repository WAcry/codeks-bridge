# codeks-bridge

给 [codeks](https://github.com/WAcry/codeks) 使用的本地模型桥接器。一个 Responses provider 可接入多个 GPT、Claude Messages 和 DeepSeek Chat 上游，支持工具、图片、流式回答和跨模型会话。

项目维护一份有限的[模型目录](catalog/README.md)。GPT 以 Codex 源码中各自的条目为基础，第三方模型采用经精调的现代模板。客户端使用 Responses Lite，工具模式和多代理设置保留各模型差异；配置可分别指定模型别名、目录条目和真实部署名。

## 安装和使用

需要 Node.js ≥ 20.19 和已安装的 codeks。

```sh
npm install -g @wacry/codeks-bridge
```

把[示例配置](examples/config.json)复制到仓库外，填写端点与 API key 环境变量，保留需要的模型。`catalog` 选择受支持的模型，`upstream` 选择连接，`model` 是实际发给上游的部署名；窗口与参数可以覆盖目录默认值。

GPT 也可使用 ChatGPT 订阅：先运行 `codex login`（已有文件登录可直接复用），再给连接设置 `"auth": { "type": "chatgpt" }`。bridge 自动读取登录凭据和账号 ID、刷新 token，订阅端点可省略。见[订阅配置](docs/config.md#chatgpt-订阅)和[ChatGPT＋Claude 示例](examples/chatgpt-claude.json)。

```sh
codeks-bridge serve --config /absolute/path/bridge.json
```

另一个终端生成客户端配置：

```sh
codeks-bridge config-snippet --config /absolute/path/bridge.json
```

将输出合并到 codeks 的 `config.toml`，顶层配置放在表定义前，替换已有同名项。codeks 会从 bridge 的 `/v1/models` 读取公开模型的完整目录，然后可按配置中的别名选择模型。`visibility: "hide"` 在选择器中隐藏但保留完整元数据；内部专用预设可设 `expose: false`，从目录中省略。已有 `model_catalog_json` 会优先使用本地文件；迁移到 HTTP 目录时应移除它。修改 bridge 配置后重启服务。

## 使用边界

- 普通模型错误保留原始详情交给客户端决定重试；ChatGPT 订阅 HTTP 401 最多进行一次鉴权恢复并重发。bridge 不自动换端点或更换压缩方式。
- bridge 封装的 reasoning 默认只回放给原目标，原生压缩与 reasoning 的跨目标复用分别配置。无法识别的历史状态默认透传，也可配置[过滤或报错](docs/config.md#未识别的历史状态)；实际兼容性由上游决定。
- GPT 默认使用 `compaction.mode: "native"`：先做原生加密压缩，需要文字表示时再向原来源复述并缓存。其他模型默认使用标准文字压缩，也可通过 [`compaction.model`](docs/config.md#压缩模式与执行模型) 委托常用 GPT 执行原生压缩，直接复用已有模型配置；见 [GPT＋Claude 双模型示例](examples/gpt-claude.json)。
- 历史由 codeks 保存；按需复述的成功结果另存本地缓存。封装只是编码，文字 reasoning、摘要及复述配方可读。
- Lark/regex 转为工具描述约束。图片理解由模型支持，客户端配置关闭网页搜索和图片生成。

## 调试

`serve` 加 `--capture` 后打开日志里的 `/inspect/` 地址，可以逐条查看 codeks 请求、发往上游的请求、上游原始响应和写回 codeks 的响应，以及 reasoning 与压缩状态的回放决定。记录只在内存中，也可以在页面上开关捕获、清空或导出。详见[调试检查器](docs/inspect.md)。

[配置与模型目录](docs/config.md) · [嵌入现有服务](docs/embedding.md) · [整体设计](docs/design.md) · [Reasoning](docs/reasoning.md) · [压缩](docs/compaction.md) · [工具](docs/tools.md) · [调试检查器](docs/inspect.md) · [验证](docs/testing.md) · [发布](docs/releasing.md)
