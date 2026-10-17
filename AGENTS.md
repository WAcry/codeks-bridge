# codeks-bridge

codeks-bridge 是给 codeks（openai/codex 的自用 fork）用的本地模型桥接器。它对 codeks 提供 OpenAI Responses 接口，把请求转发或转换到 OpenAI Responses、Anthropic Messages 和 OpenAI 兼容的 Chat Completions 上游。

动手前先读：

- `README.md`：用法和配置
- `docs/design.md`：整体设计和主要决策
- 改某一块转换逻辑时，读 `docs/` 下对应的专题文档

必须遵守：

- 这是公开仓库。写进仓库或发到 GitHub、npm 的内容都会公开，包括代码、注释、文档、测试数据、提交和 tag 说明、分支名、PR 和评论。只写公开资料里查得到的名称，例如开源项目、公有云和它们的服务：LiteLLM、Azure、AWS 和它们的运行时都可以写。私有的服务、工具、项目、域名、地址、账号和人名都不要写，举例也不行；在对话、本机其他仓库或工具里看到的私有名称，只用来理解需求。需要指代时用泛称，例如“某个 OpenAI 兼容网关”“下游项目”。拿不准是否公开，就当作私有。
- 私有名称清单在本机的 `~/.config/codeks/private-terms`，和 codeks 共用，不进仓库：每行一个正则，不区分大小写，`#` 开头是注释。提交、推送和开 PR 前运行 `npm run check`，它会用这份清单扫描仓库文件、提交说明和分支名。遇到清单里没有的私有名称，追加进去。
- 真实上游的地址、密钥和测试配置只放在仓库外（例如 `~/.config/codeks-bridge/`）。测试数据里的 id、签名和密文要换成合成值。
- 运行时零依赖，只用 Node 内置模块。开发依赖只有 TypeScript 和 Node 类型定义。
- 发给上游模型的提示词里不写本项目、codeks 或厂商的名字，只写模型完成任务需要的内容。
- 改了转换规则、配置项或协议假设，同步更新 `docs/` 里对应的文档。
- 代码注释用英文，文档用中文。
