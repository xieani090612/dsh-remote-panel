/**
 * dsh-remote-panel —— 运行时状态与快照
 * ============================================================================
 * 每个目标在内存里维护一条 `TargetRuntime`（最新指标、滚动历史、失败计数），
 * 由 `SnapshotBuilder` 组装成面板读的那份 JSON。
 *
 * 落盘策略与 dsh-session-hud 一致：
 *   - **原子替换**（临时文件 + rename），读者永远看不到半截 JSON；
 *   - **无条件心跳**：即使没有任何目标在变，也定期重写快照，
 *     否则 DSH 空闲时面板会把「没有新数据」误判成「宿主已退出」。
 */

import { writeFileAtomicSync } from './util.js'

const SCHEMA_VERSION = 1

/** 一个目标的可变运行时状态。 */
export class TargetRuntime {
  constructor(target) {
    this.target = target
    this.status = 'unknown' // unknown | probing | online | offline
    this.error = ''
    this.latencyMs = 0
    this.lastProbeAt = 0
    this.lastOnlineAt = 0
    this.nextProbeAt = 0
    this.consecutiveFailures = 0
    this.woke = false
    this.facts = {}
    this.metrics = null
    this.history = []
    this.warnings = []
  }

  get id() {
    return this.target.id
  }

  markProbing() {
    if (this.status !== 'online') this.status = 'probing'
  }

  markOnline({ metrics, facts, latencyMs, woke, warnings }, historyLength, now) {
    this.status = 'online'
    this.error = ''
    this.latencyMs = latencyMs
    this.lastProbeAt = now
    this.lastOnlineAt = now
    this.consecutiveFailures = 0
    this.woke = Boolean(woke)
    this.warnings = Array.isArray(warnings) ? warnings : []
    // 静态信息只在拿到新值时覆盖：某些精简系统上 hostname 可能偶发读不到，
    // 不该因此把上一次读到的好值抹掉。
    if (facts && Object.keys(facts).length) {
      this.facts = { ...this.facts, ...facts }
    }
    if (metrics) this.metrics = metrics
    this.pushHistory(historyLength, now)
  }

  markOffline(error, now, historyLength) {
    this.status = 'offline'
    this.error = error || 'probe failed'
    this.lastProbeAt = now
    this.consecutiveFailures += 1
    this.latencyMs = 0
    this.woke = false
    // 失败样本必须真的进历史：以前这里传的是 0，而 `pushHistory(0)` 直接返回，
    // 于是「趋势线在失败处断开」这条注释描述的行为从来没发生过。
    this.pushHistory(historyLength, now, false)
  }

  /**
   * 滚动历史只保留 cpu/mem/latency 三个数，用于面板上那几条迷你趋势线。
   * 失败时推入一条 latency=0、**不带 cpu/mem** 的样本：趋势线会明显「断」一下，
   * 比悄悄跳过更能说明问题；带上一次的旧 cpu/mem 则会伪装成一次正常采样。
   */
  pushHistory(historyLength, now, includeMetrics = true) {
    if (!historyLength) return
    const sample = {
      at: now,
      latencyMs: this.latencyMs || 0,
    }
    const cpu = includeMetrics ? this.metrics?.cpu?.usagePercent : undefined
    const mem = includeMetrics ? this.metrics?.memory?.usagePercent : undefined
    if (typeof cpu === 'number') sample.cpuPercent = cpu
    if (typeof mem === 'number') sample.memPercent = mem
    this.history.push(sample)
    if (this.history.length > historyLength) {
      this.history.splice(0, this.history.length - historyLength)
    }
  }

  toJSON(now) {
    const staleMs = this.lastProbeAt ? Math.max(0, now - this.lastProbeAt) : 0
    return {
      id: this.target.id,
      name: this.target.name,
      kind: this.target.kind,
      host: this.target.kind === 'wsl' ? this.target.distro : this.target.host,
      user: this.target.user || '',
      port: this.target.kind === 'ssh' ? this.target.port : undefined,
      tags: this.target.tags,
      enabled: this.target.enabled,
      status: this.status,
      error: this.error || undefined,
      latencyMs: this.latencyMs || undefined,
      lastProbeAt: this.lastProbeAt || undefined,
      lastOnlineAt: this.lastOnlineAt || undefined,
      nextProbeAt: this.nextProbeAt || undefined,
      staleMs: this.lastProbeAt ? staleMs : undefined,
      consecutiveFailures: this.consecutiveFailures,
      woke: this.woke || undefined,
      warnings: this.warnings.length ? this.warnings : undefined,
      facts: Object.keys(this.facts).length ? this.facts : undefined,
      metrics: this.metrics ?? null,
      history: this.history,
      // 运维视角最关心的两个派生值，直接算好给面板，省得两端重复实现。
      diskCritical: criticalDisks(this.metrics),
      cpuCount: this.facts?.cpuCount,
    }
  }
}

