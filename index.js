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
