# dsh-team-member-model

仓库：<https://github.com/liaiaaa/dsh-team-member-model>

在**子队友（teammate）自己的会话界面**里给这一个成员单独指定模型：输入框工具行左侧多一个胶囊，
点它选模型，下一条消息起生效，**重启 dsh 后仍然是它**。没指定时**跟随主对话**：成员每次步进前
自动对齐主对话**当前**的模型（不是创建时的快照）。

宿主本身不给子会话开模型选择器（`dsh-client-ui-model-selection/lib/client.js:1873` 用
`available: sessions.subagentAddress(sessionId) === void 0` 明确禁掉）。

> **版本要求：v3 起需要 dsh ≥ 0.2.2-rc.3**（rc.3 删除了 `ctx.agents.roots()` 与
> `agentTeams.listMembers/tryMembership()`，v3 改用 `ctx.subagents` + `ctx.sessionQuery`）。
> dsh 0.2.2-rc.1/rc.2 请用 v2.2.x。

## 界面

打开任意一个团队成员的会话（团队面板点成员，或侧栏里的子会话），输入框左下出现：

```
dom.deepseek-v4-flash  ⌄      ← 已指定（强调色，无边框透明底 28px，不撑行高）
跟随 · teleagent.chat-pro  ⌄  ← 未指定，显示当前继承的模型
```

点开是 provider 分组 + 模型列表 + 思考强度档位 + 搜索框，最后一行「恢复跟随主对话（清除指定）」。
**只有子会话会显示这个胶囊**：主会话（root）永远不显示，也不会被改写。

## 生效范围与语义

| 情况 | 行为 |
|---|---|
| 指定后成员下一次步进（新消息、冷恢复、`send_message`、`wait_agent` 唤醒） | 用你指定的 `provider/model[/reasoningEffort]` |
| 空闲/重启后恢复 | 照样生效（按成员会话 id 命中，不是按运行实例） |
| 跟随模式（未指定） | 成员每次步进前读取 Lead 的 `model.current()` 并同步进成员会话——**主对话切模型后，成员下一条消息就跟上** |
| 指定的模型线路挂了（503 / DNS） | 该成员请求失败；点「恢复跟随主对话（清除指定）」回退 |
| 主会话 | 一律不改（官方模型选择器负责） |

## 实现（v3，适配 dsh 0.2.2-rc.3）

- Host（`index.js`）：不再碰 `agent/request`（dsh 0.2.2-rc.1 起步骤准备后固定选择，
  waterfall 提议不同 provider/model 会直接 throw）。改为两个合法挂点，全程走
  `agent.model.select()`（官方 `selectModel` 同款落点，写 `model/selection` 会话事件，
  冷恢复后仍然生效）：
  - `ctx.on('agent/created')`：成员冷唤醒/创建时，套用持久路线；无指定路线的成员
    立即取 Lead 的当前模型。
  - `ctx.on('agent/inbox/claimed')`：成员每步 claim 收件箱时（先于 `model.current()`
    捕获，零滞后），无指定路线则把 Lead 的 `model.current()` 同步进来——这是
    「跟随」的实现。
  - `POST /route` 时成员活着就立刻 `select`，不用等下一步。
- 解析层（v3，rc.3 权威 API）：
  - 根判定：`agent.session.header.parentSession === undefined`；冷会话用
    `ctx.sessionQuery.filterSessions([{kind:'id'}])` 读持久化 header（`ctx.sessions`
    只存 live 会话，冷会话拿不到）。
  - Lead：`ctx.subagents.rootOf(memberAgent)`（返回树根 Agent，自己就是 root 时跳过）。
    这是 rc.3 官方团队插件同款路径，不依赖任何名册遍历。
  - 成员名：活成员 `ctx.subagents.namesOf(agent).self`；冷成员
    `ctx.subagents.listDescendants(rootId)` 取 `path`（只读耐久目录，不唤醒 agent），
    退不到再读会话标题。
  - 根会话的 `POST /route` 直接 400（`根会话请用官方模型选择器`），双重把关活/冷。
