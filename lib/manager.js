/**
 * dsh-remote-panel —— 调度与编排
 * ============================================================================
 * 把「目标列表 + 传输层 + 采集解析 + 快照落盘」串起来：
 *   - 按 probeIntervalMs 调度每个目标的探测，带**并发上限**；
 *   - 离线目标按指数退避降频，避免对着不可达主机反复打；
 *   - 冷启动时把首次探测**错开**（stagger），否则一次加载会同时起 N 条 ssh；
 *   - 无条件心跳重写快照，让面板能区分「没有数据变化」与「宿主已退出」。
 *
 * 设计取舍：调度用**一个** setInterval 扫描「该探测谁了」，而不是每个目标一个定时器。
 * 目标数量在这里是「几十」量级，单循环足够便宜，但换来的是退避逻辑只写一处、
 * 而且插件卸载时只需要清一个定时器（少一个泄漏面）。
 */

import path from 'node:path'
import { normalizeConfig, resolveTargetSelector, targetLabel } from './config.js'
import { buildProbeCommand, parseProbeOutput } from './probe.js'
import { closeControlConnections, runRemote } from './ssh.js'
import { SnapshotStore, TargetRuntime } from './state.js'
import { clamp, flatten, writeFileAtomicSync } from './util.js'

/** 离线退避上限：再多也不会超过这个间隔，避免一个宕机很远的机器永远不重试。 */
const MAX_BACKOFF_MULTIPLIER = 8

/**
 * WSL 冷启动的判定阈值（毫秒）。
 *
 * 面板上那个「冷启动」角标（app/MainWindow.xaml）唯一的输入就是快照里的 `woke`，
 * 而这个字段以前写的是 `reason === 'wake'` —— 调用方只会传
 * `startup` / `scheduled` / `manual`，所以它**永远是 false**，角标从来没亮过。
 *
 * 改成按耗时判定：本机实测热探测 2–4s（channel: wsl）、约 80ms（SSH 连接复用），
 * 而 README「坑 2」记的冷启动代价是 18–88s —— 取 10s 作阈值两边都不会误判。
 * 只对 `kind: wsl` 的目标生效：远程 SSH 机器慢是网络问题，不是冷启动。
 */
const WSL_COLD_START_MS = 10_000

export function isColdStartWsl(target, latencyMs) {
  return target?.kind === 'wsl' && Number(latencyMs) >= WSL_COLD_START_MS
}

/**
 * 把规范化后的配置落盘成 JSON。
 *
 * 为什么需要：独立的 MCP 服务器进程（`bin/mcp-server.js`）必须看到**同一份**
 * 目标清单，但它读不到 DSH 的 cordis.patch.yml（那是 YAML，还带 `!!js` 表达式，
 * 且每个 profile 的层栈不同）。所以由宿主半把自己**已经解析好**的配置写出来，
 * MCP 侧直接读这份 JSON。这样两边永远一致，也不需要在 MCP 侧重新实现配置合并。
 */
export function resolvedConfigPath(stateFile) {
  return path.join(path.dirname(stateFile), 'config.resolved.json')
}

export class RemoteManager {
  constructor({ rawConfig, pluginVersion, logger, writeState = true }) {
    const normalized = normalizeConfig(rawConfig)
    this.config = normalized.config
    this.configErrors = normalized.errors
    this.logger = logger
    this.writeState = writeState

    this.runtimes = this.config.targets
      .filter((target) => target.enabled)
      .map((target) => new TargetRuntime(target))

    this.store = new SnapshotStore({
      stateFile: this.config.stateFile,
      pluginVersion,
      dshHome: this.config.dshHome,
      configErrors: this.configErrors,
    })

    this.running = false
    this.disposed = false
    this.tickTimer = null
    this.inFlight = new Set()
    this.activeProbes = 0
    this.lastHeartbeatAt = 0
    this.wakeRequested = false
    this.lastWriteError = ''
  }

