export type LaunchLogLevel =
  | 'ok'
  | 'info'
  | 'warning'
  | 'error'
  | 'skip'
  | 'progress'

export type LaunchLogLine = { level: LaunchLogLevel; text: string }

export type LaunchLogView = {
  lines: LaunchLogLine[]
  header: string
  hint: string
  hasWarnings: boolean
  autoCloseMs: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'safe-agent-cli-launch-log': {
      view: LaunchLogView | null
      isHintShown: boolean
    }
  }
}