- 校验：`llm.resolveModelInfo(provider, model)`，线路不在就直接 400 拒收，不写脏数据。
- 落盘：`$DSH_HOME/plugin-data/team-member-model.json`（激活时读回，写盘走 tmp+rename）。
- Client（`client.js`）：注册进 list 型插槽 `conversation.input.left`（`replaceRisk: none`，
  不替换官方组件）。触发器是官方 `ModelSelect` 同款形状（28px 高、无边框、透明底、
  单行 ellipsis，放进 `flex-wrap` 的 tools 行不会撑成两行）；面板用
  `ReactDOM.createPortal(…, document.body)` + `position:fixed; z-index:1100`，
  与 composer 布局完全隔离——这是 v1「输入框上移/UI 崩坏」的修法。

### HTTP 面（每个入口都过 Connection 官方围栏，页面内同源 fetch 直接带 cookie）

```
GET  /plugin/team-member-model/state?sessionId=…   # teammate/delegated/remembered/name/inherited/route/catalog
POST /plugin/team-member-model/route               # {sessionId, route:{provider,model,effort}|null}，需 application/json
GET  /plugin/team-member-model/ping                # routes 数、enabled、clientLoaded（客户端心跳计数）
POST /plugin/team-member-model/hello               # 客户端模块到达宿主的证明，需 application/json
```

**准入（v2.2，2026-11-12，awesome 维护者评审建议）**：dsh 对 `webServer` prefix
路由不做准入（只有 `/api` 网关和 `ctx.connection.fetch` 精确路由过 Connection 的
Host/Origin 围栏），所以本插件每个入口先走 `ctx.connection.requestRejection(req)`：

- 403：Host 非 loopback/受信地址、`sec-fetch-site: cross-site`、或 Origin 与 Host 不同源；
- 401：没有有效的 `dsh-auth-*` 浏览器会话 cookie（桌面壳转发时注入，浏览器同源
  fetch 自动携带）；
- 415：POST 请求体不是 `application/json`（封掉跨站 `text/plain` 简单请求）。

正常路径不受影响：桌面壳（`dsh-app://app`）转发请求统一带宿主登录 cookie 且不带
Origin；浏览器直开的页面同源 fetch 自动带 cookie。裸 curl / 跨站请求一律被拒。

## 安装 / 验证 / 卸载

```sh
# 安装（GitHub 仓库）
# plugin_manager: install_bundle → https://github.com/liaiaaa/dsh-team-member-model
# 本机开发：install_bundle → 插件目录绝对路径（link 安装，改动重启后生效）

# 验证（v2.2 起需登录 cookie：先认证换 cookie，再用它打插件路由）
LAUNCH_URL="http://127.0.0.1:<port>/?token=<启动URL里的token>"   # dsh web 打印的 URL
COOKIE=$(curl -si "$LAUNCH_URL" | grep -oi '^set-cookie: [^;]*' | cut -d' ' -f2-)
curl -s -H "Cookie: $COOKIE" http://127.0.0.1:<port>/plugin/team-member-model/ping
curl -s -H "Cookie: $COOKIE" "http://127.0.0.1:<port>/plugin/team-member-model/state?sessionId=<成员会话id>" | head -c 400
cat ~/.dsh/plugin-data/team-member-model.json
# v3 行为级离线测试（mock ctx：根不写/跟随/指定/rootOf 抛错，10 项断言）
node tests/host-behavior.mjs
# 端到端：给该成员发一条消息，再解它的会话日志看 request/header 的 provider/model
zstdcat ~/.dsh/sessions/<workspace-slug>/<childId>/session.v4.jsonl.zstd \
  | python3 -c "import sys,json;[print(json.loads(l)['data']['header']['config'].get('provider'),json.loads(l)['data']['header']['config'].get('model')) for l in sys.stdin if '\"request/header\"' in l]"
```

卸载：`plugin_manager remove_bundle dsh-team-member-model`，路由文件可自行删除
（`~/.dsh/plugin-data/team-member-model.json`）。

## 已知边界（v3）

- 只有输入框胶囊，没有设置页；不能给「未来新建的 teammate」设默认值（那属于
  Lead 模型 / `agent-default-model` 的事）。
- 思考强度档位来自 `resolveModelInfo`，本机这几个 provider 返回空列表 → 只有模型可选。
- 一个会话一个路由，keyed by 会话 id；成员被彻底删除后那条路由会留在文件里（无害，可清）。
- 「跟随」的读数来源是 Lead 会话的 `model.current()`（`model/selection` 事件的
  pending ?? lastUsed）。若主对话从未手动切过模型，读到的是 spawn 快照路线。
