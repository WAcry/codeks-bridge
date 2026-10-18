# codeks-bridge

给 [codeks](https://github.com/WAcry/codeks) 使用的本地模型桥接器。客户端连接一个 Responses provider，通过模型别名选择 GPT Responses、Claude Messages 或 DeepSeek Chat 上游。各模型可以配置不同的连接、参数、reasoning 和原生压缩复用范围。

支持工具、图片和流式响应。Reasoning 默认只回放给原目标，可显式允许其他来源；压缩始终保留文字摘要，支持原生压缩的目标还可保存和复用加密检查点。历史由 codeks 保存，bridge 无需数据库。运行时只依赖 Node.js 内置模块。

## 本地使用

需要 Node.js ≥ 22.18 和已安装的 codeks。项目尚在开发中，未发布 npm 包。

```sh
npm ci
npm run build
node dist/cli.js --help
```

把 [示例配置](examples/config.json) 复制到仓库外，填写自己的端点和模型，保留需要的配置，并提供对应的 API key 环境变量。`upstreams` 管连接，`models.adapter` 选择模型协议；窗口和参数以实际端点为准。

```sh
node dist/cli.js serve --config /absolute/path/bridge.json
```

另一个终端生成客户端模型目录与配置片段。`--codeks` 指向已安装的 codeks 可执行文件：

```sh
node dist/cli.js catalog --config /absolute/path/bridge.json \
  --codeks /absolute/path/to/codex --output /absolute/path/models.json
node dist/cli.js config-snippet --config /absolute/path/bridge.json \
  --catalog /absolute/path/models.json
```

把输出合并到客户端 `config.toml`，顶层配置放在表定义前，替换已有同名项。然后选择配置中的模型别名。服务配置修改后重启 bridge；模型列表、窗口或能力配置修改后重新生成目录并重载客户端。

## 使用边界

- 同时支持多个上游，每个别名固定选一个目标。上游错误保留原始详情交给客户端，bridge 不自动换端点、重试或更换压缩方式。
- Reasoning 和原生压缩的跨目标复用分别配置。允许复用表示你选择尝试该配对，实际兼容性由上游决定。
- 历史由 bridge 创建并随请求完整传回。载荷是编码封装，文字 reasoning 和压缩摘要在会话文件中可读。
- 默认 GPT 双压缩会增加一条摘要请求，两条都成功才生成检查点；可配置仅生成文字摘要。
- Lark/regex 转为工具描述约束。图片是否可理解由模型决定；本轮不转换图片生成和搜索工具。

[配置与模型目录](docs/config.md) · [整体设计](docs/design.md) · [Reasoning](docs/reasoning.md) · [压缩](docs/compaction.md) · [工具](docs/tools.md) · [验证](docs/testing.md)
