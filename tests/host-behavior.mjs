// v3 行为级离线测试（mock cordis ctx，语义对齐 dsh 0.2.2-rc.3）
// 验证：根会话不受影响、成员唤醒套用 Lead 当前模型、指定模型优先、rootOf 抛错不崩。
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

const home = await mkdtemp(path.join(os.tmpdir(), 'tmm-mock-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

let failures = 0
function check(name, cond, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  << ${detail ?? ''}`}`)
  if (!ok) failures += 1
}

// ---- fake agents ----
function makeAgent(id, parentSession) {
  const calls = []
  const state = { current: { provider: 'aihub', model: 'old-model', reasoningEffort: null } }
  return {
    id,
    options: {},
    session: { header: { id, version: 4, createdAt: 0, isSeeded: false, ...(parentSession ? { parentSession } : {}) } },
    model: {
      current: () => ({ ...state.current }),
      select: (sel) => {
        calls.push(sel)
        state.current = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort ?? null }
      },
    },
    _calls: calls,
    _set: (route) => {
      state.current = { provider: route.provider, model: route.model, reasoningEffort: route.effort ?? null }
    },
  }
}

const ROOT_ID = 'session-root'
const MEMBER_ID = 'member-1'
const root = makeAgent(ROOT_ID)
const member = makeAgent(MEMBER_ID, ROOT_ID)
member._set({ provider: 'aihub', model: 'spawn-snapshot' })
root._set({ provider: 'aihub', model: 'lead-current' })

const handlers = new Map()
const registered = []
const ctx = {
  get(key, fallback) {
    if (key === 'agents') return (opts) => {
      // 兼容 ctx.agents.get() 直接调用
      const store = { get: (id) => (id === ROOT_ID ? root : id === MEMBER_ID ? member : undefined), list: () => [root, member] }
      return store
    }
    if (key === 'subagents') {
      return {
        rootOf: (agent) => {
          if (String(agent?.id) === ROOT_ID) return root
          if (String(agent?.id) === MEMBER_ID) return root
          throw new Error('no root')
        },
        namesOf: (agent) => ({ self: String(agent?.id) === ROOT_ID ? 'lead' : 'route-probe', parent: 'lead' }),
        listDescendants: async () => [{ id: MEMBER_ID, path: 'route-probe', kind: 'subagent' }],
      }
    }
    if (key === 'sessionQuery') {
      return {
        filterSessions: async (filters) => {
          const ids = filters?.[0]?.values ?? []
          return ids.map((id) => ({
            header: id === ROOT_ID ? { id, isSeeded: false, version: 4, createdAt: 0 } : { id, parentSession: ROOT_ID, isSeeded: false, version: 4, createdAt: 0 },
          }))
        },
        readTitle: async () => ({ title: 'route-probe 任务' }),
      }
    }
    if (key === 'llm') {
      return {
        listProviders: () => [{ id: 'aihub', name: 'AIHub' }],
        listModels: async () => [{ id: 'lead-current' }, { id: 'pinned-model' }, { id: 'old-model' }, { id: 'spawn-snapshot' }],
        resolveModelInfo: async (provider, model) => (provider === 'aihub' ? { reasoningEfforts: [] } : null),
      }
    }
    if (key === 'webServer') return { register: (row) => registered.push(row) }
    if (key === 'connection') return { requestRejection: () => undefined }
    return fallback
  },
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  effect(fn) {
    return fn()
  },
  logger: { info() {}, warn() {} },
}
// 插件用 ctx.agents / ctx.llm / ctx.webServer / ctx.connection 直接取服务（服务属性）
const agentsService = { get: (id) => (id === ROOT_ID ? root : id === MEMBER_ID ? member : undefined), list: () => [root, member] }
const llmService = ctx.get('llm')
const webServerService = ctx.get('webServer')
const connectionService = ctx.get('connection')
Object.defineProperties(ctx, {
  agents: { get: () => agentsService },
  llm: { get: () => llmService },
  webServer: { get: () => webServerService },
  connection: { get: () => connectionService },
})