- **v2.1（2026-11-10）**：`leadOf` 改用官方 `agentTeams.tryMembership(agent)` 直查
  （role==='teammate' 时 `.root` 即 Lead，由 `agent.session.header.parentSession` 权威绑定）。
  v2 曾靠「遍历所有活 agent 查谁的名册包含我」反查——而 `listMembers` 对团队里**任何成员**
  都返回全量名册，于是兄弟成员/成员自己/fork journal 的伪 Lead 都可能命中，跟随**有概率
  跟错对象**（用户报告并源码坐实）。活成员的名册行（chip 名字/状态）也优先走同一权威路径，
  冷成员退回遍历（仅显示用，最坏拿到 fork 的陈旧行）。
- 实测（2026-11-09）：HTTP 面/校验/落盘/客户端在隔离实例浏览器 0 console 报错
  （`clientLoaded:1`）；触发器 28px 不撑行、面板 fixed 挂 body、开/关面板输入框
  y 坐标零位移；点「恢复跟随」真实清盘。端到端：真实实例指定
  `aihub/teleagent.chat-flagship` → 唤醒成员 → 会话出现 `model/selection` 事件
  且第 2 个真实 `request/header` 变成 `teleagent.chat-flagship`，成员正常回复
  `PROBE-V2-OK`。
- 实测（2026-11-10，v2.1）：隔离实例给冷成员发消息唤醒 → 成员 journal 写入跟随
  其 Lead 当前模型的 `model/selection`（且先于 `request/context` 捕获生效）。
  附带事实：**光打开会话视图不会冷唤醒成员 agent**，投递消息才会。
- **v2.2（2026-11-12）**：HTTP 入口全部加 Connection 官方围栏
  （`requestRejection` + `application/json` 强制）。插件 `inject` 新增 `connection`
  依赖（官方 `dsh-host-open-in-app` 同款）；所在 profile 没有 client-connection
  服务时插件整体不加载（fail-closed，不会静默裸奔）。详见上面「HTTP 面」的准入节。
- 宿主模型目录 ≠ AIHub 线路实况：目录随 dsh 版本变化（`qoder.Qwen3.8-Flash` 曾在
  目录里、2026-11-09 已不在），指定前最好先在面板里看一眼列表。
- **v3（2026-11-14，适配 dsh 0.2.2-rc.3）**：rc.3 删除 `ctx.agents.roots()` 与
  `agentTeams.listMembers/tryMembership()` 后，v2.2 的解析层全部失效——`isRoot()` 抛错被
  catch 成恒 false，于是**主对话也被当成子会话**：胶囊显示在主对话，点它还会把
  `model/selection` 写进 Lead 会话本体。v3 按上面「解析层」改用 `ctx.subagents`
  （`rootOf`/`namesOf`/`listDescendants`）+ `session.header.parentSession`，
  写入通路（`agent.model.select()`、`agent/created`、`agent/inbox/claimed`）与
  v2.2 的 HTTP 围栏完全不变。
  - 隔离实例（0.2.2-rc.3）实测：Lead 会话 `/state` → `teammate/delegated/remembered` 全 false、
    `POST /route` → 400；冷成员 → `teammate:true` 且取到名字；给成员 `POST /route` → 200 落盘。
  - 离线行为测试（mock ctx）：根 `agent/created` 不写；成员 `agent/created` 跟随 Lead 当前模型；
    `agent/inbox/claimed` 在 Lead 换模型后对齐；指定后不再跟随；`rootOf` 抛错不崩不写。
  - 已知差异：rc.3 之前创建的旧成员不在 rc.3 的 `subagents` 耐久目录里 → 名字退回会话标题
    （`path` 为空）；rc.3 之后新建的成员应能拿到斜杠路径名。
- 与 rc.3 原生「子智能体设置 → 可选模型」的关系：原生落 `subagent/model-selection-policy`
  白名单，作用在**派工时**（Lead 派子智能体可挑允许范围内的模型），并且官方模型选择器
  对子会话仍写死不可用。本插件负责**用户侧、逐成员、跟随/指定**，两者不冲突。
