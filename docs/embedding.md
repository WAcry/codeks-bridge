# 嵌入现有服务

npm 包可直接创建标准 Node HTTP server。运行已编译的包需要 Node.js ≥ 20.19；直接运行仓库里的 TypeScript 开发脚本需要 ≥ 22.18。

```ts
import { createBridgeServer, loadConfig } from "@wacry/codeks-bridge";

const config = await loadConfig("/absolute/path/bridge.json");
const server = createBridgeServer(config, {
  async transformRequest(request, { headers }) {
    const model = headers.get("x-example-model");
    if (model) request.model = model;
  },
  fetch: (input, init) => fetch(input, init),
  onResponseEvent(request, event) {
    if (event.type === "response.output_item.done") {
      console.log(request.model, event.item.type);
    }
  },
});

server.listen(8123, "127.0.0.1");
```

第二个参数 `BridgeServerOptions` 可省略，不影响 CLI 和默认传输。各选项只作用于当前 server，不替换全局 fetch。

| 选项 | 调用边界 |
| --- | --- |
| `transformRequest(request, { headers })` | 入口鉴权与 JSON 解析之后、模型路由和历史转换之前，主请求调用一次。可原位修改并返回 `void`，也可返回替换请求，支持 Promise。`headers` 是该请求的 HTTP headers。辅助压缩和按需复述不会再次调用它。 |
| `fetch` | 与标准 `fetch` 签名相同，承接全部模型请求，包括压缩、委托压缩及按需复述。可接入宿主的代理、凭据和传输策略；须保留传入的取消信号并返回标准 `Response`。 |
| `onResponseEvent(request, event)` | 同步观察主响应实际提交的标准 Responses 事件；`request` 是变换后的请求。缓冲后因失败丢弃的工具事件、辅助请求和 keepalive 不进入观察器。JSON 请求也产生同样的语义事件，其中每个已提交输出项有一次 `response.output_item.done`。 |

观察器应只读取参数，不修改请求或事件，也不返回 Promise。它在交付路径中同步执行；抛出的异常会进入现有请求错误处理，并停止该请求的后续观察。原始上游帧及辅助调用的调试使用[检查器](inspect.md)。

宿主可通过 `AsyncLocalStorage` 在请求处理作用域中保存自己的关联信息，供 fetch 与观察器读取。bridge 不要求特定宿主元数据格式，也不管理宿主的重试。

如果宿主已有超时策略，分别设置连接的 `headers_timeout_ms` 和 `stream_idle_timeout_ms`；`null` 禁用对应阶段，省略保持默认行为，详见[连接配置](config.md#上游连接)。
