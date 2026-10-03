/**
 * dsh-remote-panel —— DSH 宿主侧插件
 * ============================================================================
 * 一个插件覆盖四件事，全部围绕同一份状态快照：
 *
 *   1. **采集**  周期性通过 SSH / wsl.exe 探测本机 WSL 发行版与远程机器，
 *                把 CPU/内存/磁盘/GPU/Docker/进程/服务聚合成一份快照。
 *   2. **面板**  原子写状态文件，交给独立的 WinUI 3 窗口（`WsxPanel.exe`）渲染。
 *   3. **命令**  `/wsx ...` 给人敲，输出对齐好的纯文本（`commands.js`）。
 *   4. **工具**  `remote_*` 给模型调，输出结构化 JSON（`tools.js`）。
 *
 * 为什么走状态文件而不是让面板连 HTTP：
 *   DSH 的 webServer 有信任栅栏（非回环 Host、未认证请求一律拒绝），外部原生进程
 *   还要自己解决鉴权与端口发现。状态文件零鉴权、零端口、同用户可读，而且天然支持
 *   「窗口比宿主后启动」和「宿主重启后窗口自动接上」两种顺序。
 *
 * 与 dsh-session-hud 的取舍：那个插件只写不读；这个插件要接受命令与工具触发的
 * 「立刻探测」，所以多了一层调度器（`manager.js`）和一个按目标序列化探测的队列。
 */

import { RemoteManager } from './manager.js'
import { registerWsxCommand } from './commands.js'
import { registerRemoteTools } from './tools.js'
import { PanelLauncher, findPanelExecutable, openDataDirectory } from './panel.js'
import { runRemote } from './ssh.js'
import { safe } from './util.js'

export const name = 'dsh-remote-panel'

/** 快照里带上插件版本，方便直接确认「现在跑的是哪一份代码」。 */
const PLUGIN_VERSION = '0.1.1'

/**
 * 网页面板打的路由（见 lib/client.js）。
 * 全部走 POST，并且只接受回环来源 —— 这条路由会触发真实的 SSH 出站连接。
 */
const ROUTES = {
  snapshot: '/dsh-remote-panel/snapshot',
  probe: '/dsh-remote-panel/probe',
  open: '/dsh-remote-panel/open',
}

// ---------------------------------------------------------------------------
// 路由的信任栅栏
// ---------------------------------------------------------------------------

/** Host 头是否指向回环权威（逐段校验，挡掉 `127.0.0.1.evil.com` 这类相似域名）。 */
export function isLoopbackAuthority(host) {
  const name = String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (!name) return false
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1') return true
  const parts = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (!parts) return false
  return parts.slice(1).every((segment) => Number(segment) <= 255)
}

/**
 * 只接受来自本机页面的请求。
 *
 * 宿主自带的栅栏并不覆盖插件注册的路由，而这条路由会**发起 SSH 连接并返回目标机
 * 的系统信息**，所以必须自己挡一层，并且任何异常一律 fail closed。
 *
 * 这里刻意**不**委托 `connection.requestRejection(root, req)`：
 * 那套是为「带 bearer token 的 API 调用」设计的信任模型，而本路由服务的是页面请求
 * （浏览器带的是会话 cookie 与同源头）。实测在已认证的页面上，委托过去会让**合法**
 * 请求也被判掉 —— 表现就是网页面板永远打不开，而且因为 DSH 的页面鉴权守卫会在到达
 * 插件路由之前先返回 403，排查时极易误判成「路由没注册」。
 *
 * 所以只保留自包含的三条判据：回环 Host、非跨站、同源 Origin。这三条已经覆盖了
 * DNS 重绑定、跨站发起与异源嵌入三类攻击面。
 */
function isTrustedRequest(req) {
  try {
    const headers = (req && req.headers) || {}
    const host = String(headers.host || '').toLowerCase()
    if (!isLoopbackAuthority(host)) return false
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false

    const origin = headers.origin
    if (origin) {
      let sameOrigin = false
      try {
        // Origin 是 `null`（file:// 或沙箱 iframe）时 URL 解析失败 → 视为不可信。
        sameOrigin = new URL(String(origin)).host.toLowerCase() === host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) return false
    }
    return true
  } catch {
    return false
  }
}

/** 统一的小 JSON 应答。 */
function sendJson(res, status, body) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  } catch {
    res.statusCode = status
  }
  res.end(JSON.stringify(body))
}

/**
 * 读取 POST body（有上限，避免一个坏客户端把宿主内存撑爆）。
 *
 * 上限到了之后必须**停止累积并销毁请求**：以前只是「提前 resolve」，
 * 但 `req.on('data')` 还挂着，客户端继续发就继续往 `data` 里拼 ——
 * 上限形同虚设，一个不停发 body 的本地客户端就能把宿主内存吃光。
 * 定时器也要 unref + 清理，否则每个请求都会多留一个 1.5 秒的定时器。
 */
