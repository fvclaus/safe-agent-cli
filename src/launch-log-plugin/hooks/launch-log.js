// Pure logic of the launch-log mod: parsing, summarizing and deciding.
// Nothing here touches the engine interface, so it runs under `bun test`.

export const ENV_LOG_PATH = 'SAFE_AGENT_CLI_LAUNCH_LOG'
export const FALLBACK_LOG_PATH = '.claude/safe-agent-cli/launch-log.json'
export const AUTO_CLOSE_MS = 30_000
export const PANE_ID = 'launch-log'
export const PANE_TITLE = 'Launch log'

const LEVELS = ['ok', 'info', 'warning', 'error', 'skip', 'progress']

/** @typedef {'ok' | 'info' | 'warning' | 'error' | 'skip' | 'progress'} Level */
/** @typedef {{ level: Level, text: string }} Entry */
/** @typedef {{ level: Level, text: string }} Line */
/**
 * @typedef {{
 *   lines: Line[],
 *   header: string,
 *   hint: string,
 *   hasWarnings: boolean,
 *   autoCloseMs: number | null,
 * }} View
 */

/**
 * The log file's path: the override when set and non-empty, else the fixed
 * fallback under HOME. Undefined when neither can be formed.
 * @param {string | undefined} override
 * @param {string | undefined} home
 * @returns {string | undefined}
 */
export function resolveLogPath(override, home) {
  if (override !== undefined && override !== '') return override
  if (home === undefined || home === '') return undefined
  return `${home.replace(/\/+$/, '')}/${FALLBACK_LOG_PATH}`
}

/**
 * Reads the file's text into the entries to show. Entries of an unknown shape
 * are dropped. `raw` is the parsed object, kept so it can be written back
 * with only `consumed` changed.
 * @param {string} text
 * @returns {{ ok: true, raw: Record<string, unknown>, entries: Entry[] }
 *   | { ok: false, reason: 'unparsable' | 'version' | 'consumed' | 'empty' }}
 */
export function parseLaunchLog(text) {
  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unparsable' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'unparsable' }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  if (raw['version'] !== 1) return { ok: false, reason: 'version' }
  if (raw['consumed'] === true) return { ok: false, reason: 'consumed' }
  const list = Array.isArray(raw['entries']) ? raw['entries'] : []
  /** @type {Entry[]} */
  const entries = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const level = /** @type {{ level?: unknown }} */ (item).level
    const entryText = /** @type {{ text?: unknown }} */ (item).text
    if (typeof level !== 'string' || !LEVELS.includes(level)) continue
    if (typeof entryText !== 'string') continue
    entries.push({ level: /** @type {Level} */ (level), text: entryText })
  }
  if (entries.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, raw, entries }
}

/**
 * The file's new content: the parsed object with `consumed` set to true.
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
export function consumedText(raw) {
  return `${JSON.stringify({ ...raw, consumed: true })}\n`
}

const PREFIX = {
  ok: 'ok   ',
  info: 'info ',
  warning: 'warn ',
  error: 'error',
  skip: 'skip ',
  progress: '...  ',
}

/**
 * Text props for a level: a theme color for ok, warning and error, dim for
 * the rest.
 * @param {Level} level
 * @returns {{ color?: string, dimColor?: boolean }}
 */
export function levelStyle(level) {
  if (level === 'ok') return { color: 'success' }
  if (level === 'warning') return { color: 'warning' }
  if (level === 'error') return { color: 'error' }
  return { dimColor: true }
}

/**
 * @param {number} count
 * @param {string} noun
 */
function plural(count, noun) {
  if (noun === 'entry') return `${count} ${count === 1 ? 'entry' : 'entries'}`
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Counts, header, hint and the line order: errors, then warnings, then the
 * rest in their original order.
 * @param {Entry[]} entries
 * @returns {View}
 */
export function buildView(entries) {
  const errors = entries.filter(entry => entry.level === 'error')
  const warnings = entries.filter(entry => entry.level === 'warning')
  const rest = entries.filter(
    entry => entry.level !== 'error' && entry.level !== 'warning',
  )
  const hasWarnings = errors.length + warnings.length > 0

  const parts = []
  if (errors.length > 0) parts.push(plural(errors.length, 'error'))
  if (warnings.length > 0) parts.push(plural(warnings.length, 'warning'))
  const summary = hasWarnings ? parts.join(', ') : plural(entries.length, 'entry')

  return {
    lines: [...errors, ...warnings, ...rest].map(entry => ({
      level: entry.level,
      text: `${PREFIX[entry.level]} ${entry.text}`,
    })),
    header: hasWarnings
      ? `${summary} — press Esc to dismiss`
      : `${summary} — closes automatically`,
    hint: `Launch log: ${summary}`,
    hasWarnings,
    autoCloseMs: hasWarnings ? null : AUTO_CLOSE_MS,
  }
}

/**
 * Whether the mod acts at all: only where the surface docks panes, which the
 * terminal reports as `isFullscreen`. Absent or false means do nothing.
 * @param {{ isFullscreen?: boolean } | undefined} viewport
 */
export function shouldAct(viewport) {
  return viewport?.isFullscreen === true
}

/**
 * Where the log shows, from the result of `$.ui.open`: the pane when the
 * engine seated it, otherwise the one-line hint above the prompt.
 * @param {{ isPlaced: boolean }} opened
 * @returns {'pane' | 'hint'}
 */
export function placementFor(opened) {
  return opened.isPlaced ? 'pane' : 'hint'
}

/**
 * How the pane is opened: warnings take the keyboard and close on Escape.
 * @param {View} view
 */
export function paneOpenArgs(view) {
  return view.hasWarnings
    ? { id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true }
    : { id: PANE_ID, title: PANE_TITLE }
}
