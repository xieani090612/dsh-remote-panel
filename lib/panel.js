/**
 * dsh-remote-panel —— 面板进程管理
 * ============================================================================
 * 负责找到并拉起 WinUI 3 预览面板（`WsxPanel.exe`），以及打开数据目录。
 *
 * 与 dsh-session-hud 的做法一致：宿主半只负责「把窗口叫起来」，
 * 数据通过状态文件传递。窗口自带单实例互斥体，所以重复拉起只会把已有窗口前置，
 * 不会开出第二个。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 面板 exe 的查找顺序：
 *   1. 配置里手写的路径（优先级最高）；
 *   2. `dist/` —— 随包发布的正式位置（build.ps1 -Pack 的产出）；
 *   3. 本地开发构建的输出，publish → Release → Debug 依次兜底。
 */
const APP_RELATIVE_CANDIDATES = [
  path.join('dist', 'WsxPanel.exe'),
  path.join('app', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'publish', 'WsxPanel.exe'),
  path.join('app', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'WsxPanel.exe'),
  path.join('app', 'bin', 'Debug', 'net8.0-windows10.0.19041.0', 'win-x64', 'WsxPanel.exe'),
]

/** 找到面板可执行文件；找不到返回空串（调用方负责给出可操作的提示）。 */
export function findPanelExecutable(explicitPath) {
  const candidates = []
  if (explicitPath) candidates.push(String(explicitPath))
  for (const relative of APP_RELATIVE_CANDIDATES) candidates.push(path.join(PACKAGE_ROOT, relative))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return ''
}

export class PanelLauncher {
  constructor({ config, stateFile, logger }) {
    this.config = config
    this.stateFile = stateFile
    this.logger = logger
    this.child = null
    this.childExited = true
  }

  get exePath() {
    return findPanelExecutable(this.config?.appPath)
  }

  isAlive() {
    return !this.childExited && Boolean(this.child)
  }

  /**
   * 拉起面板。返回 `{ ok, launched, exe, message }` —— 不是布尔，
   * 因为调用方（命令/工具/路由）都需要一句能直接展示给用户的话。
   */
  launch(force = false) {
    if (!force && this.config?.autoLaunch === false) {
      return { ok: false, launched: false, exe: '', message: '面板自动启动已被配置关闭（autoLaunch: false）。用 /wsx panel 可以手动打开。' }
    }
    const exe = this.exePath
    if (!exe) {
      return {
        ok: false,
        launched: false,
        exe: '',
        message:
          '找不到面板可执行文件 WsxPanel.exe。先在插件目录运行 build.ps1 -Pack 生成 dist\\WsxPanel.exe，' +
          '或在插件配置里用 appPath 指定它的绝对路径。',
      }
    }
    if (this.isAlive()) {
      return { ok: true, launched: false, exe, message: `面板已经在运行（${exe}），已请求前置。` }
    }
    try {
      // detached + unref：面板是独立进程，DSH 退出后它自己决定何时关闭。
      // --exit-after-stale 90 让它在宿主心跳消失 90 秒后自行退出，避免留下空窗口。
      this.child = spawn(exe, ['--state', this.stateFile, '--exit-after-stale', '90'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.dirname(exe),
      })
      this.childExited = false
      this.child.on('exit', () => {
        this.childExited = true
        this.child = null
      })
      this.child.on('error', (error) => {
        this.logger?.warn?.(`remote-panel: cannot launch panel: ${error?.message ?? error}`)
        this.childExited = true
        this.child = null
      })
      this.child.unref()
      return { ok: true, launched: true, exe, message: `已启动面板窗口（${exe}）。` }
    } catch (error) {
      this.childExited = true
      this.child = null
      return { ok: false, launched: false, exe, message: `启动面板失败：${error?.message ?? error}` }
    }
  }

  /** 让窗口知道宿主还活着；面板自己按 state file 的 generatedAt 判定。 */
  dispose() {
    // 刻意不 kill 面板：它有自己的 --exit-after-stale 兜底，
    // 而且用户可能就是想让它留在屏幕上看最后一份快照。
    this.child = null
    this.childExited = true
  }
}

/** 打开数据目录（Windows 资源管理器 / 其它平台交给系统默认程序）。 */
export function openDataDirectory(dir) {
  const target = path.resolve(dir)
  try {
    if (process.platform === 'win32') {
      // explorer 打开目录时的退出码常常是 1，所以不看返回值。
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
    }
    return `已请求打开 ${target}`
  } catch (error) {
    return `无法打开 ${target}：${error?.message ?? error}`
  }
}

export { PACKAGE_ROOT, APP_RELATIVE_CANDIDATES }