export function readBody(req, limit = 65_536) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    let timer = null
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      timer = null
      req.removeListener?.('data', onData)
      req.removeListener?.('end', finish)
      req.removeListener?.('error', finish)
      resolve(data)
    }
    const onData = (chunk) => {
      if (done) return
      data += chunk
      if (data.length > limit) {
        data = data.slice(0, limit)
        finish()
        // 主动断开：既不给对方继续发的机会，也不再占着连接。
        safe(() => req.destroy?.(), undefined)
      }
    }
    req.on('data', onData)
    req.on('end', finish)
    req.on('error', finish)
    // 客户端不发 body 时（例如直接 POST 空请求）不能挂死。
    timer = setTimeout(finish, 1500)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(root, config) {
  const logger = safe(() => root.logger, undefined)
  const manager = new RemoteManager({ rawConfig: config, pluginVersion: PLUGIN_VERSION, logger })
  const panel = new PanelLauncher({
    config: manager.config,
    stateFile: manager.config.stateFile,
    logger,
  })

  if (manager.configErrors.length) {
    logger?.warn?.(`remote-panel: ${manager.configErrors.length} configuration problem(s): ${manager.configErrors.join(' | ')}`)
  }

  // 卸载时收尾：停调度、写「宿主已停止」帧、断开 SSH 控制连接。
  root.effect(() => () => {
    safe(() => manager.dispose(), undefined)
    safe(() => panel.dispose(), undefined)
    // 控制连接是目标机上的进程，不清理会一直挂到 ControlPersist 过期。
    manager.closeConnections().catch(() => {})
  })

  // 探测需要 `shell` 之外的能力吗？不需要 —— 我们直接 spawn ssh.exe / wsl.exe。
  // 所以这里只等最基础的注入，然后就开始跑，不阻塞 DSH 启动。
  root.inject([], () => {
    safe(() => manager.start(), undefined)
  })

  // ---- /wsx 命令 ----
  root.inject(['commands'], (ctx) => {
    const commands = safe(() => ctx.get('commands'), undefined)
    if (!commands || typeof commands.register !== 'function') {
      logger?.warn?.('remote-panel: the commands service is unavailable; /wsx will not be registered')
      return
    }
    const helpers = buildHelpers()
    const dispose = safe(() => registerWsxCommand(ctx, manager, helpers), undefined)
    if (!dispose) {
      // 注册失败必须出声：否则现象只是「/wsx 不存在」，而原因被 safe() 吞掉了。
      logger?.warn?.('remote-panel: registering the /wsx command failed; see the plugin load error above')
      return
    }
    root.effect(() => () => safe(() => dispose(), undefined))
  })

  // ---- 原生工具 ----
  root.inject(['tools'], (ctx) => {
    const tools = safe(() => ctx.get('tools'), undefined)
    if (!tools || typeof tools.register !== 'function') {
      logger?.warn?.('remote-panel: the tools service is unavailable; remote_* tools will not be registered')
      return
    }
    const disposers = safe(() => registerRemoteTools(ctx, manager, buildHelpers()), undefined) ?? []
    if (!disposers.length) logger?.warn?.('remote-panel: no remote_* tool could be registered; /wsx list reports the registration path')
    for (const dispose of disposers) {
      if (typeof dispose === 'function') root.effect(() => () => safe(() => dispose(), undefined))
    }
  })

  // ---- 网页路由（供客户端面板与侧边栏按钮使用）----
  root.inject(['webServer'], (ctx) => {
    const webServer = safe(() => ctx.get('webServer'), undefined)
    if (!webServer || typeof webServer.register !== 'function') return

    const routes = [
      {
        path: ROUTES.snapshot,
        handler: (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.setHeader?.('Allow', 'GET, POST')
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          return sendJson(res, 200, { ok: true, snapshot: manager.snapshot() })
        },
      },
      {
        path: ROUTES.probe,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          if (req.method !== 'POST') {
            res.setHeader?.('Allow', 'POST')
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          let selector = ''
          try {
            const raw = await readBody(req)
            if (raw) selector = String(JSON.parse(raw)?.target ?? '')
          } catch {
            selector = ''
          }
          try {
            await manager.wake(selector || undefined)
            return sendJson(res, 200, { ok: true, snapshot: manager.snapshot() })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error?.message || error) })
          }
        },
      },
      {
        path: ROUTES.open,
        handler: (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          if (req.method !== 'POST') {
            res.setHeader?.('Allow', 'POST')
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          const launched = panel.launch(true)
          return sendJson(res, 200, { ok: launched.ok, launched: launched.launched, exe: launched.exe || null, message: launched.message })
        },
      },
    ]

    for (const route of routes) {
      const dispose = safe(
        () => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        undefined,
      )
      if (!dispose) {
        // 静默失败的后果是「网页面板打不开，但没有任何线索」—— 一定要说出来。
        logger?.warn?.(`remote-panel: could not register the web route ${route.path}; the browser panel will not work`)
        continue
      }
      root.effect(() => () => safe(() => dispose(), undefined))
    }
  })

  /**
   * 命令与工具共用的辅助函数，避免两处各写一遍。
   * 只放**两边都真的会用到**的东西：命令自己 import renderStatus/renderTargetList，
   * 不需要经过这里转发（以前放了，但是死代码，还掩盖了 commands.js 的真实依赖）。
   */
  function buildHelpers() {
    return {
      /** 在目标上执行一条命令。给 `/wsx exec` 用。 */
      execOnTarget: (target, command) => runRemote(target, manager.config, command),
      launchPanel: () => panel.launch(true),
      panelExe: () => findPanelExecutable(manager.config.appPath),
      openDataDirectory: () => openDataDirectory(`${manager.config.dshHome}/remote-panel`),
    }
  }
}

export default { name, apply }
export { PLUGIN_VERSION, ROUTES }
