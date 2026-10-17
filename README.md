# codeks-bridge

给 [codeks](https://github.com/WAcry/codeks) 使用的本地模型桥接器。对客户端提供 Responses API，可接 OpenAI Responses、Anthropic Messages 和 OpenAI 兼容 Chat Completions。当前重点支持 GPT、Claude 和 `deepseek-flash`。

它转换工具、图片和流式响应；按模型与端点隔离 reasoning；压缩后仍能在不同模型之间切换。GPT 同时保存原生加密压缩和文字摘要，其他模型使用文字摘要。运行时只依赖 Node.js 内置模块。

## 本地使用

需要 Node.js ≥ 22.18 和已安装的 codeks。本轮为开发版本，尚未发布 npm 包。

```sh
npm ci
npm run build
node dist/cli.js --help
```

把 [示例配置](examples/config.json) 复制到仓库外，按自己的端点修改 `upstreams` 和 `models`。只保留需要的模型，并在环境变量中提供对应 API key。示例中的窗口是配置值，不代表每个端点的最大能力；以实际端点的限制为准。

```sh
node dist/cli.js serve --config /absolute/path/bridge.json
```

另一个终端生成客户端模型目录与配置片段：

```sh
node dist/cli.js catalog --config /absolute/path/bridge.json \
  --codeks codeks --output /absolute/path/models.json
node dist/cli.js config-snippet --config /absolute/path/bridge.json \
  --catalog /absolute/path/models.json
```

把输出合并到客户端的 `config.toml`：顶层配置放在表定义前，已有的同名配置项应替换。然后在 codeks 中选择配置里的模型别名。生成目录会关闭 Responses Lite，使客户端发送转换所需的完整工具定义；远程压缩必须使用 V2。

## 使用边界

- 当前支持文本、用户图片、工具输出图片、函数工具和自由文本工具；Lark/regex 限制转换到工具说明中。
- 图片是否可理解取决于实际模型。图片生成与搜索工具转换不在本轮范围；客户端配置关闭 web search。
- 历史必须由 bridge 创建，且请求携带完整历史。已有的原生加密压缩没有文字备份，不能导入后跨模型解码。
- bridge 的历史载荷是编码封装，不是额外加密；文字 reasoning 和压缩摘要会保存在客户端历史中。
- GPT 双压缩会增加一条摘要请求，必须两条都成功；缓存命中与费用取决于上游。

[整体设计](docs/design.md) · [配置](docs/config.md) · [Reasoning](docs/reasoning.md) · [压缩](docs/compaction.md) · [工具](docs/tools.md) · [验证](docs/testing.md)
