/**
 * dsh-team-member-model v3 — Host half.
 *
 * v3（2026-11-14，适配 dsh 0.2.2-rc.3）：rc.3 删除了 `ctx.agents.roots()` 与
 * `agentTeams.listMembers()/tryMembership()`，v2 的根/Lead/成员解析层全部失效
 * （后果：isRoot 恒 false → 胶囊显示在主对话、点它会误写 Lead 的 model/selection）。
 * v3 改用 rc.3 的权威 API：
 *   - root ⇔ `agent.session.header.parentSession === undefined`
 *   - Lead ⇔ `ctx.subagents.rootOf(memberAgent)`（返回树根 Agent，自己就是 root 时跳过）
 *   - 成员名 ⇔ `ctx.subagents.namesOf(agent).self`（root 显示 'lead'）
 *   - 冷成员目录 ⇔ `ctx.subagents.listDescendants(rootSessionId)`（不唤醒 agent）
 * 写入通路不变（`agent.model.select()` + `agent/created` + `agent/inbox/claimed`），
 * v2.2 的 HTTP 围栏不变。
 *
 * 为单个团队子队友（或任意委托子会话）指定模型路线：
 *  - 官方通道：在成员 agent 的 pre-step 之前把路线写进其会话的
 *    `model/selection` 事件（`agent.model.select()` 同款落点），冷恢复也生效。
 *  - 「跟随主对话」：成员没有指定路线时，每次成员步进前读取 Lead 的
 *    `model.current()`（真实当前模型，而非 spawn 快照）并同步进成员会话。
 *  - 持久化：`$DSH_HOME/plugin-data/team-member-model.json`。
 *
 * v1 的 `agent/request` waterfall 改写在 dsh 0.2.2-rc.1 被官方封死
 * （步骤准备后固定选择，提议不同 provider/model 会 throw），v2 改用
 * `agent/created` + `agent/pre-step` 两个合法挂点，全程走
 * `agent.model.select()`。
 *
 * v2.2（2026-11-12，awesome-dsh-plugin 维护者评审建议）：HTTP 入口加上
 * Connection 官方围栏——每个请求先 `ctx.connection.requestRejection(req)`
 * （Host/Origin fence + 浏览器会话 cookie 认证，403/401），`readJson`
 * 强制 `application/json`（415）。桌面壳（dsh-app://app 转发）与浏览器
 * 同源 fetch 都带合法 cookie，正常路径不受影响；裸 curl / 跨站请求被拒。
 *
 * 根会话（Lead 自身）从不被本插件触碰——那是官方模型选择器的职责。
 */
import path from 'node:path'
import os from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

export const inject = ['agents', 'llm', 'webServer', 'connection']

const ROUTE_PREFIX = '/plugin/team-member-model'
const CATALOG_TTL_MS = 15_000

function dataFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'team-member-model.json')
}

function normalizeRoute(value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) return null
  const effort = typeof value.effort === 'string' && value.effort ? value.effort : null
  return { provider, model, effort }
}

function sameRoute(a, b) {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model && (a.effort ?? null) === (b.effort ?? null))
}