  /**
   * 把解析后的配置写给独立进程（MCP 服务器）用。
   * 失败不致命 —— 只是 MCP 侧要靠 DSH_WSX_CONFIG 环境变量兜底。
   */
  persistResolvedConfig() {
    try {
      const payload = {
        generatedAt: Date.now(),
        stateFile: this.config.stateFile,
        config: this.config,
      }
      writeFileAtomicSync(resolvedConfigPath(this.config.stateFile), JSON.stringify(payload, null, 2))
      return true
    } catch (error) {
      this.logger?.warn?.(`remote-panel: cannot write resolved config: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 解析目标选择器。歧义时**不猜**：把候选交回调用方（工具与命令都用这个，
   * 保证同一个选择器在两条路径上指向同一台机器）。
   */
  resolveTarget(selector) {
    return resolveTargetSelector(this.runtimes.map((r) => r.target), selector)
  }

  /** 唯一匹配的目标；没匹配上或有歧义时返回 undefined。 */
  getTarget(selector) {
    return this.resolveTarget(selector).target
  }

  runtimeFor(targetId) {
    return this.runtimes.find((r) => r.id === targetId)
  }

  /** 每个目标的下一次探测时间。离线时按连续失败次数退避。 */
  scheduleNext(runtime, now) {
    const base = this.config.probeIntervalMs
    const multiplier = runtime.status === 'offline'
      ? clamp(2 ** Math.min(runtime.consecutiveFailures - 1, 3), 1, MAX_BACKOFF_MULTIPLIER)
      : 1
    runtime.nextProbeAt = now + base * multiplier
  }

  // -------------------------------------------------------------------------
  // 探测
  // -------------------------------------------------------------------------

  /**
   * 探测单个目标并更新运行时状态。
   * 这个方法**永不抛异常** —— 探测失败是正常业务，不是错误上抛的理由。
   */
  async probeTarget(target, { reason = 'scheduled' } = {}) {
    const runtime = this.runtimeFor(target.id)
    if (!runtime) return undefined
    // `enabled: false` 是「完全不要碰网络」的意思，所以所有探测路径都在这里收口 ——
    // 它是唯一入口，包括 /wsx probe 与工具触发的 refresh。
    if (!this.config.enabled) return undefined
    if (this.inFlight.has(target.id)) return undefined

    this.inFlight.add(target.id)
    this.activeProbes += 1
    runtime.markProbing()
    const startedAt = Date.now()

    try {
      const command = buildProbeCommand()
      // 超时不在这里写死：runRemote 会按目标解析（targets[].timeoutMs 可覆盖全局值）。
      const result = await runRemote(target, this.config, command, {})
      const latencyMs = Date.now() - startedAt

      if (!result.ok) {
        runtime.markOffline(result.error || `probe failed (exit ${result.code})`, Date.now(), this.config.historyLength)
        this.logger?.debug?.(`remote-panel: ${targetLabel(target)} probe failed (${reason}): ${runtime.error}`)
      } else if (!result.stdout.includes('@@@')) {
        // 连得上但拿不到分节输出：多半不是 POSIX 系统（或命令被中间层吞了）。
        runtime.markOffline(
          `connected over ${result.channel} but the probe produced no sections — is this a POSIX host? ${flatten(result.stderr, 200)}`,
          Date.now(),
          this.config.historyLength,
        )
      } else {
        const parsed = parseProbeOutput(result.stdout, result.stderr, {
          collectDocker: this.config.collectDocker,
          collectProcesses: this.config.collectProcesses,
          collectServices: this.config.collectServices,
          collectGpu: this.config.collectGpu,
        })
        runtime.markOnline(
          {
            metrics: parsed.metrics,
            facts: parsed.facts,
            latencyMs,
            woke: isColdStartWsl(target, latencyMs),
            warnings: parsed.warnings,
          },
          this.config.historyLength,
          Date.now(),
        )
        if (parsed.warnings.length) {
          this.logger?.debug?.(`remote-panel: ${targetLabel(target)} probe warnings (${reason}): ${parsed.warnings.join(' | ')}`)
        }
      }
    } catch (error) {
      // 兜底：任何意外都不该让调度循环停摆。
      runtime.markOffline(flatten(error?.message || error, 400), Date.now(), this.config.historyLength)
    } finally {
      this.inFlight.delete(target.id)
      this.activeProbes -= 1
      this.scheduleNext(runtime, Date.now())
    }

    return runtime
  }

  /** 立刻探测全部目标（`/wsx probe` 与冷启动用）。 */
  async probeAll({ concurrency = this.config.maxConcurrentProbes } = {}) {
    const queue = this.runtimes.map((r) => r.target)
    const limit = clamp(concurrency, 1, 32)
    const results = []

    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const target = queue.shift()
        if (!target) break
        results.push(await this.probeTarget(target))
      }
    })
    await Promise.all(workers)
    this.writeSnapshot()
    return results.filter(Boolean)
  }

  /**
   * 唤醒：立刻探测指定目标（或全部）。
   * 用于 `/wsx probe <target>`、路由按钮，以及「面板刚打开时想要新鲜数据」。
   */
  async wake(selector) {
    if (!this.config.enabled) {
      throw new Error('probing is disabled: this plugin is configured with enabled: false, so it never touches the network.')
    }
    if (selector) {
      const target = this.getTarget(selector)
      if (!target) throw new Error(`no target matching ${JSON.stringify(selector)}`)
      await this.probeTarget(target, { reason: 'manual' })
      this.writeSnapshot()
      return [this.runtimeFor(target.id)]
    }
    return this.probeAll()
  }

  // -------------------------------------------------------------------------
  // 调度循环
  // -------------------------------------------------------------------------

  start() {
    if (this.running || this.disposed) return
    this.running = true

    // 独立的 MCP 进程要靠这份文件拿到同一份目标清单。
    if (this.writeState) this.persistResolvedConfig()

    if (!this.config.enabled) {
      // 这条一定要出声：配了 enabled: false 的人会看到「面板一直是 unknown」，
      // 不说清楚就会被当成故障排查半天。
      this.logger?.warn?.(
        'remote-panel: enabled=false — probing is disabled, so every target will stay "unknown". ' +
          'Remove "enabled: false" from the plugin config (row dsh-remote-panel in cordis.patch.yml) to resume.',
      )
    }

    // 先落一份「还没有数据」的快照：面板一起来就知道有哪些目标，
    // 而不是先显示一个空窗口等第一次探测。
    this.writeSnapshot()

    if (this.config.probeOnStart && this.config.enabled) {
      // 错开首次探测：第 i 个目标延后 i × min(interval, 400ms)。
      // 一次性并发起几十条 ssh 会让冷启动瞬间很难看，而且容易被目标机的
      // sshd MaxStartups 限流。
      const staggerMs = Math.min(400, Math.max(50, Math.floor(this.config.probeIntervalMs / 10)))
      const startedAt = Date.now()
      this.runtimes.forEach((runtime, index) => {
        const delay = index * staggerMs
        // 错峰时间同时写进 nextProbeAt —— tick() 只认 nextProbeAt，
        // 而它每 flushIntervalMs（默认 500ms）就跑一次。以前 nextProbeAt 是 0
        // （「从没探过」= 立刻到期），所以第一次 tick 会把还没到点的目标全部抢跑，
        // 错峰只在最初 500ms 内有效。目标一多就等于没做。
        runtime.nextProbeAt = startedAt + delay
        const timer = setTimeout(() => {
          if (this.disposed) return
          this.probeTarget(runtime.target, { reason: 'startup' })
            .then(() => this.writeSnapshot())
            .catch(() => {})
        }, delay)
        if (typeof timer.unref === 'function') timer.unref()
      })
    }

    this.tickTimer = setInterval(() => this.tick(), this.config.flushIntervalMs)
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref()
  }

  /** 每个 flush 周期跑一次：决定要探测谁、要不要心跳落盘。 */
  tick() {
    if (this.disposed) return
    const now = Date.now()
    try {
      const capacity = Math.max(0, this.config.maxConcurrentProbes - this.activeProbes)
      if (capacity > 0) {
        const due = this.runtimes
          .filter((r) => !this.inFlight.has(r.id) && (r.nextProbeAt === 0 || r.nextProbeAt <= now))
          .sort((a, b) => (a.nextProbeAt || 0) - (b.nextProbeAt || 0))
          .slice(0, capacity)

        for (const runtime of due) {
          this.probeTarget(runtime.target, { reason: 'scheduled' })
            .then(() => this.writeSnapshot())
            .catch(() => {})
        }
      }

      // 心跳只在到期时落盘。tick() 本身每 flushIntervalMs 跑一次，
      // 在这里无条件写就等于把 heartbeatMs 变成死配置（默认快 4 倍）。
      if (now - this.lastHeartbeatAt >= this.config.heartbeatMs) {
        this.lastHeartbeatAt = now
        this.writeSnapshot()
      }
    } catch (error) {
      this.logger?.warn?.(`remote-panel: scheduler tick failed: ${flatten(error?.message || error, 200)}`)
    }
  }

  /**
   * 落盘。**调用它就意味着「该写了」** —— 数据变了、心跳到期、或者收尾帧。
   *
   * 旧签名是 `writeSnapshot(force)`，但 `force` 从头到尾没被读过：tick() 每
   * flushIntervalMs（500ms）就 JSON.stringify 整份历史并同步写一次文件，
   * 而 heartbeatMs（2000ms）毫无作用。探测间隔 15s 的场景下这是纯浪费 ——
   * 而且每次写都在主线程上同步做。
   */
  writeSnapshot() {
    if (this.disposed) return undefined
    // 独立 MCP 进程只读不写：多个进程同时写状态文件会让面板看到别人的帧，
    // 也会让心跳互相覆盖。
    if (!this.writeState) return this.snapshot()
    const snapshot = this.store.write(this.runtimes, {})
    this.reportWriteError(this.store.lastWriteError)
    return snapshot
  }

  /**
   * 状态文件写失败的告警**只在错误变化时报一次**。
   * 写盘是心跳级频率（默认 2s），磁盘满或路径不可写时会一直失败 ——
   * 每 2 秒刷一条同样的告警会把宿主日志冲掉，反而看不到真正的原因。
   */
  reportWriteError(error) {
    const text = String(error || '')
    if (text === this.lastWriteError) return
    const previous = this.lastWriteError
    this.lastWriteError = text
    if (!text) {
      this.logger?.warn?.(`remote-panel: state file writes recovered (${this.config.stateFile})`)
      return
    }
    this.logger?.warn?.(
      `remote-panel: cannot write the state file ${this.config.stateFile}: ${text}` +
        ' — check that the directory is writable and the disk is not full;' +
        ' the panel keeps showing the last snapshot it managed to read.' +
        (previous ? ` (previous error: ${previous})` : ''),
    )
  }

  /** 最近一次快照（不落盘），供命令与工具直接读。 */
  snapshot() {
    return this.store.build(this.runtimes)
  }

  /** 主动断开控制连接，释放目标机上的 master 进程。 */
  async closeConnections() {
    try {
      return await closeControlConnections(this.runtimes.map((r) => r.target), this.config)
    } catch {
      return []
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    // 收尾帧让面板立刻显示「宿主已停止」，而不是干等超时。
    // 独立 MCP 进程不写：它退出不代表宿主没了。
    if (this.writeState) this.store.writeStopped()
  }
}
