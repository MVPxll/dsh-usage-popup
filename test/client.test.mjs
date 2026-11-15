/**
 * Headless harness for the popup bundle.
 *
 * The bundle only reaches for `createElement`, `useState`, and `useEffect`, so a
 * small React shim renders the real contributions and lets the assertions read
 * what they produce. Timers, the clock, and localStorage are faked, so the popup
 * lifecycle is driven deterministically instead of by wall-clock waits, and state
 * updates are batched the way React batches them to keep the loop re-entrancy
 * free. Run with the harness Node binary:
 *
 *   & $env:DSH_NODE_EXECUTABLE test\client.test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
const PKG_ID = 'dsh-usage-popup'

const results = []
let failures = 0

/**
 * Record one assertion.
 * @param {string} name - assertion name.
 * @param {boolean} ok - whether it held.
 * @param {any} [detail] - extra context.
 * @returns {void}
 */
function check(name, ok, detail) {
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`)
  if (!ok) failures += 1
}

/**
 * Collect every text node in a tree of plain elements.
 * @param {any} node - element or string.
 * @param {string[]} [acc] - accumulator.
 * @returns {string[]} texts.
 */
function texts(node, acc = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  if (Array.isArray(node)) { for (const child of node) texts(child, acc); return acc }
  if (node.props) texts(node.props.children, acc)
  return acc
}

/**
 * Collect every string reachable through props, without invoking components.
 * @param {any} value - element, array, object, or primitive.
 * @param {string[]} [acc] - accumulator.
 * @returns {string[]} strings.
 */
function propStrings(value, acc = []) {
  if (value === null || value === undefined) return acc
  if (typeof value === 'string') { acc.push(value); return acc }
  if (typeof value !== 'object') return acc
  if (Array.isArray(value)) { for (const item of value) propStrings(item, acc); return acc }
  // Only a real element owns a `props` bag. A props bag itself can also carry a
  // `type` key (a <button type="button"> attribute), so keying off `type`
  // alone silently truncates every walk at the first button.
  if (Object.prototype.hasOwnProperty.call(value, 'props')) { propStrings(value.props, acc); return acc }
  for (const key of Object.keys(value)) propStrings(value[key], acc)
  return acc
}

/**
 * Collect every element whose tag name matches.
 * @param {any} node - settled element tree.
 * @param {string} tag - tag name.
 * @param {any[]} [acc] - accumulator.
 * @returns {any[]} matching elements.
 */
function collectTags(node, tag, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const child of node) collectTags(child, tag, acc); return acc }
  if (node.type === tag) acc.push(node)
  if (node.props) collectTags(node.props.children, tag, acc)
  return acc
}

/**
 * Collect the text of every rendered `<span>` under one element.
 *
 * The badge renders plain spans (never components), so walking the settled
 * tree directly is enough and keeps the assertion honest about what the user
 * actually sees.
 * @param {any} node - settled element tree.
 * @param {string[]} [acc] - accumulator.
 * @returns {string[]} the span texts.
 */
function collectSpans(node, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const child of node) collectSpans(child, acc); return acc }
  if (node.type === 'span') { texts(node, acc); return acc }
  if (node.props) collectSpans(node.props.children, acc)
  return acc
}

/**
 * Collect every element whose component has a given name.
 *
 * The shim does not render child components, so a nested control is reached
 * through the element that names it rather than through a rendered DOM node.
 *
 * @param {any} node - element tree.
 * @param {string} name - component function name.
 * @param {any[]} [acc] - accumulator.
 * @returns {any[]} matching elements.
 */
function collectComponents(node, name, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const child of node) collectComponents(child, name, acc); return acc }
  if (typeof node.type === 'function' && node.type.name === name) { acc.push(node); return acc }
  // A control is passed as a prop (`control: h(TextField, ...)`), not as a
  // child, so walk every prop value rather than just `children`.
  if (node.props) for (const key of Object.keys(node.props)) collectComponents(node.props[key], name, acc)
  return acc
}

/**
 * Find the first element of a tag whose className contains a token.
 * @param {any} node - element tree.
 * @param {string} tag - tag name.
 * @param {string} [token] - class token to require.
 * @returns {any} the element or null.
 */
function findTag(node, tag, token) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findTag(child, tag, token); if (hit) return hit }
    return null
  }
  if (node.type === tag) {
    const className = node.props && node.props.className
    if (token === undefined || (typeof className === 'string' && className.includes(token))) return node
  }
  if (node.props) return findTag(node.props.children, tag, token)
  return null
}

/**
 * Boot one isolated copy of the bundle: fresh module scope, fresh fake clock,
 * fresh fake DOM, fresh fake Client context.
 * @param {{ stored?: Record<string, unknown>, clock?: number }} [options] - boot options.
 * @returns {any} the booted host: registrations, driver, and fake storage.
 */
function boot(options = {}) {
  /* ---- fake clock ---- */
  let clock = options.clock === undefined ? Date.parse('2026-11-15T19:00:00+08:00') : options.clock
  const queue = []
  let seq = 0

  /**
   * Schedule a fake timeout.
   * @param {() => void} fn - callback.
   * @param {number} delay - milliseconds.
   * @returns {number} timer id.
   */
  const fakeTimeout = (fn, delay) => { seq += 1; queue.push({ id: seq, at: clock + (delay || 0), fn, repeat: 0 }); return seq }

  /**
   * Schedule a fake interval.
   * @param {() => void} fn - callback.
   * @param {number} delay - period in milliseconds.
   * @returns {number} timer id.
   */
  const fakeInterval = (fn, delay) => {
    seq += 1
    const period = Math.max(1, delay || 1)
    queue.push({ id: seq, at: clock + period, fn, repeat: period })
    return seq
  }

  /**
   * Cancel a fake timer.
   * @param {number} id - timer id.
   * @returns {void}
   */
  const fakeClear = (id) => {
    const index = queue.findIndex((item) => item.id === id)
    if (index >= 0) queue.splice(index, 1)
  }

  /* ---- React shim ---- */
  let hooks = []
  let hookIndex = 0
  let effectQueue = []
  let dirty = false

  const React = {
    /**
     * Build a plain element description.
     * @param {any} type - tag, component, or null.
     * @param {Record<string, any> | null} props - element props.
     * @param {...any} children - children.
     * @returns {any} element.
     */
    createElement(type, props, ...children) {
      const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props || {}), children: flat } }
    },

    /**
     * Read or create one piece of component state. A setter only marks the tree
     * dirty, so the driver owns the single render loop.
     * @param {any} initial - initial value or factory.
     * @returns {[any, (next: any) => void]} value and setter.
     */
    useState(initial) {
      const index = hookIndex
      hookIndex += 1
      if (hooks.length <= index) {
        hooks.push({ value: typeof initial === 'function' ? initial() : initial, deps: undefined, cleanup: null, set: null })
      }
      const slot = hooks[index]
      if (slot.set === null) {
        slot.set = (next) => {
          const resolved = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(resolved, slot.value)) return
          slot.value = resolved
          dirty = true
        }
      }
      return [slot.value, slot.set]
    },

    /**
     * Queue an effect when its dependencies change.
     * @param {() => (void | (() => void))} fn - effect body.
     * @param {readonly unknown[]} [deps] - dependency list.
     * @returns {void}
     */
    useEffect(fn, deps) {
      const index = hookIndex
      hookIndex += 1
      if (hooks.length <= index) hooks.push({ value: undefined, deps: undefined, cleanup: null, set: null })
      const slot = hooks[index]
      const same = slot.deps !== undefined && deps !== undefined
        && slot.deps.length === deps.length
        && slot.deps.every((value, i) => Object.is(value, deps[i]))
      if (same) return
      slot.deps = deps === undefined ? undefined : [...deps]
      effectQueue.push({ slot, fn })
    },
  }

  /* ---- fake DOM ---- */
  const styleTags = []
  const storage = new Map()
  if (options.stored !== undefined) storage.set(`dsh-usage-popup:config:${PKG_ID}`, JSON.stringify(options.stored))

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
    },
    __ModuleLoader__: {},
  }

  /* ---- module load ---- */
  let registered = null
  window.__ModuleLoader__.load = (spec) => { registered = spec }

  const saved = { DateNow: Date.now, setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval, window: globalThis.window, document: globalThis.document }
  globalThis.window = window
  globalThis.document = document
  Date.now = () => clock
  globalThis.setTimeout = fakeTimeout
  globalThis.setInterval = fakeInterval
  globalThis.clearTimeout = fakeClear
  globalThis.clearInterval = fakeClear

  const localFunction = new Function('window', SOURCE)
  localFunction(window)

  if (registered === null || registered.id !== PKG_ID) throw new Error('the module did not register under the expected id')
  const mod = registered.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })

  /* ---- fake Client context ---- */
  const registrations = []
  const localeDicts = {}

  const ctx = {
    get(name) {
      if (name !== 'locale') return undefined
      return {
        register: (ns, dicts) => { localeDicts[ns] = dicts; return () => {} },
        bind: (ns) => (key) => {
          const dict = localeDicts[ns] || {}
          const zh = dict.zh || {}
          return Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key
        },
      }
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    on() { return () => {} },
    slots: {
      inject(owner, register) { registrations.push({ owner, register }); return () => {} },
      register(options, component) { return { options, component } },
    },
  }

  mod.apply(ctx)

  const bySlot = {}
  for (const entry of registrations) {
    const result = entry.register()
    bySlot[result.options.name] = { options: result.options, component: result.component }
  }

  /* ---- render driver ---- */
  let owner = null

  /**
   * Render one contribution with a private hook arena.
   * @param {{ options: any, component: any }} entry - the contribution.
   * @param {Record<string, any>} props - slot props.
   * @returns {any} the rendered tree.
   */
  function renderWith(entry, props) {
    if (owner !== entry) { hooks = []; owner = entry }
    hookIndex = 0
    effectQueue = []
    return entry.component(props)
  }

  /**
   * Render, flush effects, and re-render until nothing is queued.
   * @param {{ options: any, component: any }} entry - the contribution.
   * @param {Record<string, any>} props - slot props.
   * @returns {any} the settled tree.
   */
  function settle(entry, props) {
    for (let pass = 0; pass < 60; pass += 1) {
      const tree = renderWith(entry, props)
      const batch = effectQueue.splice(0, effectQueue.length)
      dirty = false
      for (const item of batch) {
        if (typeof item.slot.cleanup === 'function') item.slot.cleanup()
        item.slot.cleanup = item.fn() || null
      }
      if (!dirty && effectQueue.length === 0) return tree
    }
    throw new Error('the render did not settle')
  }

  let sessionState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  let statusState = new Map()

  const baseProps = {
    useSessions: (selector) => selector(sessionState),
    useSessionStatus: (selector) => selector(statusState),
    useRemoteAccess: () => true,
    useResource: () => undefined,
    useContextMenu: () => ({}),
    useWorkspaces: (selector) => selector({}),
    usePanelInfo: () => ({}),
    useSessionRetainInfo: () => ({}),
    useSessionAccess: () => true,
    useWorkspaceAccess: () => true,
  }

  let tree = null

  const host = {
    bySlot,
    styleTags,
    storage,
    /** Render the popup contribution. */
    render() { tree = settle(bySlot['shell.overlay'], baseProps); return tree },
    /** Render the composer status badge. */
    renderBadge() {
      return settle(bySlot['conversation.composer.dock'], baseProps)
    },
    /** Render the settings contribution with its injected translator. */
    renderSettings() {
      const entry = bySlot['settings.section']
      const injected = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
      return settle(entry, { ...baseProps, ...injected })
    },
    /**
     * Set the snapshots and settle.
     * @param {any} sessions - session-list snapshot.
     * @param {Map<string, any>} status - running set.
     * @returns {any} the settled tree.
     */
    scenario(sessions, status) { sessionState = sessions; statusState = status; return host.render() },
    get tree() { return tree },
    /** Read the persisted preferences. */
    stored() { return JSON.parse(storage.get(`dsh-usage-popup:config:${PKG_ID}`) || '{}') },
    /**
     * Advance the fake clock, settling after each due timer.
     * @param {number} ms - milliseconds.
     * @returns {void}
     */
    advance(ms) {
      const target = clock + ms
      for (;;) {
        queue.sort((a, b) => a.at - b.at)
        const next = queue[0]
        if (next === undefined || next.at > target) break
        clock = next.at
        if (next.repeat > 0) next.at = clock + next.repeat
        else queue.shift()
        next.fn()
        host.render()
      }
      clock = target
      host.render()
    },
    /** Restore the globals this boot replaced. */
    restore() {
      Date.now = saved.DateNow
      globalThis.setTimeout = saved.setTimeout
      globalThis.setInterval = saved.setInterval
      globalThis.clearTimeout = saved.clearTimeout
      globalThis.clearInterval = saved.clearInterval
      globalThis.window = saved.window
      globalThis.document = saved.document
    },
  }

  return host
}

/* ==================================================================== */
/* 1. Wiring                                                            */
/* ==================================================================== */

const main = boot({ clock: Date.parse('2026-11-16T10:00:00+08:00') })
check('registers shell.overlay', main.bySlot['shell.overlay'] !== undefined,
  main.bySlot['shell.overlay'] ? `id=${main.bySlot['shell.overlay'].options.id} order=${main.bySlot['shell.overlay'].options.order}` : 'missing')
check('overlay sits above the shipped toasts', main.bySlot['shell.overlay'].options.order === 12)
check('registers settings.section', main.bySlot['settings.section'] !== undefined,
  main.bySlot['settings.section'] ? `id=${main.bySlot['settings.section'].options.id} order=${main.bySlot['settings.section'].options.order}` : 'missing')
check('registers settings.section.icon', main.bySlot['settings.section.icon'] !== undefined)
check('registers the composer dock badge', main.bySlot['conversation.composer.dock'] !== undefined,
  main.bySlot['conversation.composer.dock'] ? `id=${main.bySlot['conversation.composer.dock'].options.id} order=${main.bySlot['conversation.composer.dock'].options.order}` : 'missing')
check('the badge sorts before the shipped pills', main.bySlot['conversation.composer.dock'].options.order === -1)
check('registers exactly four contributions', Object.keys(main.bySlot).length === 4, Object.keys(main.bySlot))
check('injects the stylesheet once', main.styleTags.length === 1, `${main.styleTags.length} tag(s)`)
check('the stylesheet carries the glass rules', main.styleTags[0].textContent.includes('backdrop-filter:blur(22px)'),
  `${main.styleTags[0].textContent.length} chars`)
check('idle render paints nothing', main.render() === null, String(main.tree))

/* ==================================================================== */
/* 2. Peak period popup                                                 */
/* ==================================================================== */

const running = (id) => new Map([[id, { running: true, pendingInteraction: null, completionUnread: false }]])
const stopped = (id) => new Map([[id, { running: false, pendingInteraction: null, completionUnread: false }]])

const session = (id, extra) => ({ id, running: true, blank: false, projectionValues: {}, ...extra })
const listOf = (ids, byId, projections) => ({ ids, byId, phase: 'ready', projectionsBySession: projections || {} })

let shown = main.scenario(
  listOf(['s1'], { s1: session('s1') }),
  running('s1'),
)
let allText = texts(shown).join(' | ')
check('period popup appears when a turn starts', shown !== null)
check('peak branch is labelled 高峰期', allText.includes('高峰期'), allText.slice(0, 120))
check('countdown uses 时 分 秒', /\d+ 时 \d+ 分 \d{2} 秒/.test(allText), (allText.match(/还剩[^|]*/) || [])[0])
check('a 10:00 peak runs out at 12:00', allText.includes('还剩 2 时 0 分 00 秒'), (allText.match(/还剩[^|]*/) || [])[0])

const card = findTag(shown, 'div', 'dsh-up-card')
check('card carries the glass class', card !== null && card.props.className.includes('dsh-up-glass'),
  card ? card.props.className : 'missing')
check('card animates in', card !== null && card.props.className.includes('dsh-up-phase-in'))
const layer = findTag(shown, 'div', 'dsh-up-layer')
check('peak accent is red', layer !== null && layer.props.style['--dsh-up-accent'] === '#ff5d5d',
  layer ? layer.props.style['--dsh-up-accent'] : 'missing')

main.advance(1000)
const ticked = (texts(main.tree).join(' | ').match(/还剩[^|]*/) || [])[0]
check('the countdown ticks once a second', String(ticked).includes('还剩 1 时 59 分 59 秒'), ticked)

/* ==================================================================== */
/* 3. Dwell time                                                        */
/* ==================================================================== */

main.advance(8980)
check('the popup is still up before the 10 s dwell elapses',
  main.tree !== null && !findTag(main.tree, 'div', 'dsh-up-card').props.className.includes('dsh-up-phase-out'))
main.advance(20)
check('the popup starts leaving after 10 s',
  main.tree !== null && findTag(main.tree, 'div', 'dsh-up-card').props.className.includes('dsh-up-phase-out'))
main.advance(300)
check('the popup unmounts after the exit animation', main.tree === null, String(main.tree))

/* ==================================================================== */
/* 4. Cost popup                                                        */
/* ==================================================================== */

// A turn adds tokens on top of what the Session already had, so the card
// reports the delta rather than the lifetime total.
shown = main.scenario(
  listOf(['s1'], { s1: session('s1') }),
  running('s1'),
)
main.advance(200)
shown = main.scenario(
  listOf(['s1'], { s1: session('s1', { running: false }) }, {
    s1: {
      state: 'ready',
      error: null,
      values: { tokenUsage: { uncachedInputTokens: 100000, cacheReadTokens: 900000, cacheWriteTokens: 0, outputTokens: 100000 } },
    },
  }),
  stopped('s1'),
)
main.advance(500)
const costText = texts(main.tree).join(' | ')
check('cost popup appears when the turn stops', main.tree !== null)
// DS flash peak: 100k miss (2/M) + 900k hit (0.04/M) + 100k output (8/M)
// = 0.2 + 0.036 + 0.8 = 1.036
check('cost math uses the DS flash peak prices', costText.includes('1.036'), (costText.match(/[¥￥]?[\d.]+/) || [])[0])
check('hit rate is cacheRead over context', costText.includes('90.0%'), (costText.match(/[\d.]+%/) || [])[0])
check('cost popup shows the turn tokens', costText.includes('1.10M'), (costText.match(/1\.10M/) || [])[0])
check('cost popup is not red', findTag(main.tree, 'div', 'dsh-up-layer').props.style['--dsh-up-accent'] === '#7aa2ff')
check('today total stays hidden while the switch is off', !costText.includes('今日累计'), costText.slice(0, 160))

/* ==================================================================== */
/* 5. Subagents never greet                                             */
/* ==================================================================== */

main.advance(4000)

const subBoot = boot({ clock: Date.parse('2026-11-16T10:00:00+08:00') })
subBoot.scenario(
  listOf(['s2'], { s2: session('s2', { origin: 'subagent' }) }),
  running('s2'),
)
check('subagent sessions are skipped', subBoot.tree === null, String(subBoot.tree))
subBoot.restore()

/* ==================================================================== */
/* 5b. A background Session finishing is not a conversation ending      */
/* ==================================================================== */

const mixed = boot()
const chatSummary = session('chat')
const bgSummary = session('bg')
mixed.scenario(
  listOf(['chat', 'bg'], { chat: chatSummary, bg: bgSummary }),
  new Map([
    ['chat', { running: true, pendingInteraction: null, completionUnread: false }],
    ['bg', { running: true, pendingInteraction: null, completionUnread: false }],
  ]),
)
check('one period popup covers two running Sessions',
  mixed.tree !== null && findTag(mixed.tree, 'div', 'dsh-up-layer') !== null)

mixed.advance(4000)
mixed.scenario(
  listOf(['chat', 'bg'], { chat: chatSummary, bg: bgSummary }),
  new Map([
    ['chat', { running: true, pendingInteraction: null, completionUnread: false }],
    ['bg', { running: false, pendingInteraction: null, completionUnread: false }],
  ]),
)
mixed.advance(600)
check('a background Session finishing leaves the conversation popup alone', mixed.tree !== null, String(mixed.tree))
mixed.restore()

/* ==================================================================== */
/* 5c. Every turn greets inside one Session                             */
/* ==================================================================== */

const turns = boot()
const turnList = (runningFlag) => listOf(['t1'], { t1: session('t1', { running: runningFlag }) })
turns.scenario(turnList(true), running('t1'))
check('turn 1 start greets', turns.tree !== null)
turns.advance(11000)
check('turn 1 card clears', turns.tree === null, String(turns.tree))
turns.scenario(
  listOf(['t1'], { t1: session('t1', { running: false }) }, {
    t1: { state: 'ready', error: null, values: { tokenUsage: { uncachedInputTokens: 200000, cacheReadTokens: 800000, cacheWriteTokens: 0, outputTokens: 100000 } } },
  }),
  stopped('t1'),
)
turns.advance(600)
check('turn 1 end reports cost', turns.tree !== null, String(turns.tree))
turns.advance(11000)
turns.scenario(turnList(true), running('t1'))
check('turn 2 start greets again in the same Session', turns.tree !== null, String(turns.tree))
turns.restore()

/* ==================================================================== */
/* 6. Off-peak renders green                                            */
/* ==================================================================== */
const offPeak = boot({ clock: Date.parse('2026-11-16T02:00:00+08:00') })
shown = offPeak.scenario(
  listOf(['s3'], { s3: session('s3') }),
  running('s3'),
)
const offText = texts(shown).join(' | ')
check('off-peak accent is green', findTag(shown, 'div', 'dsh-up-layer').props.style['--dsh-up-accent'] === '#3ddc97',
  findTag(shown, 'div', 'dsh-up-layer').props.style['--dsh-up-accent'])
check('off-peak title is 低谷期', offText.includes('低谷期'), offText.slice(0, 120))
check('02:00 counts to the 09:00 peak onset', offText.includes('还剩 7 时 0 分 00 秒'), (offText.match(/还剩[^|]*/) || [])[0])
offPeak.restore()

/* ==================================================================== */
/* 6b. The official schedule                                            */
/* ==================================================================== */

const midday = boot({ clock: Date.parse('2026-11-16T12:30:00+08:00') })
shown = midday.scenario(listOf(['s4'], { s4: session('s4') }), running('s4'))
check('12:30 is off-peak between the two windows', texts(shown).join(' ').includes('低谷期'),
  texts(shown).join(' | ').slice(0, 100))
check('12:30 counts to the 14:00 peak onset', texts(shown).join(' ').includes('还剩 1 时 30 分 00 秒'),
  (texts(shown).join(' ').match(/还剩[^|]*/) || [])[0])
midday.restore()

const saturday = boot({ clock: Date.parse('2026-11-14T10:00:00+08:00') })
shown = saturday.scenario(listOf(['s5'], { s5: session('s5') }), running('s5'))
check('a Saturday morning is off-peak', texts(shown).join(' ').includes('低谷期'), texts(shown).join(' | ').slice(0, 100))
check('a Saturday counts to Monday 09:00', texts(shown).join(' ').includes('还剩 47 时 0 分 00 秒'),
  (texts(shown).join(' ').match(/还剩[^|]*/) || [])[0])
saturday.restore()

// 2026-10-01 is a public holiday (National Day), so a Thursday is off-peak.
const holiday = boot({ clock: Date.parse('2026-10-01T10:00:00+08:00') })
shown = holiday.scenario(listOf(['s6'], { s6: session('s6') }), running('s6'))
check('a public holiday is off-peak', texts(shown).join(' ').includes('低谷期'), texts(shown).join(' | ').slice(0, 100))
holiday.restore()

/* ==================================================================== */
/* 6c. Custom model without the period switch                           */
/* ==================================================================== */

const flat = boot({ stored: { modelPreset: 'custom', periodSwitch: false }, clock: Date.parse('2026-11-15T10:00:00+08:00') })
shown = flat.scenario(listOf(['s7'], { s7: session('s7') }), running('s7'))
const flatText = texts(shown).join(' | ')
check('a flat custom model shows no countdown', !/还剩/.test(flatText), flatText.slice(0, 160))
check('a flat custom model says so', flatText.includes('单一价格'), flatText.slice(0, 160))
flat.restore()

const tiered = boot({ stored: { modelPreset: 'custom', periodSwitch: true }, clock: Date.parse('2026-11-15T20:00:00+08:00') })
shown = tiered.scenario(listOf(['s8'], { s8: session('s8') }), running('s8'))
check('a tiered custom model counts to its own window', texts(shown).join(' ').includes('还剩 4 时 30 分 00 秒'),
  (texts(shown).join(' ').match(/还剩[^|]*/) || [])[0])
tiered.restore()

/* ==================================================================== */
/* 6d. Presets drive the price                                           */
/* ==================================================================== */

const pro = boot({ stored: { modelPreset: 'pro' }, clock: Date.parse('2026-11-15T20:00:00+08:00') })
pro.scenario(listOf(['p1'], { p1: session('p1') }), running('p1'))
pro.advance(300)
pro.scenario(
  listOf(['p1'], { p1: session('p1', { running: false }) }, {
    p1: {
      state: 'ready',
      error: null,
      values: { tokenUsage: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
    },
  }),
  stopped('p1'),
)
pro.advance(600)
// DS Pro off-peak: 1M miss at 4.5/M = 4.500
check('the DS Pro preset bills at its own rate', texts(pro.tree).join(' ').includes('4.500'),
  texts(pro.tree).join(' | ').slice(0, 160))
pro.restore()

/* ==================================================================== */
/* 7. Settings page                                                     */
/* ==================================================================== */

const page = main.renderSettings()
const pageStrings = propStrings(page).join('\n')
check('settings page renders', page !== null)
check('settings page has the duration control', pageStrings.includes('停留时长'), `${pageStrings.length} chars scanned`)
check('settings page has the glass toggle', pageStrings.includes('玻璃效果'), `${pageStrings.length} chars scanned`)
check('settings page has the sound toggle', pageStrings.includes('出现音效'), `${pageStrings.length} chars scanned`)
check('settings page has the author credit', pageStrings.includes('开发者：MVP小刘刘'), `${pageStrings.length} chars scanned`)
const douyin = findTag(page, 'a', 'dsh-up-icon-link')
const links = collectTags(page, 'a')
const douyinLink = links.find((node) => String(node.props.href || '').includes('douyin'))
check('douyin icon links to the profile', douyinLink !== undefined && douyinLink.props.href === 'https://v.douyin.com/07TNWp0BEjg/',
  douyinLink === undefined ? 'missing' : douyinLink.props.href)
check('douyin icon is available to screen readers', douyinLink !== undefined && String(douyinLink.props['aria-label']).includes('抖音'),
  douyinLink === undefined ? 'missing' : String(douyinLink.props['aria-label']))
const douyinImg = douyinLink === undefined ? null : findTag(douyinLink, 'img')
const douyinSrc = douyinImg === null ? '' : String(douyinImg.props.src)
check('douyin icon is inlined as a data URI', douyinSrc.startsWith('data:image/png;base64,iVBOR'), `${douyinSrc.length} chars`)
check('douyin icon is round', douyinImg !== null && douyinImg.props.width === 36 && douyinImg.props.height === 36)
const ifdianLink = links.find((node) => String(node.props.href || '').includes('ifdian'))
check('the support icon links to the author page', ifdianLink !== undefined && ifdianLink.props.href === 'https://ifdian.net/a/MVPxll',
  ifdianLink === undefined ? 'missing' : ifdianLink.props.href)
const ifdianImg = ifdianLink === undefined ? null : findTag(ifdianLink, 'img')
const ifdianSrc = ifdianImg === null ? '' : String(ifdianImg.props.src)
check('the support icon is inlined as a data URI', ifdianSrc.startsWith('data:image/png;base64,iVBOR'), `${ifdianSrc.length} chars`)
check('the support icon is round', ifdianImg !== null && ifdianImg.props.width === 36 && ifdianImg.props.height === 36)
check('the two icons are distinct', douyinSrc !== ifdianSrc && douyinSrc.length > 0)
const badge = findTag(page, 'a', 'dsh-up-badge')
check('badge links to the harness repo', badge !== null && badge.props.href === 'https://github.com/deepseek-ai/deepseek-harness',
  badge ? badge.props.href : 'missing')
const badgeImg = badge === null ? null : findTag(badge, 'img')
const badgeSrc = badgeImg === null ? '' : String(badgeImg.props.src)
check('badge image is inlined as a data URI', badgeSrc.startsWith('data:image/png;base64,iVBOR'), `${badgeSrc.length} chars`)
check('badge keeps its aspect ratio', badgeImg !== null && badgeImg.props.height === 20)

/* ==================================================================== */
/* 8. Persisted preferences are honoured                                */
/* ==================================================================== */

const seeded = boot({
  stored: { durationMs: 5000, glass: false, sound: false },
  clock: Date.parse('2026-11-15T19:00:00+08:00'),
})
shown = seeded.scenario(
  listOf(['s9'], { s9: session('s9') }),
  running('s9'),
)
const seededCard = findTag(shown, 'div', 'dsh-up-card')
check('a stored dwell time is applied', seededCard !== null)
check('a stored glass=false drops the glass class', seededCard !== null && !seededCard.props.className.includes('dsh-up-glass'),
  seededCard ? seededCard.props.className : 'missing')
seeded.advance(4200)
check('the stored 5 s dwell outlives nothing yet',
  seeded.tree !== null && !findTag(seeded.tree, 'div', 'dsh-up-card').props.className.includes('dsh-up-phase-out'))
seeded.advance(900)
check('the stored 5 s dwell does end',
  seeded.tree !== null && findTag(seeded.tree, 'div', 'dsh-up-card').props.className.includes('dsh-up-phase-out'))
seeded.restore()

/* ==================================================================== */
/* 9. Settings page: presets, confirm dialog, reset                     */
/* ==================================================================== */

const cfg = boot({ stored: { modelPreset: 'custom', periodSwitch: true } })
let settingsPage = cfg.renderSettings()
let settingsStrings = propStrings(settingsPage)
let settingsText = settingsStrings.join('\n')
check('custom model reveals the three prices', settingsText.includes('未命中输入价')
  && settingsText.includes('缓存命中输入价') && settingsText.includes('输出价'))
check('custom model with the switch on reveals both clock fields',
  settingsStrings.includes('低谷期开始') && settingsStrings.includes('低谷期结束'))
const ri = settingsText.indexOf('重置')
check('no reset button before a custom window exists', !settingsText.includes('重置为内置时间'))
check('no confirm dialog before an edit', findTag(settingsPage, 'div', 'dsh-up-mask') === null)
cfg.restore()

const flash = boot({ stored: { modelPreset: 'flash' } })
settingsPage = flash.renderSettings()
settingsStrings = propStrings(settingsPage)
settingsText = settingsStrings.join('\n')
check('a preset hides the three price fields', !settingsText.includes('未命中输入价'), `${settingsText.length} chars scanned`)
check('a preset shows its published prices', settingsText.includes('低谷 命中 ¥0.02') && settingsText.includes('高峰 命中 ¥0.04'),
  (settingsText.match(/低谷 命中[^\n]*/) || [])[0])
check('a preset hides the clock fields', !settingsStrings.includes('低谷期开始'))
check('the presets are offered', settingsText.includes('DS flash') && settingsText.includes('DS Pro') && settingsText.includes('自定义模型'))
flash.restore()

const faded = boot({ stored: { modelPreset: 'custom', periodSwitch: false } })
settingsPage = faded.renderSettings()
settingsStrings = propStrings(settingsPage)
settingsText = settingsStrings.join('\n')
check('a flat custom model hides the clock fields', !settingsStrings.includes('低谷期开始'))
check('a flat custom model still shows the prices', settingsText.includes('未命中输入价'))
check('the period switch explains itself', settingsText.includes('低谷/高峰期请打开此开关'))
faded.restore()

/* ==================================================================== */
/* 9b. The confirm dialog guards a clock edit                            */
/* ==================================================================== */

const guarded = boot({ stored: { modelPreset: 'custom', periodSwitch: true } })
settingsPage = guarded.renderSettings()

// No dialog until a boundary is actually edited.
check('no dialog before any edit', findTag(settingsPage, 'div', 'dsh-up-mask') === null)

// The clock controls are TextField components; committing one is what the
// input's blur handler does after the user types.
let committed = null
const inputs = collectComponents(settingsPage, 'TextField')
check('the clock inputs are text fields', inputs.length >= 2, `${inputs.length} field(s)`)
check('the first two are the clock boundaries',
  inputs.length >= 2 && String(inputs[0].props.placeholder) === '00:30' && String(inputs[1].props.placeholder) === '08:30',
  inputs.length >= 2 ? `${inputs[0].props.placeholder} / ${inputs[1].props.placeholder}` : 'missing')
if (inputs.length > 0) {
  inputs[0].props.onCommit('01:15')
  const afterEdit = guarded.renderSettings()
  check('editing a boundary opens the dialog', findTag(afterEdit, 'div', 'dsh-up-mask') !== null)
  const dialogText = texts(afterEdit).join(' | ')
  check('the dialog asks first', dialogText.includes('你真的要更改吗？'), dialogText.slice(0, 120))
  check('the dialog warns about the source', dialogText.includes('更改后可能导致时间错误'), dialogText.slice(0, 200))
  check('the cancel button is green', findTag(afterEdit, 'button', 'dsh-up-btn-ok') !== null)
  check('the confirm button is outlined only', findTag(afterEdit, 'button', 'dsh-up-btn-ghost') !== null)
  // Cancel leaves the stored value untouched.
  findTag(afterEdit, 'button', 'dsh-up-btn-ok').props.onClick()
  const afterCancel = guarded.renderSettings()
  check('cancel closes the dialog', findTag(afterCancel, 'div', 'dsh-up-mask') === null)
  // Nothing is written before the user confirms, so the stored value is absent.
  check('cancel keeps the old window', !guarded.stored().offPeakStart, JSON.stringify(guarded.stored().offPeakStart))
  // Confirm writes it, and only then does the reset button appear.
  inputs[0].props.onCommit('01:15')
  findTag(guarded.renderSettings(), 'button', 'dsh-up-btn-ghost').props.onClick()
  const afterOk = guarded.renderSettings()
  check('confirm closes the dialog', findTag(afterOk, 'div', 'dsh-up-mask') === null)
  check('confirm writes the new window', guarded.stored().offPeakStart === '01:15', JSON.stringify(guarded.stored().offPeakStart))
  const resetButton = findTag(afterOk, 'button', 'dsh-up-reset')
  check('the reset button appears after a change', resetButton !== null)
  if (resetButton !== null) {
    resetButton.props.onClick()
    check('reset restores the built-in times', guarded.stored().offPeakStart === '', JSON.stringify(guarded.stored().offPeakStart))
    check('reset hides its own button', findTag(guarded.renderSettings(), 'button', 'dsh-up-reset') === null)
  }
  committed = true
}
check('the clock guard was exercised', committed === true)
guarded.restore()

/* ==================================================================== */
/* 10. Composer status badge                                            */
/* ==================================================================== */

const peakBadge = boot({ clock: Date.parse('2026-11-16T10:00:00+08:00') })
const peakNode = peakBadge.renderBadge()
check('the badge renders', peakNode !== null)
check('the peak badge is flagged peak', peakNode !== null && peakNode.props['data-offpeak'] === 'false',
  peakNode === null ? 'missing' : String(peakNode.props['data-offpeak']))
{
  const parts = peakNode === null ? [] : collectSpans(peakNode)
  check('the peak badge says 高峰', parts.includes('高峰'), parts.join(' | '))
  check('the peak badge counts down', parts.some((text) => /^\d+ 时 \d+ 分$/.test(text)), parts.join(' | '))
}
peakBadge.restore()

const troughBadge = boot({ clock: Date.parse('2026-11-16T02:00:00+08:00') })
const troughNode = troughBadge.renderBadge()
check('the trough badge is flagged off-peak', troughNode !== null && troughNode.props['data-offpeak'] === 'true',
  troughNode === null ? 'missing' : String(troughNode.props['data-offpeak']))
{
  const parts = troughNode === null ? [] : collectSpans(troughNode)
  check('the trough badge says 低谷', parts.includes('低谷'), parts.join(' | '))
}
troughBadge.restore()

const flatBadge = boot({
  clock: Date.parse('2026-11-16T10:00:00+08:00'),
  stored: { modelPreset: 'custom', periodSwitch: false },
})
const flatNode = flatBadge.renderBadge()
check('a flat-rate model shows 固定价', flatNode !== null && collectSpans(flatNode).includes('固定价'),
  flatNode === null ? 'missing' : collectSpans(flatNode).join(' | '))
check('a flat-rate badge shows no countdown', flatNode !== null && flatNode.props['data-flat'] === 'true')
flatBadge.restore()

const offBadge = boot({
  clock: Date.parse('2026-11-16T10:00:00+08:00'),
  stored: { showStatus: false },
})
check('the badge can be turned off', offBadge.renderBadge() === null)
offBadge.restore()

/* ==================================================================== */

main.restore()

const report = `${results.join('\n')}\n\nFAILURES: ${failures}\n`
console.log(report)
process.exitCode = failures === 0 ? 0 : 1
