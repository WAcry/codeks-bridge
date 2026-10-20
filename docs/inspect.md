# 调试检查器

检查器是 bridge 内置的网页，用来确认一条请求在 bridge 里实际经过了什么转换。打开捕获后，每条 `POST /v1/responses` 记录为一次交换（exchange），包含四段原始内容：

1. codeks 发给 bridge 的请求；
2. bridge 发给上游的每个请求；
3. 上游返回的原始响应，含 SSE 事件和到达时间；
4. bridge 写回 codeks 的响应。

普通轮次使用上游调用 `main`。压缩请求按模式使用文字摘要调用 `summary` 或原生调用 `native`。委托压缩仍标为 `native` 或 `summary`，上游请求中的模型和连接来自实际执行别名。请求需要按需复述且缓存尚无结果时，先执行 `handoff`，成功后再执行目标调用；命中缓存时不产生这条辅助调用。路由前失败的请求（例如 JSON 无效或模型别名未知）没有上游调用，只有前后两段。

## 打开

```sh
codeks-bridge serve --config /absolute/path/bridge.json --capture
```

启动日志会打印页面地址，例如 `Inspector: http://127.0.0.1:8787/inspect/ (capture on)`。不加 `--capture` 时页面同样可用，捕获默认关闭，可以在页面上随时打开或关闭。也可以写进配置：

```json
{ "inspect": { "capture": true, "max_mib": 256 } }
```

| 字段 | 含义 |
| --- | --- |
| `inspect.capture` | 启动时是否捕获，默认 `false`；`--capture` 覆盖为 `true` |
| `inspect.max_mib` | 内存软上限，默认 256 MiB |

## 访问与鉴权

页面文件（HTML、脚本、样式）不含数据，无需鉴权。数据接口 `/inspect/api/*` 的规则：

- 配置了 `token_env`：请求必须带 `Authorization: Bearer <token>`。页面第一次访问会要求输入 token，只保存在当前标签页的 sessionStorage。通过反向代理、远程域名或非 loopback 地址访问时用这种方式。
- 没有 `token_env`：只接受 Host 为 `127.0.0.1`、`localhost` 或 `[::1]` 的同源请求，其他网站的页面和改写过 Host 的请求都会收到 403。bridge 在远程机器上时，用 SSH 端口转发后在本机打开：

  ```sh
  ssh -L 8787:127.0.0.1:8787 <remote-host>
  ```

检查器接口在 bridge 入口鉴权之前处理，因此页面请求带 `Origin` 不受入口“带 `Origin` 必须有 token”规则影响；模型请求的鉴权不变。页面使用严格 CSP，只加载本服务的脚本和样式，不访问外部资源。

## 使用页面

左侧列表每行是一次交换，显示开始时间、模型别名和 adapter、类型（轮次或压缩）、每个上游调用的状态、token 用量、子代理与父线程标记和预览。顶部可以按文字筛选（按 `/` 聚焦），或只看错误、压缩、进行中的交换；“按线程分组”把同一线程的请求放在一起。`↑`/`↓` 切换选中项。列表每 1.5 秒刷新，标签页隐藏时暂停。

右侧顶部的卡片按数据流排列：① codeks → bridge，② bridge → 上游，③ 上游 → bridge，④ bridge → codeks。每个实际上游调用各占一行，并显示 `main`、`summary`、`native` 或 `handoff` 标签。点击卡片查看这一段的正文，Shift+点击在右侧并排打开第二段。每段正文有几种视图：

| 视图 | 内容 |
| --- | --- |
| 结构 | 全部顶层字段；`input`/`output`、`system`/`messages`、`tools` 逐项一行，带类型、角色、长度和标注 |
| 事件 | SSE 事件列表，名称取 `event`，没有时取 `data.type`；连续的 delta 合并为一行，可展开 |
| JSON | 可展开的 JSON 树 |
| 原始 | 原始字节 |
| 头部 | 状态码与 header |

大内容只在显示时折叠，记录本身完整。长字符串显示开头和结尾，中间注明省略的字符数，可以展开全部、复制或下载；`cxbr1:` 与 `cxbc1:` 载荷可以直接解码。很长的列表分批显示，可以继续加载。Responses Lite 的终止事件可能省略完整 `output`；结构视图会用之前的 `response.output_item.done` 还原输出，原始事件保持不变。

