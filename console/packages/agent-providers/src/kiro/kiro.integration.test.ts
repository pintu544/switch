import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the kiro-cli binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a key in the shell
  // would not reach it and the CLI would fall back to an interactive sign-in.
  ...(process.env.KIRO_API_KEY ? { env: { KIRO_API_KEY: process.env.KIRO_API_KEY } } : {}),
});
