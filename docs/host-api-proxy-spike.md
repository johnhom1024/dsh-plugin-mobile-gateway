# Host API 路由代理（spike，2026-10-30）

> 分支 `feat/bot-call` ｜ 只读 spike ｜ **未发布、未合入 main**
> 目标：让移动端 WebUI 能拿到 ds-bot 的 `POST /api/bot` 视图，而不把 `/api` 暴露到网络。

## 1. 是什么

网关本来就用 `connection.createSharedFetchHandler('/api')`（`lib/dsh-host-adapter.mjs`，文件上传那处）
**在宿主进程内**直派精确 Fetch 路由：不监听回环 HTTP、不要浏览器 cookie、不暴露公网 `/api`。

这个 spike 把同一能力抽成一个语义方法 + 一条 WS 查询，**白名单受控、默认关闭**：

```js
// lib/dsh-host-adapter.mjs
const api = createDshHostAdapter(gateway, peer, connection, {
  hostApiPaths: ['/api/bot'],   // 空数组 = 功能不存在
})
await api.hostApi.call('/api/bot', { endpoint: 'state' })
```

```js
// 客户端 → 网关
{ "type": "host-api", "pathname": "/api/bot", "body": { "endpoint": "state" }, "requestId": "r1" }
// 网关 → 客户端
{ "kind": "host-api", "pathname": "/api/bot", "result": { "ok": true, "value": { … } }, "requestId": "r1" }
```

## 2. 安全边界（与既有 `apiProxy` 否决决议一致）

`test/host-adapter.test.mjs` 有一条硬断言：网关源码不得出现 `apiProxy` / `api.events.mux` /
`api.respond(`。本 spike 不碰 typert、不碰 Remote 信封，只走**精确 Fetch 路由**，因此不违反它。

| 项 | 取值 | 理由 |
|---|---|---|
| 默认状态 | **关闭**（`hostApiPaths: []`） | 空白名单 = 功能不存在，能力位不出现 |
| 路径范围 | 只能是**精确注册的 Fetch 路由**（`fetchRoutes` 按 pathname 查） | 未注册路径直接 404，无法借此调 typert 端点 |
| 调用者 | 固定网关自己的 owner Peer（`createPeer({ principal: { kind: 'owner' } })`） | Host 的 `createSharedFetchHandler` 对精确路由只放 owner；网关无法提权 |
| 方法 | 恒为 `POST` + `application/json` | ds-bot 的契约；不做通用 HTTP 转发 |
| 语义失败 | 路由返回 `HTTP 200 + {ok:false}` 原样透传 | ds-bot 用 200 表达 `bot/read-only` / `bot/not-found`，不等于传输失败 |
| 能力位 | `hello.capabilities` 含 `host-api-proxy-v1`，仅在白名单非空且 handler 存在时出现 | 客户端据此决定「要不要显示依赖 Host API 的入口」 |

错误码：`host-api-unavailable`（关着）、`host-api-path-denied`（不在白名单）、`host-api-failed`（HTTP 非 2xx）。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `lib/dsh-host-adapter.mjs` | 第 4 参 `options`；复用已有的 `uploadHandler`；新增 `hostApi: { available, paths, call }` |
| `lib/index.mjs` | `Config.hostApiPaths`（默认 `[]`）；构造适配器时传入；hello 加 `host-api-proxy-v1`；`handleQuery` 加 `host-api` 分支；WS 分发白名单加 `host-api` |
| `test/host-api-proxy.test.mjs` | 新增，9 组：默认关、无 connection、越权路径、请求形状、空 body、HTTP 失败、语义失败、query op、能力位/配置/旧决议断言 |

## 4. 验证

### 4.1 单元（`node test/host-api-proxy.test.mjs`）

```
host-api-proxy: 9 groups passed
```

### 4.2 真实宿主（端到端，只读）

桌面宿主（pid 38191）无法热加载新插件代码，所以用一个**临时 profile** 起第二个宿主：
同一 `DSH_HOME`（因此是同一份团队数据）、`requireAuth: false`、`lanEnabled: false`、
`hostApiPaths: ['/api/bot']`，端口随机。因为单写者锁，这个宿主天然只读——正好验证只读路径。

```
hello.capabilities 含 host-api-proxy-v1 = true
host-api /api/bot {endpoint:'state'} →
  ok = true
  revision = 101
  view 字段数 = 32
  有 privateArchives = true
  有 learning = true
  bots = Chief, Dev, Ops
  readOnly = "The Bot team in /Users/johnhom/.dsh/bot is open in another dsh … pid 38191 …"
负例 /api/deep-view → host-api-path-denied
```

复现（复用这套 profile 即可，不必重启桌面 GUI）：

```bash
# ~/.dsh/profiles/botspike 已建好：bundles 含 dsh-base / dsh-web-app / ds-bot / 本 worktree 的网关
cd ~ && dsh --profile botspike --no-open --port 0      # 端口随机，日志里有 dsh web: http://127.0.0.1:<port>/
# 连 ws://127.0.0.1:<port>/ws/mobile，发 hello 后发 host-api 帧
```

> profile 的完整说明（用途、凭据立场、删除方式）见 `dsh-bot-webui/docs/dev-harness.md`。
> profile 里必须 `.npmrc` 写 `auto-install-peers=false`，并显式 pin `@deepseek-ai/dsh-llm|dsh-tools|dsh-web`
> 到 `0.2.1-rc.3`。否则 pnpm 会把 `ds-bot` 的 `*` peer 解析成陈旧的 `0.0.1-rc.1`，它牵出
> `@deepseek-ai/dsh-type-meta`（未发布到 registry）导致安装失败。

## 5. 尚未做（按需要再补）

1. **客户端帧族的正式命名**：现在只有一条 `host-api` 查询，WebUI 侧还没有对应的 store/协议章节。
   落地时应并入 PROTOCOL.md，并决定是 `host-api` 通用帧还是 `bot-state` / `bot-action` 专用帧。
2. **载荷上限**：`response.json()` 无字节上限。真实 state 现在是 **9 868 B**（3 Bot / 0 群），
   群多、Bot 多时会涨；接裁剪或加 `maxResponseBytes`。
3. **轮询放大**：`live().learning` 每轮都发且不跟 revision，客户端 1.5s 轮询时网关应单例轮询 + 按需下发。
4. **能力位命名**：`host-api-proxy-v1` 表达「网关能代理白名单 Host API」；ds-bot 路由是否存在另由
   零副作用探针（`{endpoint:'bot-probe'}` → `bot/not-found`）判断。两者不要合并。