列表和详情顶部的 token 用量取自写回 codeks 的响应，只代表该次 main、summary 或 native 调用。handoff 的独立 usage 可在它的上游响应中查看：SSE 事件、结构或 JSON 视图保留原始字段，不累加进客户端用量。缓存命中不产生新的 handoff 调用，也不重复展示为本次消耗。检查器没有跨调用的计费总额；上游没有报告的字段不能按零消耗理解。

“概要”给出实际执行模型的路由配置、每个调用的时间线和上游调用表；客户端模型字段仍保留用户请求的工作别名。“标注”列出全部回放决定，点击可定位到对应项。“对比”选择任意两次交换的任意一段做结构比较，常用的是和同一线程上一轮的客户端请求或上游请求比较；数组按类型和角色对齐，新增、删除的项单独标出。

“导出全部”和详情里的“导出此条”下载导出文件。“导入”（或把文件拖到页面上）离线查看导出文件，“返回实时”回到 bridge 的记录。浏览器不允许从本地文件加载页面脚本，离线查看也要通过 HTTP 打开页面，例如任意运行中的 bridge 的 `/inspect/`。

## 记录规则

正文完整保存，不做字段白名单，也不在服务端截断。codeks 或上游新增的字段原样出现，页面只在显示时折叠。

只有凭据类 header 会脱敏。名称按 `-`/`_` 分段后含 `auth`、`authorization`、`token`、`secret`、`password`、`passwd`、`cookie`、`key`、`apikey`、`credential(s)` 或 `signature` 的 header，值替换为 `[redacted: N chars, sha256 xxxxxxxx]`。长度和哈希前缀可以用来判断凭据是否传到了上游、两次请求是否用了同一个凭据。正文不脱敏。

几处需要注意的边界：

- 上游请求的 header 是 bridge 设置的 header；Node `fetch` 自动补充的 `host`、`content-length`、`connection`、`accept-encoding` 等不在记录里。上游请求正文是实际发送的字节。
- 客户端响应记录 bridge 实际写出的状态码、header 和字节，包括 bridge 自己生成的错误。
- 时间以交换开始为零点，单位毫秒。SSE 事件取完成它的那个数据块的到达时间。

每段响应的 `end` 状态：

| `end` | 含义 |
| --- | --- |
| `active` | 仍在传输 |
| `complete` | 读完或写完 |
| `unread` | bridge 已不再读取这个上游响应，例如收到终止事件后结束；剩余字节没有读取 |
| `cancelled` | 客户端断开；仍在进行的上游调用随之标记为 `cancelled` |
| `error` | 传输出错，`error` 字段给出原因 |

交换的 `outcome` 来自写回 codeks 的内容：流式响应取最后一个终止事件（`response.completed`、`response.incomplete`、`response.failed`、`error`），非流式响应取 JSON 的 `status`。客户端断开为 `aborted`；没有写出响应或流没有终止事件时为 `error`。

## 状态标注

检查器对 reasoning 与压缩载荷做标注，判断直接调用 bridge 构造上游历史时使用的同一组函数，结果与实际转换一致。

请求侧标注 codeks 历史里的每个 reasoning 与压缩项，指针形如 `/input/3`。委托压缩按执行模型判断恢复方式，普通请求按工作模型判断：

| 类型 | 决定 | 原因 | 含义 |
| --- | --- | --- | --- |
| reasoning | `replay` | `same_source` | 来自当前目标，本次回放 |
| reasoning | `replay` | `allowed_source` | 来自配置允许的其他目标，本次回放 |
| reasoning | `drop` | `source_not_allowed` | 来源不在当前目标的允许列表，本次请求中过滤 |
| reasoning | `drop` | `format_mismatch` | 来源允许，但载荷格式与当前 adapter 不同 |
| reasoning | `drop` | `not_bridge_state` | 不是 bridge 封装的状态，例如直接来自其他 provider 的密文 |
| reasoning | `reject` | `malformed` | 有 bridge 前缀但无法解码，bridge 会拒绝请求 |
| compaction | `native` | `native_restored` | 恢复原生加密检查点 |
| compaction | `summary` | `no_native` | 检查点只有文字摘要 |
| compaction | `summary` / `handoff` | `native_replay_disabled` | 当前目标关闭了原生恢复 |
| compaction | `summary` / `handoff` | `source_not_allowed` | 原生检查点来源不在允许列表 |
| compaction | `summary` / `handoff` | `format_mismatch` | 原生检查点格式与当前 adapter 不同 |
| compaction | `reject` | `not_bridge_state` | 不是 bridge 生成的压缩项，bridge 会拒绝请求 |

