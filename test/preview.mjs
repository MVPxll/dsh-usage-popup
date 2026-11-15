/**
 * Preview renderer: renders the real `client.js` component tree to static HTML,
 * then has the caller screenshot it.
 *
 * The popup and the settings page are the ones users actually see, so the only
 * honest picture is the one the plugin's own components produce. This script
 * loads the bundle exactly as the Web GUI does, runs it against a small React
 * shim that can render function components (the test harness deliberately does
 * not, because it asserts on elements), and serialises the result.
 *
 * Usage: node test/preview.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG_ID = 'dsh-usage-popup'

/* ------------------------------------------------------------------ */
/* A React shim that renders function components                        */
/* ------------------------------------------------------------------ */

/**
 * Escape text for HTML.
 * @param {string} text - raw text.
 * @returns {string} escaped text.
 */
function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape an attribute value.
 * @param {string} text - raw value.
 * @returns {string} escaped value.
 */
function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;')
}

/**
 * Build the React shim. Hooks live per component instance, keyed by the path
 * the renderer hands each node, so a component that appears twice keeps two
 * independent hook slots.
 * @returns {any} the shim namespace.
 */
function createShim() {
  const instances = new Map()
  let dirty = false
  let pendingEffects = []

  /**
   * The element constructor.
   * @param {any} type - tag name or component.
   * @param {Record<string, any> | null} props - element props.
   * @param {...any} children - children, flattened.
   * @returns {any} the element.
   */
  function createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    const flat = children.length > 0 ? children : merged.children
    if (flat !== undefined) merged.children = flat
    return { type, props: merged }
  }

  /**
   * Hook slot for one component instance.
   * @param {string} path - instance path.
   * @returns {{ hooks: any[], index: number }} the slot.
   */
  function instanceAt(path) {
    let instance = instances.get(path)
    if (instance === undefined) {
      instance = { hooks: [], index: 0 }
      instances.set(path, instance)
    }
    return instance
  }

  let current = null

  /**
   * `useState` with a stable per-instance slot.
   * @param {any} initial - initial value or initialiser.
   * @returns {[any, (next: any) => void]} state and setter.
   */
  function useState(initial) {
    const instance = current
    const index = instance.index++
    if (instance.hooks[index] === undefined) {
      instance.hooks[index] = {
        value: typeof initial === 'function' ? initial() : initial,
      }
    }
    const slot = instance.hooks[index]
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      dirty = true
    }
    return [slot.value, set]
  }

  /**
   * `useEffect` that re-runs only when its dependency list changes.
   * @param {() => (void | (() => void))} fn - effect body.
   * @param {any[]} [deps] - dependencies.
   * @returns {void}
   */
  function useEffect(fn, deps) {
    const instance = current
    const index = instance.index++
    const slot = instance.hooks[index]
    const next = deps === undefined ? undefined : [...deps]
    const same = slot !== undefined
      && slot.deps !== undefined
      && next !== undefined
      && slot.deps.length === next.length
      && slot.deps.every((value, i) => Object.is(value, next[i]))
    if (same) return
    if (slot !== undefined && next === undefined && slot.deps === undefined) return
    const entry = slot === undefined ? { deps: next } : slot
    entry.deps = next
    instance.hooks[index] = entry
    pendingEffects.push({ entry, fn })
  }

  /**
   * Render one node to HTML.
   * @param {any} node - element, array, or primitive.
   * @param {string} path - instance path prefix.
   * @returns {string} HTML.
   */
  function render(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return escapeText(node)
    if (Array.isArray(node)) {
      return node.map((child, i) => render(child, `${path}.${i}`)).join('')
    }
    const { type, props } = node
    if (typeof type === 'function') {
      const instancePath = `${path}<${type.name || 'anon'}>`
      const previous = current
      const instance = instanceAt(instancePath)
      instance.index = 0
      current = instance
      let output
      try {
        output = type(props)
      } finally {
        current = previous
      }
      return render(output, instancePath)
    }
    const attrs = []
    for (const key of Object.keys(props || {})) {
      if (key === 'children') continue
      const value = props[key]
      if (value === null || value === undefined || value === false) continue
      if (/^on[A-Z]/.test(key)) continue
      if (key === 'style' && typeof value === 'object') {
        const declarations = Object.keys(value)
          .filter((name) => value[name] !== undefined && value[name] !== null)
          .map((name) => `${name}:${value[name]}`)
          .join(';')
        attrs.push(`style="${escapeAttr(declarations)}"`)
        continue
      }
      // An `<input value>` is a live prop in React but a literal attribute in
      // HTML, which is exactly what a static preview wants; `checked` stays out
      // because these controls carry `data-on` instead.
      if (key === 'checked') continue
      // React spells these differently from HTML; emitting them verbatim would
      // drop every class name on the floor and the page would render unstyled.
      const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key
      attrs.push(`${name}="${escapeAttr(value === true ? '' : value)}"`)
    }
    const open = attrs.length > 0 ? `<${type} ${attrs.join(' ')}>` : `<${type}>`
    if (type === 'img' || type === 'input' || type === 'br') {
      return attrs.length > 0 ? `<${type} ${attrs.join(' ')}>` : `<${type}>`
    }
    const inner = render(props ? props.children : undefined, path)
    return `${open}${inner}</${type}>`
  }

  /**
   * Render a root element, flushing effects and re-rendering until stable.
   * @param {any} element - root element.
   * @returns {string} HTML.
   */
  function renderStable(element) {
    let html = ''
    for (let pass = 0; pass < 40; pass += 1) {
      dirty = false
      pendingEffects = []
      html = render(element, 'root')
      const batch = pendingEffects.splice(0, pendingEffects.length)
      for (const item of batch) {
        const cleanup = item.fn()
        item.entry.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
      if (!dirty && pendingEffects.length === 0) return html
    }
    return html
  }

  return { createElement, useState, useEffect, renderStable }
}

