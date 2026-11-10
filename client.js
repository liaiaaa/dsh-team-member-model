/* Client half of dsh-team-member-model v2: composer 触发器（官方同款形状）
 * + createPortal 面板（挂 document.body，与 composer 布局完全隔离）。
 * 读取/写入 /plugin/team-member-model/*。
 * v1 的两个 UI 缺陷修法：
 *  - 触发器不再带 border/背景/圆点，高度与 tools 行原生控件一致（28px），
 *    文本单行 ellipsis，不会把 flex-wrap 的 tools 行撑成两行 → 输入框不动。
 *  - 面板 createPortal 到 document.body + position:fixed，不受 composer
 *    祖先 transform/overflow 影响，不再出现「输入框向上移动/UI 崩坏」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-team-member-model',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const ENDPOINT = '/plugin/team-member-model'

    const CSS = `
.tmm-trigger{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 6px;
  background:transparent;border:none;cursor:pointer;max-width:220px;
  color:var(--dsw-alias-label-secondary,#9a9a9a);font:500 var(--dsw-font-xs-13,13px)/1 inherit}
.tmm-trigger:hover{color:var(--dsw-alias-label-primary,#ddd);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));border-radius:6px}
.tmm-trigger[data-pinned="1"]{color:var(--dsw-alias-accent-rest,#247bbf)}
.tmm-triggerText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tmm-caret{flex:none;width:12px;height:12px;opacity:.7}
.tmm-panel{position:fixed;z-index:1100;width:340px;max-height:60vh;display:flex;flex-direction:column;
  border-radius:10px;border:1px solid var(--dsw-alias-border-rest,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-1,#1e1e1e));
  box-shadow:0 12px 32px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary,#ddd);
  font:var(--dsw-font-xs-13,13px)/1.4 inherit}
.tmm-head{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-rest,rgba(128,128,128,.2))}
.tmm-title{font-weight:600;font-size:var(--dsw-font-s-14,14px)}
.tmm-sub{color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:var(--dsw-font-xxxs-11,11px);margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmm-search{width:100%;box-sizing:border-box;margin-top:6px;padding:4px 8px;border-radius:6px;font-size:inherit;
  border:1px solid var(--dsw-alias-border-rest,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1,transparent);
  color:inherit;outline:none}
.tmm-list{overflow:auto;padding:4px}
.tmm-group{padding:6px 8px 2px;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:var(--dsw-font-xxxs-11,11px);
  text-transform:uppercase;letter-spacing:.04em}
.tmm-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer}
.tmm-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}
.tmm-row[data-active="1"]{color:var(--dsw-alias-accent-rest,#247bbf);font-weight:600}
.tmm-rowName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmm-efforts{display:flex;gap:4px;flex:none}
.tmm-eff{padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-rest,rgba(128,128,128,.24));
  font-size:var(--dsw-font-xxxs-11,11px);cursor:pointer;background:transparent;color:inherit}
.tmm-eff[data-active="1"]{border-color:var(--dsw-alias-accent-rest,#247bbf);color:var(--dsw-alias-accent-rest,#247bbf)}
.tmm-clear{margin:4px;padding:7px 8px;border-radius:6px;text-align:center;cursor:pointer;
  border:1px dashed var(--dsw-alias-border-rest,rgba(128,128,128,.3));color:var(--dsw-alias-label-secondary,#9a9a9a)}
.tmm-clear:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}
.tmm-note{padding:6px 10px;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:var(--dsw-font-xxxs-11,11px)}
.tmm-error{padding:6px 10px;color:var(--dsw-alias-danger-rest,#e06c5f);font-size:var(--dsw-font-xxxs-11,11px)}
`

    let stylesReady = false
    function ensureStyles() {
      if (stylesReady || typeof document === 'undefined') return
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.appendChild(style)
      stylesReady = true
    }

    async function getJson(url, init) {
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function routeText(route) {
      if (!route) return ''
      const effort = route.effort ? ` · ${route.effort}` : ''
      return `${route.model}${effort}`
    }

    const Caret = () =>
      h('svg', { className: 'tmm-caret', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 },
        h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6' }))

    function TeamMemberModelChip(props) {
      const sessionId = props.sessionId
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [panelPos, setPanelPos] = React.useState(null)

      const reload = React.useCallback(() => {
        if (!sessionId) return
        getJson(`${ENDPOINT}/state?sessionId=${encodeURIComponent(sessionId)}`, {
          headers: { accept: 'application/json' },
        })
          .then((next) => {
            if (next && (next.teammate || next.delegated || next.remembered)) setState(next)
            else { setState(null); setOpen(false) }
          })
          .catch((e) => setError(String(e?.message ?? e)))
      }, [sessionId])

      React.useEffect(() => {
        setError(null)
        setOpen(false)
        setState(null)
        reload()
        const timer = setInterval(reload, 30000)
        return () => clearInterval(timer)
      }, [reload])

      React.useEffect(() => {
        if (open) reload()
      }, [open, reload])

      // 面板定位：跟随触发器，优先向下展开（在 tools 行下方，不遮输入区），
      // 视口不够再向上。面板在 document.body 上，fixed 定位不受祖先影响。
      React.useEffect(() => {
        if (!open) { setPanelPos(null); return }
        const place = () => {
          const rect = triggerRef.current?.getBoundingClientRect?.()
          if (!rect) return
          const width = 340
          const estHeight = 380
          const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
          const below = rect.bottom + 6
          const above = rect.top - estHeight - 8
          const top = below + estHeight <= window.innerHeight - 8 || above < 8
            ? Math.min(below, Math.max(8, window.innerHeight - estHeight - 8))
            : above
          setPanelPos({ left, top: Math.max(8, top) })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open])

      React.useEffect(() => {
        if (!open) return
        const onPointerDown = (event) => {
          if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const choose = React.useCallback(
        async (route) => {
          if (!sessionId || busy) return
          setBusy(true)
          setError(null)
          try {
            const next = await getJson(`${ENDPOINT}/route`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, route }),
            })
            setState({ ...(next || {}), catalog: state?.catalog ?? [] })
            if (!route) setOpen(false)
          } catch (e) {
            setError(String(e?.message ?? e))
          } finally {
            setBusy(false)
          }
        },
        [busy, sessionId, state?.catalog],
      )

      if (!state) return null
      ensureStyles()

      const pinned = Boolean(state.route)
      const label = pinned
        ? routeText(state.route)
        : `跟随 · ${state.inherited ? routeText(state.inherited) : '主对话'}`
      const catalog = state.catalog || []
      const needle = filter.trim().toLowerCase()
      const visible = needle
        ? catalog.filter((row) => `${row.provider} ${row.providerLabel} ${row.model} ${row.modelLabel}`.toLowerCase().includes(needle))
        : catalog
      const groups = []
      for (const row of visible) {
        let group = groups.find((g) => g.provider === row.provider)
        if (!group) groups.push((group = { provider: row.provider, label: row.providerLabel || row.provider, rows: [] }))
        group.rows.push(row)
      }

      const trigger = h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          className: 'tmm-trigger',
          'data-pinned': pinned ? '1' : '0',
          title: pinned ? `已指定模型 ${routeText(state.route)}；点击更换` : '跟随主对话当前模型；点击指定固定模型',
          onClick: () => {
            ensureStyles()
            setOpen((value) => !value)
          },
        },
        h('span', { className: 'tmm-triggerText' }, label),
        h(Caret),
      )

      const panel = open
        ? ReactDOM.createPortal(
            h(
              'div',
              { ref: panelRef, className: 'tmm-panel', style: panelPos ?? { visibility: 'hidden' } },
              h(
                'div',
                { className: 'tmm-head' },
                h('div', { className: 'tmm-title' }, `${state.name || '子会话'} · 模型`),
                h(
                  'div',
                  { className: 'tmm-sub' },
                  pinned ? `已指定：${routeText(state.route)}` : `跟随主对话：${state.inherited ? routeText(state.inherited) : '主对话当前模型'}`,
                ),
                h('input', {
                  className: 'tmm-search',
                  placeholder: '搜索模型…',
                  value: filter,
                  autoFocus: true,
                  onChange: (event) => setFilter(event.target.value),
                }),
              ),
              error ? h('div', { className: 'tmm-error' }, error) : null,
              h(
                'div',
                { className: 'tmm-list' },
                busy ? h('div', { className: 'tmm-note' }, '保存中…') : null,
                groups.length === 0 ? h('div', { className: 'tmm-note' }, '没有可用模型') : null,
                groups.map((group) =>
                  h(
                    React.Fragment,
                    { key: group.provider },
                    h('div', { className: 'tmm-group' }, group.label),
                    group.rows.map((row) => {
                      const active = pinned && state.route.provider === row.provider && state.route.model === row.model
                      return h(
                        'div',
                        { key: `${row.provider}/${row.model}`, className: 'tmm-row', 'data-active': active ? '1' : '0' },
                        h(
                          'span',
                          {
                            className: 'tmm-rowName',
                            onClick: () => choose({ provider: row.provider, model: row.model, effort: row.defaultEffort }),
                          },
                          row.modelLabel || row.model,
                        ),
                        row.efforts?.length
                          ? h(
                              'span',
                              { className: 'tmm-efforts' },
                              row.efforts.map((effort) =>
                                h(
                                  'button',
                                  {
                                    key: effort,
                                    type: 'button',
                                    className: 'tmm-eff',
                                    'data-active': active && state.route.effort === effort ? '1' : '0',
                                    onClick: () => choose({ provider: row.provider, model: row.model, effort }),
                                  },
                                  effort,
                                ),
                              ),
                            )
                          : null,
                      )
                    }),
                  ),
                ),
              ),
              pinned
                ? h('div', { className: 'tmm-clear', onClick: () => choose(null) }, '恢复跟随主对话（清除指定）')
                : null,
              h('div', { className: 'tmm-note' }, '指定后立刻写入成员会话；跟随模式下成员每次步进自动对齐主对话当前模型。'),
            ),
            document.body,
          )
        : null

      return h(React.Fragment, null, trigger, panel)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: 'team-member-model', order: 30 }, TeamMemberModelChip),
        )
        void fetch(`${ENDPOINT}/hello`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ origin: location.origin, scope: 'client-loaded', rev: 2 }),
        }).catch(() => {})
      },
    }
  },
})