`summary` 表示直接使用载荷中已有的文字，`handoff` 表示先取得文字交接：可以复用本地缓存，也可以向原来源生成。只有实际发起辅助请求时，上游调用列表才出现 `handoff`；这条状态标注本身不表示发生了额外 HTTP 请求。

响应侧标注 bridge 新生成的 reasoning 与压缩项（决定为 `output`）。流式响应指向 `response.output_item.done` 事件里的 `/item`，非流式响应指向 `/output/k`。只有文字摘要的压缩项没有原生部分，来源和格式为空；`native` 检查点的来源和格式取原生部分。

每条标注附来源别名、部署名、adapter、来源指纹、载荷格式和解码后的 carrier。`cxbr1:` 与 `cxbc1:` 只是编码，解码后可以看到文字 reasoning、压缩摘要和原生载荷；GPT 原生 `encrypted_content` 本身仍是密文，只能看到原样字符串。

## Claude 服务端输入处理

上游响应详情单独显示服务端原始 `input_transformations` 报告。它与 bridge 根据来源策略做的本地回放过滤不同：本地决定回放的 thinking，仍可能被 Claude 拒绝或丢弃。

- `thinking_dropped` 表示服务端报告已丢弃对应 thinking。
- `thinking_mismatch_allowed` 表示允许失配并保留，不代表丢弃。
- 每项保留原始 `path`、`reason` 与未知字段；`path` 指向该次实际发出的上游请求，不是 codeks 原始输入的位置。

页面保留报告所在 SSE 事件及字段路径，可回到原始内容核对。流里重复出现的报告不会累加为“丢弃总数”；显式空列表显示“服务端报告为空”，没有报告则不展示这个区块，不能解读为零丢弃或全部验签通过。丢弃可能减少可用的推理上下文，检查器只展示上游报告，不推断模型质量或自行改写历史。策略与故障恢复见 [Claude Messages](backends-anthropic.md#失配策略与故障续接)。

## 内存、清空与导出

记录只在内存里，不写磁盘，进程退出即清空。超过 `max_mib` 时淘汰最早的已结束交换；仍在传输的交换不淘汰，所以占用可能短时超过上限。页面显示已淘汰的数量。

关闭捕获后已有记录保留，正在进行的交换继续记录到结束。清空会释放全部记录，并停止记录这些交换的后续内容；实际模型请求继续运行。

导出下载一个 JSON 文件，`format` 为 `codeks-bridge-capture`，`version` 为 `1`，`exchanges` 是每条交换的完整详情，与页面详情接口相同。记录和导出文件包含提示词、工具输出、文件内容以及解码后的 reasoning，按敏感数据保存和分享。

## 接口

页面使用以下 JSON 接口，也可以用脚本调用。所有响应都带 `cache-control: no-store`。

| 接口 | 用途 |
| --- | --- |
| `GET /inspect/api/state` | 捕获开关、记录数、进行中数、占用字节、上限、淘汰数、版本号和模型列表 |
| `POST /inspect/api/capture` | 请求体 `{"enabled": true}` 或 `false`，返回新状态 |
| `GET /inspect/api/exchanges?since=<rev>` | 版本号之后有变化的摘要，以及仍存在的全部 id |
| `GET /inspect/api/exchanges/<id>` | 一次交换的完整详情；已清空或淘汰时返回 404 |
| `DELETE /inspect/api/exchanges` | 清空 |
| `GET /inspect/api/export` | 流式导出全部详情 |

交换 id 是不透明字符串，只用于查询。

摘要里的 `thread` 取自 codeks 的请求 header：`session-id`、`thread-id`、`x-codex-parent-thread-id`、`x-openai-subagent` 和 `x-codex-window-id`。子代理请求带父线程 id 和子代理类型，可以据此把父子请求对应起来。`preview` 取最后一条用户消息；子代理请求取最后一条 `agent_message`，也就是父代理发来的任务。
