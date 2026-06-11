import type { AgentAdapter } from '../launcher/safe-agent-cli.js';

function encodeTomlString(value: string): string {
  return JSON.stringify(value);
}

export const codexAdapter: AgentAdapter = {
  programName: 'safe-codex',
  brief: 'Launch Codex with GCP service-account impersonation.',
  executable: 'codex',
  forwardedArgsTarget: 'codex',
  launchLabel: 'Codex',
  buildLaunchArgs: (context) => [
    ...context.writableDirs.flatMap(d => ['--add-dir', d]),
    ...Object.entries(context.credentialEnv).flatMap(([key, value]) => [
      '--config',
      `shell_environment_policy.set.${key}=${encodeTomlString(value)}`,
    ]),
    ...(context.systemInstructionText
      ? ['--config', `developer_instructions=${encodeTomlString(context.systemInstructionText)}`]
      : []),
    ...context.args.rest,
  ],
};
