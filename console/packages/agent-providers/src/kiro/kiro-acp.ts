import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIRO_LOGIN = 'kiro-cli login';

/** Reads `kiro-cli whoami`, which names the sign-in it found. */
export function parseKiroWhoami(output: string): ProviderReadiness {
  if (/not logged in/i.test(output)) return readiness('unauthenticated', signInWith(KIRO_LOGIN));
  if (/^Logged in with/im.test(output)) return readiness('authenticated', 'Signed in.');
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/**
 * Kiro CLI's `kiro-cli acp --agent-engine=v3`, on the generic ACP adapter.
 *
 * The V3 engine is named at launch: it refuses the v2 launch flags, selects
 * the model through the advertised `model` config option (which the generic
 * adapter already drives), and negotiates its extra methods at the handshake
 * (`agentCapabilities._meta.kiro.extensionMethods`), so nothing here keys off
 * a CLI version. Authentication stays the CLI's own — no `--auth-method` is
 * passed, so the CLI never asks Switch for a token; a person signs in with
 * `kiro-cli login` on the execution machine.
 */
export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    // V3 can steer through a private method, but a message sent mid-turn is
    // queued for a Kiro agent in Switch, as the provider's contract states.
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp', '--agent-engine=v3'],
    env,
  }),
  loginCommand: KIRO_LOGIN,
  // The CLI reads its API key from the machine's environment for headless
  // sign-in; the session host passes it through like the vendor keys.
  inheritEnv: ['KIRO_API_KEY'],
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    // A key cannot be checked without spending a request: it is taken as
    // given, and a bad one fails the first turn.
    if (env.KIRO_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the Kiro API key it was given.');
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['whoami'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      // commandOutput reads stdout only; a signed-out whoami may exit
      // non-zero with its "Not logged in" error on stderr, so read that too.
      const stderr = (error as { stderr?: unknown }).stderr;
      output = commandOutput(error) + (typeof stderr === 'string' ? `\n${stderr}` : '');
    }
    return parseKiroWhoami(output);
  },
  // Kiro advertises image prompts at the handshake; naming it here keeps the
  // capability when a deployment's advertisement is read narrowly.
  promptCapabilities: { image: true },
  // Kiro's modes are agent configurations (the default, "vibe", a custom
  // agent), not permission levels, so no session mode is set: the agent
  // keeps its own, and the runtime mode is enforced on its permission
  // requests.
  mcpServerOf: (toolCall) => {
    // A V3 permission request or tool call names its MCP server in the
    // versioned `_meta.kiro.mcpTool` envelope.
    const meta = toolCall._meta as
      | { kiro?: { mcpTool?: { version?: unknown; identity?: { serverName?: unknown } } } }
      | undefined;
    const envelope = meta?.kiro?.mcpTool;
    if (envelope?.version !== 1) return undefined;
    const server = envelope.identity?.serverName;
    return typeof server === 'string' && server ? server : undefined;
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