await apply(ctx, { enabled: true })
check('插件注册了 HTTP prefix 路由', registered.some((r) => r.kind === 'prefix' && r.path === '/plugin/team-member-model'), JSON.stringify(registered))

const created = handlers.get('agent/created')
const claimed = handlers.get('agent/inbox/claimed')
check('注册了 agent/created 挂点', typeof created === 'function')
check('注册了 agent/inbox/claimed 挂点', typeof claimed === 'function')

// 1) 根会话创建：不得触碰（rc.3 前 isRoot 恒 false 会把 Lead 写坏）
member._calls.length = 0
root._calls.length = 0
await created({ agent: root, source: 'fresh' })
check('根 agent/created 不写 model/selection', root._calls.length === 0, JSON.stringify(root._calls))

// 2) 冷唤醒成员：跟随 Lead 当前模型
member._calls.length = 0
member._set({ provider: 'aihub', model: 'spawn-snapshot' })
await created({ agent: member, source: 'resume' })
check(
  '成员 agent/created 跟随 Lead 当前模型',
  member._calls.length === 1 && member._calls[0].provider === 'aihub' && member._calls[0].model === 'lead-current',
  JSON.stringify(member._calls),
)

// 3) 每步刷新：Lead 换模型后成员步进对齐
member._calls.length = 0
root._set({ provider: 'aihub', model: 'pinned-model' })
claimed({ agent: member })
await new Promise((r) => setTimeout(r, 30))
check(
  'agent/inbox/claimed 跟随 Lead 新模型',
  member._calls.length === 1 && member._calls[0].model === 'pinned-model',
  JSON.stringify(member._calls),
)

// 4) 指定模型优先于跟随
const res = {
  statusCode: 200,
  setHeader() {},
  end(body) {
    this.body = body
  },
}
const req = {
  url: '/plugin/team-member-model/route',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ sessionId: MEMBER_ID, route: { provider: 'aihub', model: 'old-model' } }))
  },
}
const handled = await registered.find((r) => r.kind === 'prefix').handler(req, res)
check('POST /route 命中成员返回 200', handled === true && res.statusCode === 200, `${handled} ${res.statusCode} ${res.body}`)
member._calls.length = 0
root._set({ provider: 'aihub', model: 'lead-current' })
claimed({ agent: member })
await new Promise((r) => setTimeout(r, 30))
check(
  '指定模型后不再跟随 Lead（保持指定值）',
  member._calls.length === 0 && member.model.current().model === 'old-model',
  JSON.stringify({ calls: member._calls, current: member.model.current() }),
)

// 5) 根会话 POST 被拒
const leadRes = {
  statusCode: 200,
  setHeader() {},
  end(body) {
    this.body = body
  },
}
const leadReq = {
  url: '/plugin/team-member-model/route',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ sessionId: ROOT_ID, route: { provider: 'aihub', model: 'old-model' } }))
  },
}
await registered.find((r) => r.kind === 'prefix').handler(leadReq, leadRes)
check('根会话 POST /route 返回 400', leadRes.statusCode === 400, `${leadRes.statusCode} ${leadRes.body}`)

// 6) rootOf 抛错时不崩、不写
handlers.get('agent/created')
const orphan = makeAgent('orphan', ROOT_ID)
const badCtx = orphan
const subagentsBad = { rootOf: () => { throw new Error('root unavailable') }, namesOf: () => ({ self: 'x' }) }
const origGet = ctx.get
ctx.get = (key, fallback) => (key === 'subagents' ? subagentsBad : origGet(key, fallback))
orphan._calls.length = 0
await created({ agent: orphan, source: 'resume' })
check('rootOf 抛错时成员唤醒不崩且不写', orphan._calls.length === 0, JSON.stringify(orphan._calls))
ctx.get = origGet

await rm(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