/* ------------------------------------------------------------------ */
/* Boot the bundle                                                      */
/* ------------------------------------------------------------------ */

/**
 * Load one isolated copy of the bundle and wire it to a fake Client context.
 * @param {{ stored?: Record<string, unknown>, clock?: number }} options - boot options.
 * @returns {any} the booted world.
 */
function boot(options = {}) {
  const React = createShim()
  const storage = new Map()
  if (options.stored !== undefined) {
    storage.set(`dsh-usage-popup:config:${PKG_ID}`, JSON.stringify(options.stored))
  }

  const styleTags = []
  const document = {
    head: { appendChild: (tag) => styleTags.push(tag) },
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    querySelector: (selector) => {
      const match = /data-plugin-css="([^"]+)"/.exec(String(selector))
      if (match === null) return null
      return styleTags.find((tag) => tag.dataset.pluginCss === match[1]) || null
    },
  }
  const window = {
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  }

  // A fixed instant keeps the preview reproducible: Monday 10:20 Beijing time,
  // just inside the morning peak window.
  const clock = options.clock === undefined ? Date.parse('2026-11-16T10:20:00+08:00') : options.clock
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(clock); else super(...args) }
    static now() { return clock }
  }

  let spec = null
  window.__ModuleLoader__ = { load: (next) => { spec = next } }

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    Date: globalThis.Date,
  }

  /**
   * Run code with the fake globals installed. Every entry point of the bundle —
   * the module body, `apply`, and rendering — reads `document`, `window`, or
   * `Date` off the global object, so all three have to run inside the swap.
   * @param {() => any} fn - code to run.
   * @returns {any} whatever `fn` returned.
   */
  function run(fn) {
    globalThis.window = window
    globalThis.document = document
    globalThis.Date = FakeDate
    try {
      return fn()
    } finally {
      globalThis.window = saved.window
      globalThis.document = saved.document
      globalThis.Date = saved.Date
    }
  }

  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  run(() => {
    // eslint-disable-next-line no-new-func
    new Function('window', source)(window)
  })
  if (spec === null) throw new Error('the bundle did not register itself')

  const bySlot = {}
  const ctx = {
    on: () => () => {},
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get: () => undefined,
    slots: {
      inject: (_name, register) => {
        register()
        return () => {}
      },
      register: (slotOptions, component) => {
        bySlot[slotOptions.name] = { options: slotOptions, component }
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => key, getSnapshot: () => 'zh' },
  }
  const module = spec.factory((name) => {
    if (name === 'react') return { createElement: React.createElement, useState: React.useState, useEffect: React.useEffect }
    throw new Error(`unexpected require: ${name}`)
  })
  run(() => module.apply(ctx))

  const baseProps = {
    useSessions: (selector) => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
    useRemoteAccess: () => true,
    useResource: () => undefined,
    useContextMenu: () => ({}),
    useWorkspaces: (selector) => selector({}),
    usePanelInfo: () => ({}),
    useSessionRetainInfo: () => ({}),
    useSessionAccess: () => true,
    useWorkspaceAccess: () => true,
  }

  return {
    bySlot,
    styleTags,
    React,
    baseProps,
    /** Render the settings page to HTML. */
    settings(props = {}) {
      const entry = bySlot['settings.section']
      const injected = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
      const element = React.createElement(entry.component, { ...baseProps, ...injected, ...props })
      return run(() => React.renderStable(element))
    },
    /** Render the composer status badge to HTML. */
    badge() {
      const entry = bySlot['conversation.composer.dock']
      const element = React.createElement(entry.component, baseProps)
      return run(() => React.renderStable(element))
    },
  }
}

