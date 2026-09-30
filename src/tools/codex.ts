import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { ToolDef } from './index.js';
import { validateRepoName } from './path-utils.js';
import { completeWorkRequest, createWorkRequest, failWorkRequest, startWorkRequest } from '../db.js';

// launchd's default PATH excludes Homebrew, so keep an absolute, overridable
// path just as the old Claude runner did.
const CODEX_BIN = process.env.CODEX_BIN || '/opt/homebrew/bin/codex';
// ChatGPT-authenticated Codex CLI accounts may not expose the API-only
// Codex model aliases, so use the known-good general OpenAI model by default.
// Set CODEX_MODEL=gpt-5.3-codex when the local Codex install has that access.
const CODEX_MODEL = process.env.CODEX_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-terra';
// workspace-write is the safer default for unattended repo work. Motions that
// genuinely need networked git/browser access can opt into danger-full-access
// explicitly in .env; the old runner was always fully unsandboxed.
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'workspace-write';
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

function sandboxArg(): CodexSandbox {
  if (CODEX_SANDBOX === 'read-only' || CODEX_SANDBOX === 'danger-full-access') return CODEX_SANDBOX;
  return 'workspace-write';
}

/**
 * Run Codex non-interactively in an absolute repo path. Prompt is sent over
 * stdin so large motion prompts do not hit argv limits. This function never
 * rejects; callers receive a useful status string for iMessage or a digest.
 */
export function runCodex(repoPath: string, prompt: string, timeoutMs: number): Promise<string> {
  if (!existsSync(CODEX_BIN)) {
    return Promise.resolve(
      `Codex CLI not found at ${CODEX_BIN}. Set CODEX_BIN to the absolute path of the \`codex\` CLI.`,
    );
  }

  return new Promise<string>((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(CODEX_BIN, [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--color', 'never',
      '--model', CODEX_MODEL,
      '-c', 'approval_policy="never"',
      '--sandbox', sandboxArg(),
      '-C', repoPath,
      '-',
    ], {
      cwd: repoPath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(`Codex session timed out after ${Math.round(timeoutMs / 60000)} minutes. Partial output:\n${output.slice(-2000)}`);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) finish(output || 'Codex session completed with no output.');
      else finish(`Codex exited with code ${code}. Output:\n${output.slice(-2000)}`);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      finish(`Failed to spawn Codex: ${err.message}`);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export const codexTools: ToolDef[] = [
  {
    definition: {
      name: 'spawn_codex',
      description: 'Spawn a Codex CLI session on the Mac mini to work on a repository. Runs non-interactively with the configured sandbox and coding model. Returns the session output when complete. Use for explicit code changes, debugging, and development tasks.',
      input_schema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name under ~/GitHub/' },
          prompt: { type: 'string', description: 'The task prompt for Codex' },
        },
        required: ['repo', 'prompt'],
      },
    },
    handler: async (input, context) => {
      const repo = input.repo as string;
      const prompt = input.prompt as string;
      let repoPath: string;
      try {
        repoPath = validateRepoName(repo);
      } catch (err) {
        return `spawn_codex rejected: ${err instanceof Error ? err.message : String(err)}`;
      }
      const requestId = createWorkRequest({
        kind: 'codex',
        workspace: 'repo',
        operation: 'execute',
        repo,
        requestText: prompt,
        groupId: context?.groupKey,
      });
      startWorkRequest(requestId);
      const result = await runCodex(repoPath, prompt, TOOL_TIMEOUT_MS);
      const failed = /^(Codex CLI not found|Codex session timed out|Codex exited|Failed to spawn Codex)/.test(result);
      if (failed) failWorkRequest(requestId, result); else completeWorkRequest(requestId, result);
      return `[${requestId}]\n${result.slice(-4000)}`;
    },
  },
];