/** 占用率 >= 90% 的挂载点，面板会标红。 */
function criticalDisks(metrics) {
  const disks = metrics?.disks
  if (!Array.isArray(disks)) return undefined
  const critical = disks.filter((d) => (d?.usagePercent ?? 0) >= 90).map((d) => d.mount)
  return critical.length ? critical : undefined
}

/**
 * 排序：出错优先 → 离线 → 探测中 → 在线；同档按名字。
 * 面板直接按这个顺序渲染，最需要人看的目标永远在最上面。
 */
const STATUS_RANK = { offline: 0, probing: 1, unknown: 2, online: 3 }

export function sortTargets(list) {
  return list.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9
    const rb = STATUS_RANK[b.status] ?? 9
    if (ra !== rb) return ra - rb
    // 离线目标里，连续失败次数多的更值得先看。
    if (a.status === 'offline' && b.status === 'offline') {
      if (a.consecutiveFailures !== b.consecutiveFailures) {
        return b.consecutiveFailures - a.consecutiveFailures
      }
    }
    return String(a.name).localeCompare(String(b.name))
  })
}

/** 组装并落盘快照。 */
export class SnapshotStore {
  constructor({ stateFile, pluginVersion, dshHome, configErrors = [] }) {
    this.stateFile = stateFile
    this.pluginVersion = pluginVersion
    this.dshHome = dshHome
    this.configErrors = configErrors
    this.startedAt = Date.now()
    this.revision = 0
    this.lastWriteError = ''
    this.lastWrittenAt = 0
  }

  build(runtimes, extra = {}) {
    const now = Date.now()
    const targets = sortTargets(runtimes.map((runtime) => runtime.toJSON(now)))

    const errors = []
    for (const target of targets) {
      if (target.status === 'offline') {
        errors.push({
          targetId: target.id,
          name: target.name,
          error: target.error || 'probe failed',
          at: target.lastProbeAt,
          consecutiveFailures: target.consecutiveFailures,
        })
      }
    }

    const dockerRunning = targets.reduce(
      (sum, t) => sum + (t.status === 'online' && typeof t.metrics?.docker?.running === 'number' ? t.metrics.docker.running : 0),
      0,
    )

    return {
      schema: SCHEMA_VERSION,
      generatedAt: now,
      host: {
        pid: process.pid,
        pluginVersion: this.pluginVersion,
        stateFile: this.stateFile,
        dshHome: this.dshHome,
        platform: process.platform,
        startedAt: this.startedAt,
        revision: this.revision,
        error: this.lastWriteError || undefined,
        configErrors: this.configErrors.length ? this.configErrors : undefined,
      },
      totals: {
        targets: targets.length,
        online: targets.filter((t) => t.status === 'online').length,
        offline: targets.filter((t) => t.status === 'offline').length,
        probing: targets.filter((t) => t.status === 'probing').length,
        unknown: targets.filter((t) => t.status === 'unknown').length,
        dockerRunning,
      },
      targets,
      errors,
      ...extra,
    }
  }

  /** 同步写：定时器与 dispose() 都在同步上下文里调用它。 */
  write(runtimes, extra = {}) {
    this.revision += 1
    const snapshot = this.build(runtimes, extra)
    try {
      writeFileAtomicSync(this.stateFile, JSON.stringify(snapshot))
      this.lastWriteError = ''
      this.lastWrittenAt = Date.now()
    } catch (error) {
      this.lastWriteError = String(error?.message || error)
    }
    return snapshot
  }

  /** 收尾帧：面板据此显示「宿主已停止」，而不是等超时。 */
  writeStopped() {
    const payload = {
      schema: SCHEMA_VERSION,
      generatedAt: Date.now(),
      host: {
        pid: process.pid,
        pluginVersion: this.pluginVersion,
        stateFile: this.stateFile,
        dshHome: this.dshHome,
        stopped: true,
        revision: this.revision,
      },
      totals: { targets: 0, online: 0, offline: 0, probing: 0, unknown: 0, dockerRunning: 0 },
      targets: [],
      errors: [],
    }
    try {
      writeFileAtomicSync(this.stateFile, JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }
}

export { SCHEMA_VERSION }