export async function apply(ctx, config) {
  const file = dataFile()
  const enabled = config?.enabled !== false
  /** @type {Record<string, any>} */
  let members = {}
  let saveTail = Promise.resolve()
  let clientLoaded = 0
  let lastHello = null

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      if (raw && typeof raw.members === 'object') {
        for (const [key, value] of Object.entries(raw.members)) {
          const route = normalizeRoute(value)
          if (route) members[String(key)] = { ...route, savedAt: typeof value?.savedAt === 'string' ? value.savedAt : null }
        }
      }
      ctx.logger?.info?.(`[team-member-model] loaded ${Object.keys(members).length} member route(s)`)
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`[team-member-model] could not load routes: ${error?.message ?? error}`)
    }
  }

  function save() {
    saveTail = saveTail
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, `${JSON.stringify({ version: 1, members }, null, 2)}\n`, 'utf8')
        await rename(tmp, file)
      })
      .catch((error) => ctx.logger?.warn?.(`[team-member-model] could not persist routes: ${error?.message ?? error}`))
    return saveTail
  }

  await load()

  // ---- model catalog ----
  let catalog = null
  let catalogAt = 0
  async function buildCatalog() {
    const now = Date.now()
    if (catalog && now - catalogAt < CATALOG_TTL_MS) return catalog
    const llm = ctx.get('llm')
    const routes = []
    let providers = []
    try {
      providers = llm?.listProviders?.() ?? []
    } catch {
      providers = []
    }
    for (const provider of providers) {
      let models = []
      try {
        models = (await provider?.listModels?.()) ?? (await llm?.listModels?.(provider.id)) ?? []
      } catch {
        continue
      }
      for (const model of models.slice(0, 80)) {
        let efforts = []
        let defaultEffort = null
        try {
          const info = await llm?.resolveModelInfo?.(provider.id, model.id)
          efforts = (info?.reasoningEfforts ?? []).map((e) => (typeof e === 'string' ? e : e?.id ?? e?.name)).filter(Boolean)
          defaultEffort = info?.defaultReasoningEffort ?? null
        } catch {
          efforts = []
        }
        routes.push({
          provider: provider.id,
          providerLabel: provider.name ?? provider.title ?? provider.id,
          model: model.id,
          modelLabel: model.label ?? model.name ?? model.id,
          efforts,
          defaultEffort,
        })
      }
    }
    catalog = routes
    catalogAt = now
    return routes
  }

  /** 指定路线只有在模型仍被已挂载 provider 列出时才可用。 */
  async function routeApplies(route) {
    if (!route) return null
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      if (!info) return null
      return { provider: route.provider, model: route.model }
    } catch {
      return null
    }
  }

  // ---- rc.3 解析层：ctx.subagents + SessionHeader.parentSession ----
  // dsh 0.2.2-rc.3 移除了 ctx.agents.roots() 与 agentTeams.listMembers/tryMembership，
  // 现行权威语义：
  //   root ⇔ session.header.parentSession === undefined（SessionHeader 字段仍在）
  //   Lead ⇔ ctx.subagents.rootOf(agent)（rootOf 抛错=树根不可用）
  //   名 ⇔ ctx.subagents.namesOf(agent).self（root 为 'lead'，成员为斜杠路径）
  //   冷成员 ⇔ ctx.subagents.listDescendants(rootSessionId)（只读耐久目录，不唤醒）
  // ⚠️ 绝不「遍历 agent 查谁的名册包含我」反查 Lead：v2.1 已证伪（有概率认错）。
  function isRoot(agent) {
    try {
      return agent?.session?.header?.parentSession === undefined
    } catch {
      return false
    }
  }

  /** 成员 agent 所在树的 Lead（树根）——rc.3 权威 API。自己是 root 时返回 null。 */
  function leadOf(memberAgent) {
    const subagents = ctx.get('subagents', false)
    if (!subagents?.rootOf) return null
    try {
      const root = subagents.rootOf(memberAgent)
      if (!root || String(root.id) === String(memberAgent?.id)) return null
      return root
    } catch {
      return null
    }
  }

  /** 读任意会话（冷/活）的 SessionHeader。ctx.sessions 只存活的会话，
   *  冷会话必须走 sessionQuery（持久化语料，不唤醒 agent）。 */
  async function readHeader(sessionId) {
    const query = ctx.get('sessionQuery', false)
    if (!query?.filterSessions) return null
    try {
      const rows = await query.filterSessions([{ kind: 'id', values: [String(sessionId)] }])
      return rows?.[0]?.header ?? null
    } catch {
      return null
    }
  }

  /** 根会话判定（冷会话也能判）：header.parentSession === undefined。
   *  活 agent 直接用 session.header；冷会话读持久化 header。 */
  async function isRootSession(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return isRoot(live)
    const header = await readHeader(sessionId)
    if (!header) return false // 读不到就不当根，避免误吞正常会话
    return header.parentSession === undefined
  }

  /** session id -> 成员展示行。活成员走 subagents API；冷成员读持久化 header +
   *  耐久子会话目录（subagents.listDescendants 不加载 agent）。 */
  async function resolveMember(sessionId) {
    const key = String(sessionId)
    const subagents = ctx.get('subagents', false)
    const live = ctx.agents.get(sessionId)
    if (live && !isRoot(live)) {
      let name = key
      try {
        const names = subagents?.namesOf?.(live)
        if (names?.self) name = names.self
      } catch {
        // 名字拿不到就用 session id
      }
      return { id: key, role: 'teammate', name, status: 'running' }
    }
    const header = await readHeader(sessionId)
    if (!header?.parentSession) return null // 根会话或读不到 → 不是成员
    const rootId = header.parentSession
    let name = null
    if (subagents?.listDescendants) {
      try {
        const rows = await subagents.listDescendants(rootId)
        const hit = (rows ?? []).find((row) => row?.kind !== 'diagnostic' && String(row?.id) === key)
        if (hit) name = hit.path ?? hit.label ?? null
      } catch {
        // 目录读不到就退回标题
      }
    }
    if (!name) {
      const query = ctx.get('sessionQuery', false)
      try {
        const title = await query?.readTitle?.(sessionId)
        name = title?.title ?? null
      } catch {
        name = null
      }
    }
    return { id: key, role: 'teammate', name: name ?? key, status: live ? 'running' : 'inactive' }
  }

  // ---- v2 核心：把路线写进成员会话的 model/selection ----
  // agent.model.select() 幂等（sameModelSelection 检查），冷恢复后一样生效，
  // 因为 model/selection 事件持久化在成员会话 journal 里。
  async function applyRouteToAgent(agent, route) {
    try {
      if (!agent?.model?.select) return false
      const selection = { provider: route.provider, model: route.model }
      if (route.effort) selection.reasoningEffort = route.effort
      agent.model.select(selection)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[team-member-model] select failed for ${agent?.id}: ${error?.message ?? error}`)
      return false
    }
  }

  /** 成员 agent 当前实际生效的路线（含 pending selection）。 */
  function currentRouteOf(agent) {
    try {
      const sel = agent?.model?.current?.()
      if (!sel) return null
      return { provider: sel.provider, model: sel.model, effort: sel.reasoningEffort ?? null }
    } catch {
      return null
    }
  }

  function liveOptionsRouteOf(agent) {
    const model = typeof agent?.options?.model === 'string' ? agent.options.model : undefined
    const provider = typeof agent?.options?.provider === 'string' ? agent.options.provider : undefined
    if (!model) return null
    return { provider: provider ?? null, model, effort: agent?.options?.reasoningEffort ?? null }
  }

  // ---- 挂点 1：agent/created（成员冷唤醒/创建时套用持久路线）----
  // agent/created 是 serial 全局事件（dsh-agent/lib/index.js:710），
  // source 含 fresh/resume/clear/compaction；冷恢复也触发。
  ctx.on('agent/created', async ({ agent, source }) => {
    if (!enabled || !agent || isRoot(agent)) return
    const key = String(agent.id)
    const entry = members[key]
    if (entry) {
      const applied = await routeApplies(entry)
      if (applied) await applyRouteToAgent(agent, applied)
      return
    }
    // 「跟随主对话」：无指定路线的成员，唤醒时立即取 Lead 当前模型。
    // 注意：created 阶段 select 留下的 model/selection 会持久化，之后
    // 挂点 2 会在每步刷新它，所以这里只是把「快照继承」提前换成「实时跟随」。
    const lead = leadOf(agent)
    if (!lead) return
    const leadRoute = currentRouteOf(lead) ?? liveOptionsRouteOf(lead)
    if (leadRoute?.provider && leadRoute?.model) {
      // 仅当成员当前路线与 Lead 不同才写，避免每步都追加事件
      const mine = currentRouteOf(agent) ?? liveOptionsRouteOf(agent)
      if (!sameRoute(mine, leadRoute)) await applyRouteToAgent(agent, leadRoute)
    }
  })

  // ---- 挂点 2：agent/pre-step（每步前刷新「跟随」）----
  // installModelSelection 的官方模板（dsh-agent/lib/types/model-selection.js
  // applyConfiguredRoute, dsh-agent-loop/lib/index.js:1380-1391）：在
  // pre-step waterfall 里对比 previous 并 select。pre-step 的
  // modelSelection 参数是本步已固定的选择——v2 在它之前改。
  // ⚠️ 关键顺序：dsh-agent-loop preStep() 里 claim() 先 emit
  // agent/inbox/claimed，然后才 this.model.current()。所以在
  // agent/inbox/claimed（同步 emit）里 select 是零滞后的；pre-step 时
  // modelSelection 已经捕获，改 select 只影响下一步。改用 inbox/claimed。
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    if (!enabled || !agent || isRoot(agent)) return
    const key = String(agent.id)
    const entry = members[key]
    if (entry) {
      // 有指定路线：确保当前选择就是它（幂等）
      const mine = currentRouteOf(agent) ?? liveOptionsRouteOf(agent)
      if (!sameRoute(mine, entry)) void routeApplies(entry).then((applied) => applied && applyRouteToAgent(agent, applied))
      return
    }
    // 跟随主对话：每步把 Lead 的当前模型同步进来
    const lead = leadOf(agent)
    if (!lead) return
    const leadRoute = currentRouteOf(lead) ?? liveOptionsRouteOf(lead)
    const mine = currentRouteOf(agent) ?? liveOptionsRouteOf(agent)
    if (leadRoute?.provider && leadRoute?.model && !sameRoute(mine, leadRoute)) {
      void applyRouteToAgent(agent, leadRoute)
    }
  })

  // ---- HTTP surface ----
  /** Connection 官方围栏：undefined=放行，数字=拒绝状态码（403 Host/Origin fence，401 未认证）。
   *  dsh 对 webServer prefix 路由不做准入（只有 /api 网关和 connection.fetch 精确路由过围栏），
   *  所以插件自己的每个入口都要先过这道（dsh-host-open-in-app/lib/index.js:1263-1270 同款）。 */
  function rejectedByFence(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  async function readJson(req) {
    // 强制 application/json：跨站简单请求（text/plain）不触发预检，是表单伪造的入口
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') {
      throw Object.assign(new Error('content-type must be application/json'), { status: 415 })
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) throw new Error('payload too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  function sendJson(res, status, body) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  async function stateFor(sessionId) {
    const key = String(sessionId)
    const member = await resolveMember(sessionId)
    const live = ctx.agents.get(sessionId)
    // 根会话（Lead / 普通主对话）永不显示本插件胶囊；官方模型选择器负责它们。
    const rootSession = await isRootSession(sessionId)
    const delegated = Boolean(live && !rootSession)
    const remembered = Boolean(members[key]) && !rootSession
    const liveRoute = live ? currentRouteOf(live) ?? liveOptionsRouteOf(live) : null
    const inherited =
      liveRoute ??
      (member?.model ? { provider: member.provider ?? null, model: String(member.model), effort: null } : null)
    return {
      ok: true,
      sessionId: key,
      teammate: Boolean(member),
      delegated,
      remembered,
      name: member?.name ?? (remembered ? '子会话（已记录）' : null),
      status: member?.status ?? (live ? 'running' : 'inactive'),
      inherited: inherited ?? null,
      route: members[key] ?? null,
    }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(ROUTE_PREFIX)) return false
    if (rejectedByFence(req, res)) return true
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
    try {
      if (req.method === 'GET' && action === 'state') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' }), true
        const state = await stateFor(sessionId)
        state.catalog = await buildCatalog()
        return sendJson(res, 200, state), true
      }
      if (req.method === 'POST' && action === 'route') {
        const body = await readJson(req)
        const sessionId = String(body?.sessionId ?? '')
        if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' }), true
        const route = normalizeRoute(body?.route)
        if (route) {
          const applied = await routeApplies(route)
          if (!applied) return sendJson(res, 400, { ok: false, error: `模型 ${route.provider}/${route.model} 当前不可用` }), true
          // 防御：根会话（Lead/主对话）不走本插件写入。
          // rc.3 之前 isRoot 恒 false，会把路线误写进 Lead 本体，这里双重把关：
          // 活 agent 查 header，冷会话走持久化 header。
          if (await isRootSession(sessionId)) {
            return sendJson(res, 400, { ok: false, error: '根会话请用官方模型选择器' }), true
          }
          members[sessionId] = { ...route, savedAt: new Date().toISOString() }
          // 成员活着就立刻 select 进去；冷着就等唤醒时挂点 1 套用
          const live = ctx.agents.get(sessionId)
          if (live) await applyRouteToAgent(live, applied)
        } else {
          delete members[sessionId]
          // 清除指定：跟随模式下不删成员会话里已有的 model/selection，
          // 下一次 Lead 换模型/成员步进时挂点 2 会重新对齐。
        }
        await save()
        const state = await stateFor(sessionId)
        return sendJson(res, 200, { ...state, ok: true }), true
      }
      if (req.method === 'GET' && action === 'ping') {
        return sendJson(res, 200, { ok: true, routes: Object.keys(members).length, enabled, clientLoaded, lastHello }), true
      }
      if (req.method === 'POST' && action === 'hello') {
        const body = await readJson(req).catch(() => ({}))
        clientLoaded += 1
        lastHello = { at: new Date().toISOString(), origin: body?.origin ?? null }
        return sendJson(res, 200, { ok: true, clientLoaded }), true
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
      return true
    } catch (error) {
      sendJson(res, error?.status ?? 400, { ok: false, error: String(error?.message ?? error) })
      return true
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleHttp }))
  ctx.on('llm/adapters-updated', () => {
    catalog = null
    catalogAt = 0
  })
}
