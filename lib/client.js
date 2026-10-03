/**
 * dsh-remote-panel —— DSH 浏览器半（客户端模块）
 * ============================================================================
 * 两件事：
 *   1. 在侧边栏的全局面板图标区放一个图标，点开在中央栏显示**实时状态面板**
 *      （与 WinUI 3 悬浮窗读同一份快照）；
 *   2. 在侧边栏底部放一个按钮，把原生 WinUI 3 窗口叫出来。
 *
 * 按 DSH 客户端模块的约定写成「往 __ModuleLoader__ 注册一个 lazy factory」：
 *   - 模块 id 必须**等于包名**；
 *   - React 从浏览器模块表拿（`require('react')`），不重复装、不用 CDN；
 *   - factory 返回一个普通 Cordis 插件，用 ctx.slots.inject + register 占座。
 *
 * 几个刻意的选择：
 *   - **走槽位，不碰 DOM**。不猜别的插件的 DOM，也不改 app root。
 *   - **样式只用宿主主题 token**（`--dsw-alias-*`），所以自动跟随明暗主题，
 *     一个硬编码颜色都没有。
 *   - **用 inject 等槽位声明**，槽位还没被声明时会等，插件卸载时自动摘掉。
 *   - **数据走宿主注册的同源路由**（`/dsh-remote-panel/*`），不走 host.call ——
 *     后者是「动态客户端半」的受限面（连 fetch 都没有）。静态客户端模块是正常
 *     浏览器环境，开个路由 + fetch 两端都更直白。
 *
 * 关于鉴权：这两条路由会**发起真实 SSH 连接**并返回目标机的系统信息，
 * 所以宿主侧对它们加了回环信任栅栏（非回环 Host / 跨站 / 异源一律拒），
 * 客户端这边只需照常 fetch 同源地址。
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SNAPSHOT_ENDPOINT = '/dsh-remote-panel/snapshot'
    const PROBE_ENDPOINT = '/dsh-remote-panel/probe'
    const OPEN_ENDPOINT = '/dsh-remote-panel/open'

    /** 面板轮询间隔。快照本身由宿主每 2 秒心跳刷新，1.5 秒轮询足够跟手。 */
    const POLL_MS = 1500
    const FLASH_MS = 1600

    // ---------------------------------------------------------------------
    // 纯函数：格式化
    // ---------------------------------------------------------------------

    function humanBytes(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '—'
      const units = ['B', 'K', 'M', 'G', 'T', 'P']
      let index = 0
      let scaled = num
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      return `${scaled >= 100 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)}${units[index]}`
    }

    function ago(timestamp) {
      if (!timestamp) return '从未'
      const delta = Date.now() - Number(timestamp)
      if (!Number.isFinite(delta) || delta < 0) return '刚刚'
      const seconds = Math.floor(delta / 1000)
      if (seconds < 60) return `${seconds}s 前`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m 前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h 前`
      return `${Math.floor(hours / 24)}d 前`
    }

    const STATUS_STYLE = {
      online: { glyph: '●', token: '--dsw-alias-state-success-primary' },
      offline: { glyph: '✕', token: '--dsw-alias-state-error-primary' },
      probing: { glyph: '…', token: '--dsw-alias-state-warning-primary' },
      unknown: { glyph: '?', token: '--dsw-alias-label-secondary' },
    }

    function statusOf(status) {
      return STATUS_STYLE[status] ?? STATUS_STYLE.unknown
    }

    // ---------------------------------------------------------------------
    // 图标
    // ---------------------------------------------------------------------

    /** 两个重叠的机箱 + 一条连线，表示「多台机器」。纯 SVG，不依赖图标字体。 */
    function RemoteGlyph({ size }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 1.4, y: 2.2, width: 6.4, height: 4.2, rx: 1 }),
        h('rect', { x: 8.2, y: 9.6, width: 6.4, height: 4.2, rx: 1 }),
        h('path', { d: 'M4.6 6.4v3.2a1.6 1.6 0 0 0 1.6 1.6h2' }),
        h('path', { d: 'M2.6 4.3h4' }),
        h('path', { d: 'M9.4 11.7h4' }),
      )
    }

    // ---------------------------------------------------------------------
    // 小组件
    // ---------------------------------------------------------------------

    function Bar({ percent, token }) {
      const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
      return h(
        'div',
        {
          style: {
            position: 'relative',
            height: 4,
            borderRadius: 2,
            background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.25))',
            overflow: 'hidden',
            marginTop: 4,
          },
        },
        h('div', {
          style: {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${clamped}%`,
            borderRadius: 2,
            background: `var(${token})`,
            transition: 'width .3s ease',
          },
        }),
      )
    }

    function Metric({ label, value, percent, token }) {
      return h(
        'div',
        { style: { minWidth: 96, flex: '0 1 140px' } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
          h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' } }, value),
        ),
        percent === undefined ? null : h(Bar, { percent, token }),
      )
    }

    function TargetCard({ target }) {
      const status = statusOf(target.status)
      const metrics = target.metrics || {}
      const cpu = metrics.cpu || {}
      const mem = metrics.memory || {}
      const disks = Array.isArray(metrics.disks) ? metrics.disks.slice(0, 4) : []
      const gpus = Array.isArray(metrics.gpus) ? metrics.gpus : []

      const cpuToken = (cpu.usagePercent ?? 0) >= 90 ? '--dsw-alias-state-error-primary' : '--dsw-alias-state-success-primary'
      const memToken = (mem.usagePercent ?? 0) >= 90 ? '--dsw-alias-state-error-primary' : '--dsw-alias-state-success-primary'

      return h(
        'div',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-2)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
        },
        // 标题行
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: `var(${status.token})`, fontSize: 13, lineHeight: 1 } }, status.glyph),
          h('span', { style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, target.name),
          h(
            'span',
            {
              style: {
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 999,
                border: '1px solid var(--dsw-alias-border-l2)',
                color: 'var(--dsw-alias-label-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '.04em',
              },
            },
            target.kind === 'wsl' ? 'WSL' : 'SSH',
          ),
          h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, target.host),
          h('span', { style: { flex: 1 } }),
          target.latencyMs
            ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } }, `${target.latencyMs}ms`)
            : null,
        ),

        target.status === 'online'
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
              h(Metric, {
                label: 'CPU',
                value: cpu.usagePercent === undefined ? '—' : `${cpu.usagePercent}%`,
                percent: cpu.usagePercent,
                token: cpuToken,
              }),
              h(Metric, {
                label: '内存',
                value:
                  mem.usagePercent === undefined
                    ? '—'
                    : `${mem.usagePercent}% · ${humanBytes(mem.usedBytes)}/${humanBytes(mem.totalBytes)}`,
                percent: mem.usagePercent,
                token: memToken,
              }),
              cpu.load1 !== undefined
                ? h(Metric, { label: '负载', value: `${cpu.load1} ${cpu.load5 ?? ''} ${cpu.load15 ?? ''}`.trim() })
                : null,
              metrics.docker?.available
                ? h(Metric, {
                    label: 'Docker',
                    value: `${metrics.docker.running ?? 0} 运行 / ${metrics.docker.containers ?? 0} 总`,
                  })
                : null,
            )
          : h(
              'div',
              { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' } },
              target.error || (target.status === 'probing' ? '正在探测…' : '还没有探测过'),
            ),

        // 磁盘条
        disks.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              ...disks.map((disk) =>
                h(Metric, {
                  key: disk.mount,
                  label: disk.mount,
                  value: `${disk.usagePercent ?? '—'}% · ${humanBytes(disk.availableBytes)} 可用`,
                  percent: disk.usagePercent,
                  token: (disk.usagePercent ?? 0) >= 90 ? '--dsw-alias-state-error-primary' : '--dsw-alias-state-success-primary',
                }),
              ),
            )
          : null,

        // GPU（有才显示）
        gpus.length
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
              ...gpus.map((gpu, index) =>
                h(Metric, {
                  key: `${gpu.name}-${index}`,
                  label: `GPU${index}`,
                  value:
                    `${gpu.name ?? ''} ${gpu.utilizationPercent === undefined ? '' : `${gpu.utilizationPercent}%`}`.trim() +
                    (gpu.memoryUsedBytes ? ` · ${humanBytes(gpu.memoryUsedBytes)}/${humanBytes(gpu.memoryTotalBytes)}` : ''),
                  percent: gpu.utilizationPercent,
                  token: '--dsw-alias-state-success-primary',
                }),
              ),
            )
          : null,

        // 警告 / 上次探测时间
        h(
          'div',
          { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, `探测于 ${ago(target.lastProbeAt)}`),
          !target.enabled ? h('span', null, '· 已禁用') : null,
          target.consecutiveFailures ? h('span', null, `· 连续失败 ${target.consecutiveFailures} 次`) : null,
          ...(target.warnings || []).map((warning, index) => h('span', { key: index }, `· ${warning}`)),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 状态面板主体
    // ---------------------------------------------------------------------

    function RemotePanel() {
      const [state, setState] = React.useState({ phase: 'loading', snapshot: null, error: '' })
      const [busy, setBusy] = React.useState(false)

      // 轮询快照。用 AbortController 保证卸载后不再 setState。
      React.useEffect(() => {
        const controller = new AbortController()
        let timer = null

        const load = () => {
          fetch(SNAPSHOT_ENDPOINT, { signal: controller.signal, headers: { accept: 'application/json' } })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then((body) => {
              if (controller.signal.aborted) return
              setState({ phase: 'ready', snapshot: body?.snapshot ?? null, error: body?.ok === false ? String(body.error ?? '') : '' })
            })
            .catch((error) => {
              if (controller.signal.aborted || error?.name === 'AbortError') return
              setState((previous) => ({ ...previous, phase: previous.snapshot ? 'ready' : 'error', error: String(error?.message || error) }))
            })
            .finally(() => {
              if (!controller.signal.aborted) timer = setTimeout(load, POLL_MS)
            })
        }

        load()
        return () => {
          controller.abort()
          if (timer) clearTimeout(timer)
        }
      }, [])

      const probeNow = () => {
        if (busy) return
        setBusy(true)
        fetch(PROBE_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((response) => response.json())
          .then((body) => {
            if (body?.snapshot) setState({ phase: 'ready', snapshot: body.snapshot, error: body.ok === false ? String(body.error ?? '') : '' })
          })
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      const openWindow = () => {
        fetch(OPEN_ENDPOINT, { method: 'POST', headers: { accept: 'application/json' } }).catch(() => {})
      }

      const snapshot = state.snapshot
      const totals = snapshot?.totals

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            gap: 12,
            padding: 16,
            boxSizing: 'border-box',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        // 头部
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 15, fontWeight: 600 } }, '远程目标状态'),
          totals
            ? h(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                `${totals.targets} 个目标 · ${totals.online} 在线 · ${totals.offline} 离线${totals.probing ? ` · ${totals.probing} 探测中` : ''}`,
              )
            : null,
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: probeNow,
              disabled: busy,
              style: {
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            },
            busy ? '探测中…' : '立即探测',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: openWindow,
              title: '打开独立的 WinUI 3 悬浮窗',
              style: {
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: 'pointer',
              },
            },
            '打开悬浮窗',
          ),
        ),

        // 状态行
        h(
          'div',
          { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
          state.phase === 'error'
            ? `无法读取快照：${state.error}`
            : snapshot
              ? `快照更新于 ${ago(snapshot.generatedAt)}${snapshot.host?.stopped ? ' · 宿主已停止' : ''}`
              : '正在读取…',
        ),

        // 宿主侧的配置问题（被跳过的目标）
        snapshot?.host?.configErrors?.length
          ? h(
              'div',
              {
                style: {
                  border: '1px solid var(--dsw-alias-state-warning-primary)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 11.5,
                  color: 'var(--dsw-alias-label-primary)',
                },
              },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '配置问题'),
              ...snapshot.host.configErrors.map((error, index) => h('div', { key: index }, `· ${error}`)),
            )
          : null,

        // 目标列表
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 } },
          !snapshot
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '正在读取状态文件…')
            : snapshot.targets.length === 0
              ? h(
                  'div',
                  { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 } },
                  '还没有配置任何目标。在 profile 的 cordis.patch.yml 里给 dsh-remote-panel 这一行加上 targets，然后重启 DSH。',
                )
              : snapshot.targets.map((target) => h(TargetCard, { key: target.id, target })),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 侧边栏底部的「打开悬浮窗」按钮
    // ---------------------------------------------------------------------

    function OpenWindowButton() {
      const [state, setState] = React.useState('idle')
      const [hover, setHover] = React.useState(false)

      const open = () => {
        if (state === 'busy') return
        setState('busy')
        fetch(OPEN_ENDPOINT, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((body) => {
            setState(body?.ok ? 'ok' : 'err')
            setTimeout(() => setState('idle'), FLASH_MS)
          })
          .catch(() => {
            setState('err')
            setTimeout(() => setState('idle'), FLASH_MS + 600)
          })
      }

      const color =
        state === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : state === 'err'
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-secondary)'

      const title =
        state === 'busy'
          ? '正在打开…'
          : state === 'ok'
            ? '已请求打开悬浮窗'
            : state === 'err'
              ? '打开失败（可能还没构建 WsxPanel.exe）'
              : '打开远程状态悬浮窗'

      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': '打开远程状态悬浮窗',
          onClick: open,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 0,
            borderRadius: 6,
            background: hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color,
            cursor: state === 'busy' ? 'default' : 'pointer',
            opacity: state === 'busy' ? 0.55 : 1,
            transition: 'background-color .12s ease, color .12s ease',
          },
        },
        h(RemoteGlyph, { size: 16 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 全局面板图标：**id 必须与下面 main 的 key 一致**，侧边栏按钮和
        // 中央面板就是靠这个 id 配对的。侧边栏自己负责画按钮，这里只给图标。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'remote-panel',
              order: 20,
              label: '远程目标',
            },
            ({ size }) => h(RemoteGlyph, { size }),
          ),
        )

        // 中央栏里那个面板本体。keyed 槽位用 key 声明自己占哪一格。
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'remote-panel',
            },
            RemotePanel,
          ),
        )

        // 侧边栏底部：把独立的 WinUI 3 悬浮窗叫出来。
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-remote-panel-open',
              order: 20,
              label: '打开远程状态悬浮窗',
            },
            OpenWindowButton,
          ),
        )
      },
    }
  },
})
