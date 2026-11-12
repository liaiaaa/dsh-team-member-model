/**
 * dsh-team-member-model v2.2 — Host half.
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

  // ---- team/roster lookup: session id -> teammate row（冷成员也能查到） ----
  // 活成员优先走官方 tryMembership 直查（权威 Lead 的名册）；冷成员退回遍历
  // （只用于 chip 显示名字/状态，最坏拿到 fork 会话的陈旧行，无害）。
  function resolveMember(sessionId) {
    const teams = ctx.get('agentTeams', false)
    if (!teams?.listMembers) return null
    const live = ctx.agents.get(sessionId)
    if (live && typeof teams.tryMembership === 'function') {
      try {
        const membership = teams.tryMembership(live)
        if (membership?.role === 'teammate' && membership.root) {
          const hit = (teams.listMembers(membership.root) ?? []).find(
            (row) => row.role === 'teammate' && String(row.id) === String(sessionId),
          )
          if (hit) return hit
        }
      } catch {
        // 落到下面的遍历
      }
    }
    for (const agent of ctx.agents.list()) {
      let rows = []
      try {
        rows = teams.listMembers(agent) ?? []
      } catch {
        continue // 不是团队 caller
      }
      const hit = rows.find((row) => row.role === 'teammate' && String(row.id) === String(sessionId))
      if (hit) return hit
    }
    return null
  }

  function isRoot(agent) {
    try {
      return ctx.agents.roots().some((root) => root.id === agent.id)
    } catch {
      return false
    }
  }

  /** 成员 agent 所属团队的 Lead agent —— 官方语义，权威且确定。
   *  tryMembership 用 agent.session.header.parentSession 解析团队，role:'teammate'
   *  的 membership.root 就是真正的 Lead（dsh-experimental-agent-team/lib/index.js:873-899）。
   *  ⚠️ 绝不要「遍历 agent 查谁的名册包含我」：listMembers 对团队里**任何成员**
   *  都返回全量名册，兄弟成员/成员自己/带 fork journal 的伪 Lead 都会命中，
   *  「跟随」就有概率跟错对象（2026-11-10 用户报告并源码坐实）。 */
  function leadOf(memberAgent) {
    const teams = ctx.get('agentTeams', false)
    if (!teams || typeof teams.tryMembership !== 'function') return null
    try {
      const membership = teams.tryMembership(memberAgent)
      return membership?.role === 'teammate' ? membership.root : null
    } catch {
      return null
    }
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
    const member = resolveMember(sessionId)
    const live = ctx.agents.get(sessionId)
    const delegated = Boolean(live && !isRoot(live))
    const remembered = Boolean(members[key]) && !(live && isRoot(live))
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
          members[sessionId] = { ...route, savedAt: new Date().toISOString() }
          // 成员活着就立刻 select 进去；冷着就等唤醒时挂点 1 套用
          const live = ctx.agents.get(sessionId)
          if (live && !isRoot(live)) await applyRouteToAgent(live, applied)
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
