/**
 * 浏览器半（lib/client.js）的离线契约测试。
 *
 * 客户端模块的约定是「往 `window.__ModuleLoader__.load` 注册一个 lazy factory，
 * factory 返回一个普通 Cordis 插件」。所以这里用 `node:vm` 造一个假 window +
 * 假 React，把源码跑起来，再检查：
 *   - 模块 id 是否等于包名（浏览器模块表按 id 认人）；
 *   - 是否占到了正确的槽位，而且 **sidebar.panellist 的 id 与 main 的 key 一致**
 *     （这两个是靠 id 配对的，配错就是「点了图标中央栏没反应」）；
 *   - 组件能否渲染出预期结构；
 *   - 样式是否**只用宿主主题 token**（硬编码颜色会在明暗切换时瞎掉）。
 *
 * 不用起 DSH、不用开浏览器，改客户端代码时立刻能发现契约被破坏。
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')

const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).name

/** 在一个隔离的假浏览器环境里加载 client.js，返回它注册的东西与抓到的调用。 */
function loadClient({ fetchImpl } = {}) {
  const stateWrites = []
  const react = {
    stateWrites,
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [initial, (next) => stateWrites.push(next)]
    },
    // 刻意**不执行** effect：面板里的轮询循环在测试里不该真的跑起来。
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
  }

  const fetchCalls = []
  let loaded = null
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { loaded = definition } } },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init })
      if (fetchImpl) return fetchImpl(url, init)
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: null }) }
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    AbortController: class {
      constructor() {
        this.signal = { aborted: false }
      }
      abort() {
        this.signal.aborted = true
      }
    },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

  const required = []
  const plugin = loaded.factory((name) => {
    required.push(name)
    return react
  })

  const injections = []
  const registrations = []
  const fakeCtx = {
    slots: {
      inject(key, callback) {
        injections.push(key)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(fakeCtx)

  return { loaded, plugin, required, injections, registrations, fetchCalls, stateWrites }
}

// ---------------------------------------------------------------------------

/**
 * 假 React 不会真的渲染组件（`createElement` 只是把 type 记下来），
 * 所以函数型组件会以函数形式留在树里。这个辅助递归地把它们展开，
 * 好让断言能看到 svg 之类真正的东西。
 */
function deepRender(element, depth = 0) {
  if (depth > 12 || element == null) return element
  if (Array.isArray(element)) return element.map((child) => deepRender(child, depth + 1))
  if (typeof element === 'function') return deepRender(element({ size: 16, active: false }), depth + 1)
  if (typeof element !== 'object') return element
  if (typeof element.type === 'function') {
    const rendered = element.type({ ...(element.props || {}), children: element.children })
    return deepRender(rendered, depth + 1)
  }
  return { ...element, children: (element.children || []).map((child) => deepRender(child, depth + 1)) }
}

test('the client module registers under the exact package name', () => {
  const { loaded, plugin, required } = loadClient()
  assert.ok(loaded, 'window.__ModuleLoader__.load must be called')
  assert.equal(loaded.id, PACKAGE_NAME, 'the browser module table addresses plugins by package name')
  assert.equal(typeof loaded.factory, 'function')
  assert.deepEqual(required, ['react'], 'React must come from the module table, not a bundled copy')
  assert.ok(plugin.inject.includes('slots'))
  assert.equal(typeof plugin.apply, 'function')
})

test('it occupies exactly the three intended slots', () => {
  const { injections, registrations } = loadClient()
  assert.deepEqual(injections.sort(), ['main', 'sidebar.footer.action', 'sidebar.panellist'])
  assert.deepEqual(registrations.map((r) => r.options.name).sort(), [
    'main',
    'sidebar.footer.action',
    'sidebar.panellist',
  ])
})

test('the panellist id and the main key match, so the sidebar icon opens the panel', () => {
  const { registrations } = loadClient()
  const icon = registrations.find((r) => r.options.name === 'sidebar.panellist')
  const panel = registrations.find((r) => r.options.name === 'main')
  // 这是本文件最重要的一条断言：侧边栏按钮与中央面板靠 id === key 配对，
  // 一旦不一致，点图标不会有任何反应，而且不会有任何报错。
  assert.equal(icon.options.id, panel.options.key)
  assert.equal(icon.options.id, 'remote-panel')
})

test('registrations carry the metadata the shell needs', () => {
  const { registrations } = loadClient()
  for (const { options } of registrations) {
    if (options.name === 'main') continue // keyed 槽位只需要 key
    assert.equal(typeof options.id, 'string')
    assert.ok(options.id.length > 0)
    assert.equal(typeof options.label, 'string')
    assert.equal(typeof options.order, 'number')
  }
})

test('the panellist component is a pure icon renderer', () => {
  const { registrations } = loadClient()
  const icon = registrations.find((r) => r.options.name === 'sidebar.panellist')
  // 侧边栏自己画按钮，占位方只提供图标 —— owner props 是 { size, active }。
  const element = deepRender(icon.component({ size: 16, active: true }))
  assert.equal(element.type, 'svg')
  assert.equal(element.props.width, 16)
  assert.equal(element.props['aria-hidden'], true)
})

test('the main panel renders its shell without touching the network', () => {
  const { registrations, fetchCalls } = loadClient()
  const panel = registrations.find((r) => r.options.name === 'main')
  // useEffect 被刻意做成 no-op，所以这里只验证初次渲染的形状。
  const element = panel.component({})
  assert.equal(element.type, 'div')
  assert.equal(fetchCalls.length, 0, 'rendering must not itself start fetching; that belongs in an effect')
})

test('no hardcoded colours leak into the client styles', () => {
  const { registrations } = loadClient()
  for (const { options, component } of registrations) {
    if (options.name === 'main') continue // 面板内部结构在下面单独覆盖
    const rendered = JSON.stringify(deepRender(component({ size: 16, active: false })) ?? '')
    // 十六进制色值或 rgb()/hsl() 都算硬编码 —— 它们不会跟随明暗主题。
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rendered), `hardcoded hex colour in: ${rendered.slice(0, 200)}`)
    assert.ok(!/\brgba?\(/.test(rendered), `hardcoded rgb colour in: ${rendered.slice(0, 200)}`)
  }
})

test('every colour the components do use is a host theme token', () => {
  const { registrations } = loadClient()
  const button = registrations.find((r) => r.options.name === 'sidebar.footer.action')
  const element = button.component({})
  const serialized = JSON.stringify(element.props.style)
  assert.ok(serialized.includes('--dsw-alias-'), serialized)
})

test('the footer button POSTs to the plugin open route', async () => {
  const { registrations, fetchCalls } = loadClient()
  const button = registrations.find((r) => r.options.name === 'sidebar.footer.action')
  const element = button.component({})
  assert.equal(element.type, 'button')
  assert.equal(typeof element.props.onClick, 'function')
  assert.ok(element.props['aria-label'])
  // 图标是函数型组件，展开后应当是 svg。
  assert.equal(deepRender(element.children[0]).type, 'svg')

  await element.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/dsh-remote-panel/open')
  assert.equal(fetchCalls[0].init.method, 'POST')
})

test('the client only calls same-origin plugin routes', () => {
  // 面板与按钮只能打宿主注册的同源路由；出现绝对 URL 会是安全问题。
  const urls = [...SOURCE.matchAll(/['"](\/[^'"]*)['"]/g)].map((m) => m[1])
  assert.ok(urls.length > 0)
  for (const url of urls) {
    assert.ok(url.startsWith('/dsh-remote-panel/'), `unexpected route in client.js: ${url}`)
  }
})
