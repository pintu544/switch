import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AcpToolCall } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { execProviderMock } = vi.hoisted(() => ({ execProviderMock: vi.fn() }));
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof import('../provider-process')>()),
  execProvider: execProviderMock,
}));
const { createKiroAdapter, kiroAcp, parseKiroWhoami } = await import('./kiro-acp');
beforeEach(() => {
  servers.length = 0;
  execProviderMock.mockReset();
});

it('launches the V3 ACP engine, whose launch refuses the v2 flags', async () => {
  const launch = await kiroAcp.launch({ binaryPath: '/bin/kiro-cli', cwd: '/work', env: {} });
  expect(launch.command).toBe('/bin/kiro-cli');
  expect(launch.args).toEqual(['acp', '--agent-engine=v3']);
});

it('reads a Builder ID sign-in from whoami', () => {
  expect(
    parseKiroWhoami('Logged in with Builder ID\n\nProfile:\n\nbuilder-id-username\n').status
  ).toBe('authenticated');
});

it('reads an Identity Center sign-in from whoami', () => {
  expect(
    parseKiroWhoami('Logged in with IAM Identity Center (https://example.awsapps.com/start)\n')
      .status
  ).toBe('authenticated');
});

it('reads a signed-out whoami as unauthenticated, with the login hint', () => {
  const readiness = parseKiroWhoami('Not logged in. Run kiro-cli login to sign in.');
  expect(readiness.status).toBe('unauthenticated');
  expect(readiness.message).toContain('kiro-cli login');
});

it('reports an unreadable whoami as unknown rather than guessing', () => {
  expect(parseKiroWhoami('').status).toBe('unknown');
});

it('reads social sign-ins from whoami', () => {
  expect(parseKiroWhoami('Logged in with Google\n').status).toBe('authenticated');
  expect(parseKiroWhoami('Logged in with GitHub\n').status).toBe('authenticated');
});

async function checkKiroSignIn(env: Record<string, string>) {
  const check = kiroAcp.checkSignIn;
  if (!check) throw new Error('kiroAcp must define checkSignIn');
  return check({
    binaryPath: '/bin/kiro-cli',
    cwd: '/work',
    env,
    // Kiro's check never uses the handshake: sign-in is the CLI's own.
    handshake: async (): Promise<never> => {
      throw new Error('unused');
    },
  });
}

it('takes a given API key as the sign-in, without running whoami', async () => {
  const readiness = await checkKiroSignIn({ KIRO_API_KEY: 'k-test' });
  expect(readiness.status).toBe('authenticated');
  expect(execProviderMock).not.toHaveBeenCalled();
});

it('checks sign-in with whoami when no key is given', async () => {
  execProviderMock.mockResolvedValue({ stdout: 'Logged in with Builder ID\n', stderr: '' });
  const readiness = await checkKiroSignIn({});
  expect(readiness.status).toBe('authenticated');
});

it('reads a signed-out whoami whose error lands on stderr', async () => {
  execProviderMock.mockRejectedValue({ stdout: '', stderr: 'Error: Not logged in.' });
  const readiness = await checkKiroSignIn({});
  expect(readiness.status).toBe('unauthenticated');
  expect(readiness.message).toContain('kiro-cli login');
});

it('names the MCP server from the V3 mcpTool envelope, and nothing else', () => {
  const toolCall = {
    toolCallId: 'call-1',
    _meta: { kiro: { mcpTool: { version: 1, identity: { serverName: 'switch', toolName: 'x' } } } },
  } as AcpToolCall;
  expect(kiroAcp.mcpServerOf?.(toolCall)).toBe('switch');
  expect(kiroAcp.mcpServerOf?.({ toolCallId: 'call-2' } as AcpToolCall)).toBeUndefined();
  const unversioned = {
    toolCallId: 'call-3',
    _meta: { kiro: { mcpTool: { identity: { serverName: 'switch' } } } },
  } as unknown as AcpToolCall;
  expect(kiroAcp.mcpServerOf?.(unversioned)).toBeUndefined();
});

it('starts a session without an authenticate call: the CLI owns sign-in', async () => {
  const adapter = createKiroAdapter();
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(session.nativeSessionId).toBe('native');
  const server = servers.at(-1)!;
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('resumes the exact native session', async () => {
  const adapter = createKiroAdapter();
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
    resume: { nativeSessionId: 'native' },
  });
  expect(session.nativeSessionId).toBe('native');
  const server = servers.at(-1)!;
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
  });
});
