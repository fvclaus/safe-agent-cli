import { atom, read, update } from 'claude-code'

import {
  AUTO_CLOSE_MS,
  PANE_ID,
  buildView,
  consumedText,
  levelStyle,
  paneHeader,
  paneOpenArgs,
  parseLaunchLog,
  placementFor,
  resolveLogPath,
  shouldAct,
} from './launch-log.js'

const view = atom({ plugin: 'safe-agent-cli-launch-log', key: 'view' }, null)
const isHintShown = atom(
  { plugin: 'safe-agent-cli-launch-log', key: 'isHintShown' },
  false,
)

// The log read at session start, held until the surface reports fullscreen.
let pending
let isActing = false
// Set once the person focuses the pane, e.g. to scroll it; it then stays
// until they close it.
let isPaneHeld = false

// Reads and validates the log file; undefined for anything that is not a
// fresh version 1 log. Never throws.
async function loadLog($) {
  try {
    const override = await $.env.get('SAFE_AGENT_CLI_LAUNCH_LOG')
    const home = await $.env.get('HOME')
    const path = resolveLogPath(override, home)
    if (path === undefined || !(await $.fs.exists(path))) return undefined
    const parsed = parseLaunchLog(String(await $.fs.read(path)))
    if (!parsed.ok) return undefined
    return { path, raw: parsed.raw, entries: parsed.entries }
  } catch {
    return undefined
  }
}

// Consumes the file, then shows the log: in a pane when the engine seats it,
// else as a hint above the prompt.
async function activate($, log, terminalColumns) {
  try {
    try {
      await $.fs.write(log.path, consumedText(log.raw))
    } catch {
      // An unwritable file is still shown this once.
    }
    const built = buildView(log.entries)
    await update($, view, () => built)

    const opened = await $.ui.open(paneOpenArgs(built, terminalColumns))
    if (placementFor(opened) === 'pane') {
      if (built.autoCloseMs !== null) {
        $.clock.after(AUTO_CLOSE_MS, () => {
          if (!isPaneHeld) void $.ui.close({ id: PANE_ID })
        })
      }
      return
    }

    await $.ui.close({ id: PANE_ID })
    await update($, isHintShown, () => true)
    if (built.autoCloseMs !== null) {
      $.clock.after(AUTO_CLOSE_MS, () => {
        void update($, isHintShown, () => false)
      })
    }
  } catch {
    // The log is a courtesy; a failure must not disturb the session.
  }
}

async function openPane($, current, terminalColumns) {
  await $.ui.open({ ...paneOpenArgs(current, terminalColumns), focus: true, closeOnEscape: true })
  await update($, isHintShown, () => false)
}

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', async ($, e, next) => {
    pending = await loadLog($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (pending !== undefined && !isActing && shouldAct(e.viewport)) {
      isActing = true
      const log = pending
      const terminalColumns = e.viewport?.columns
      pending = undefined
      $.clock.after(0, () => {
        void activate($, log, terminalColumns)
      })
    }

    const current = await read($, view)
    const isShown = await read($, isHintShown)
    if (e.props.hasSurvey || !isShown || current === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const hintStyle = current.hasWarnings ? { color: 'warning' } : { dimColor: true }

    return h(
      Box,
      null,
      h(Text, hintStyle, `${current.hint}  `),
      h(Button, {
        key: 'open',
        label: 'open',
        hotkey: '1',
        plain: true,
        onPress: () => openPane($, current, e.viewport?.columns),
      }),
      h(Text, null, '  '),
      h(Button, {
        key: 'dismiss',
        label: 'dismiss',
        hotkey: '2',
        plain: true,
        role: 'dismiss',
        onPress: () => update($, isHintShown, () => false),
      }),
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const current = await read($, view)
    if (current === null) return next(e)
    if (e.props.isFocused) isPaneHeld = true

    const { Box, Text } = $.ui.resolve(e)
    const headerStyle = current.hasWarnings ? { bold: true, color: 'warning' } : { bold: true }

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { ...headerStyle, wrap: 'wrap' }, paneHeader(current, e.props.bodyColumns, e.props.scroll.bodyRows)),
      ...current.lines.map(line =>
        h(Text, { ...levelStyle(line.level), wrap: 'wrap' }, line.text),
      ),
    )
  })
}
