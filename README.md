# codeks-bridge

给 [codeks](https://github.com/WAcry/codeks) 使用的本地模型桥接器。一个 Responses provider 可接入多个 GPT、Claude Messages 和 DeepSeek Chat 上游，支持工具、图片、流式回答和跨模型会话。

项目维护一份有限的[模型目录](catalog/README.md)。GPT 保留 Codex 源码中各自的条目，第三方模型采用经精调的现代模板。客户端使用 Responses Lite、Code Mode Only 和多代理；配置可分别指定模型别名、目录条目和真实部署名。

## 本地使用

需要 Node.js ≥ 22.18 和已安装的 codeks。项目尚在开发中，未发布 npm 包。

```sh
npm ci
npm run build
```

把[示例配置](examples/config.json)复制到仓库外，填写端点与 API key 环境变量，保留需要的模型。`catalog` 选择受支持的模型，`upstream` 选择连接，`model` 是实际发给上游的部署名；窗口与参数可以覆盖目录默认值。

```sh
node dist/cli.js serve --config /absolute/path/bridge.json
```

另一个终端生成客户端配置：

```sh
node dist/cli.js config-snippet --config /absolute/path/bridge.json
```

将输出合并到 codeks 的 `config.toml`，顶层配置放在表定义前，替换已有同名项。codeks 会从 bridge 的 `/v1/models` 读取完整模型目录，然后可按配置中的别名选择模型。已有 `model_catalog_json` 会优先使用本地文件；迁移到 HTTP 目录时应移除它。修改 bridge 配置后重启服务。

## 使用边界

- 上游错误保留原始详情交给客户端；bridge 不自动换端点、重试或更换压缩方式。
- Reasoning 默认只回放给原目标。原生压缩与 reasoning 的跨目标复用分别配置，实际兼容性由上游决定。
- GPT 默认先做原生加密压缩，再复述为文字摘要；也可配置 `compaction.mode: "lazy"`，只在需要文字表示时向原来源生成并缓存。其他模型使用标准文字压缩。
- 历史由 codeks 保存；延迟复述的成功结果另存本地缓存。封装只是编码，文字 reasoning、摘要及复述配方可读。
- Lark/regex 转为工具描述约束。图片理解由模型支持，客户端配置关闭网页搜索和图片生成。

[配置与模型目录](docs/config.md) · [整体设计](docs/design.md) · [Reasoning](docs/reasoning.md) · [压缩](docs/compaction.md) · [工具](docs/tools.md) · [验证](docs/testing.md)