/* ------------------------------------------------------------------ */
/* Pages                                                                */
/* ------------------------------------------------------------------ */

/** The stylesheet the plugin injects, so previews use the shipped rules. */
const world = boot()
const CSS = world.styleTags[0].textContent

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0}
body{background:radial-gradient(120% 90% at 50% 0%,#171c28 0%,#0b0d12 62%,#08090d 100%);
  color:#e8ebf2;font-family:"Microsoft YaHei UI","Segoe UI Emoji",sans-serif;padding:30px 0 40px}
#stage{display:flex;flex-direction:column;align-items:center;gap:26px;width:100%}
.caption{color:#6f7684;font-size:11.5px;letter-spacing:.6px;text-transform:uppercase}
#stage .dsh-up-layer{position:static}
#stage .dsh-up-card{margin-top:0}
/* The page must fill its plate, not outgrow it: a fixed width here is what
   pushed every switch past the plate's right border. */
#stage .dsh-up-page{width:100%}
.plate{width:min(600px,94vw);padding:22px 24px 20px;border-radius:18px;
  background:var(--dsw-alias-bg-layer-1,#12151c);border:1px solid rgba(255,255,255,.10);
  box-shadow:0 30px 70px -34px rgba(0,0,0,.9)}
.dsh-up-group-label{text-transform:none;letter-spacing:.4px}
/* A stand-in for the composer's dock row: centred, gap 12px, and the same
   muted pill metrics the shipped chat package uses, so the badge is judged in
   its real neighbourhood. */
.dock-strip{display:flex;justify-content:center;align-items:center;gap:12px;max-width:100%;
  width:min(720px,94vw);padding:8px 14px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,#12151c);border:1px solid rgba(255,255,255,.08)}
.dock-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:var(--dsw-radius-sm,6px);
  color:#9aa0ad;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}
`

/**
 * Render one period card by hand from the plugin's own render output would need
 * fake session state; instead the card is composed from the shipped CSS and the
 * strings the dictionaries carry, so it cannot drift from the real markup.
 * @param {{ accent: string, soft: string, title: string, tag: string, count: string, sub: string }} view - copy.
 * @returns {string} HTML.
 */
function popupCard(view) {
  return `<div class="dsh-up-layer" style="--dsh-up-accent:${view.accent};--dsh-up-accent-soft:${view.soft}">`
    + '<div class="dsh-up-card dsh-up-glass dsh-up-phase-in"><div>'
    + `<div class="dsh-up-row"><span class="dsh-up-dot"></span><span class="dsh-up-title">${escapeText(view.title)}</span>`
    + `<span class="dsh-up-tag">${escapeText(view.tag)}</span></div>`
    + `<div class="dsh-up-count">${escapeText(view.count)}</div>`
    + `<div class="dsh-up-sub">${escapeText(view.sub)}</div>`
    + '</div></div></div>'
}

const costCard = '<div class="dsh-up-layer" style="--dsh-up-accent:#7aa2ff;--dsh-up-accent-soft:rgba(122,162,255,.30)">'
  + '<div class="dsh-up-card dsh-up-glass dsh-up-phase-in"><div>'
  + '<div class="dsh-up-row"><span class="dsh-up-dot"></span><span class="dsh-up-title">本轮对话已结束</span>'
  + '<span class="dsh-up-tag">本轮消耗</span></div>'
  + '<div class="dsh-up-metrics">'
  + '<div class="dsh-up-metric"><span class="dsh-up-metric-value" style="color:#7aa2ff">¥0.518</span>'
  + '<span class="dsh-up-metric-label">本轮花费</span></div>'
  + '<div class="dsh-up-metric"><span class="dsh-up-metric-value">90.0%</span>'
  + '<span class="dsh-up-metric-label">平均缓存命中率</span></div>'
  + '<div class="dsh-up-metric"><span class="dsh-up-metric-value">1.10M</span>'
  + '<span class="dsh-up-metric-label">本轮 tokens</span></div></div>'
  + '<div class="dsh-up-sub">今日累计 ¥12.648</div>'
  + '<div class="dsh-up-sub">输入 1.00M · 输出 100.0K · 缓存命中 900.0K</div>'
  + '</div></div></div>'

/* The composer status row: the badge this plugin adds, then the two pills the
   shipped chat package renders. The badge markup is the REAL render output; the
   pills are copied as static markup because they belong to another package. */
const peakBadge = boot({ clock: Date.parse('2026-11-16T10:20:00+08:00') }).badge()
const troughBadge = boot({ clock: Date.parse('2026-11-16T02:20:00+08:00') }).badge()

/**
 * Compose one status-row strip.
 * @param {string} badge - rendered badge markup.
 * @returns {string} HTML.
 */
function dockRow(badge) {
  return '<div class="dock-strip">'
    + badge
    + '<span class="dock-pill"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> 6 轮 623 步 · 120 tok/s</span>'
    + '<span class="dock-pill"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/></svg> 52M tok · 缓存命中 98%</span>'
    + '<span class="dock-pill"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="9" opacity=".3"/><path d="M12 3a9 9 0 0 1 9 9"/></svg> 11%</span>'
    + '</div>'
}

const popupHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>消耗弹窗 · 预览</title><style>${CSS}${BASE_CSS}</style></head><body><div id="stage">
<span class="caption">输入框下方状态栏 · 高峰期</span>
${dockRow(peakBadge)}
<span class="caption">输入框下方状态栏 · 低谷期</span>
${dockRow(troughBadge)}
<span class="caption">高峰期 · 对话开始</span>
${popupCard({
  accent: '#ff5d5d',
  soft: 'rgba(255,93,93,.30)',
  title: '高峰期 · 标准计费',
  tag: '高峰期',
  count: '还剩 1 时 40 分 00 秒',
  sub: '当前处于高峰期，按标准价计费；12:00 起进入低谷期。',
})}
<span class="caption">低谷期 · 对话开始</span>
${popupCard({
  accent: '#3ddc97',
  soft: 'rgba(61,220,151,.30)',
  title: '低谷期 · 优惠时段',
  tag: '低谷期',
  count: '还剩 5 时 12 分 08 秒',
  sub: '当前处于低谷期，缓存命中价更低；09:00 起进入高峰期。',
})}
<span class="caption">本轮结束 · 花费与命中率</span>
${costCard}
</div></body></html>`

/**
 * Wrap one rendered page in a document.
 * @param {string} title - document title.
 * @param {string} caption - stage caption.
 * @param {string} body - rendered page HTML.
 * @returns {string} the document.
 */
function settingsDocument(title, caption, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeText(title)}</title><style>${CSS}${BASE_CSS}</style></head><body><div id="stage">
<span class="caption">${escapeText(caption)}</span>
<div class="plate">${body}</div>
</div></body></html>`
}

const settingsPreset = boot({ stored: { modelPreset: 'flash' } }).settings()
const settingsCustom = boot({ stored: { modelPreset: 'custom', periodSwitch: true, offPeakStart: '01:15' } }).settings()

writeFileSync(join(ROOT, 'preview-popups.html'), popupHtml)
writeFileSync(join(ROOT, 'preview-settings.html'),
  settingsDocument('消耗弹窗 · 设置', '设置页 · DS flash 预设', settingsPreset))
writeFileSync(join(ROOT, 'preview-settings-custom.html'),
  settingsDocument('消耗弹窗 · 设置', '设置页 · 自定义模型 + 峰谷开关', settingsCustom))
console.log(`popups ${popupHtml.length} chars, settings ${settingsPreset.length} / ${settingsCustom.length} chars`)
