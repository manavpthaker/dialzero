import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ToolDef } from './index.js';
import { validateRepoName } from './path-utils.js';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = join(__dirname, '..', '..', 'context');

export const githubTools: ToolDef[] = [
  {
    definition: {
      name: 'read_context_file',
      description: 'Read a file from the assistant context directory or a local repo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path from context/ dir, or absolute path to a repo file' },
        },
        required: ['path'],
      },
    },
    handler: async (input) => {
      const path = input.path as string;
      const fullPath = path.startsWith('/') ? path : join(CONTEXT_DIR, path);
      if (!existsSync(fullPath)) return `File not found: ${path}`;
      return readFileSync(fullPath, 'utf-8');
    },
  },
  {
    definition: {
      name: 'write_context_file',
      description: 'Write or append to a file in the assistant context directory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path from context/ dir' },
          content: { type: 'string', description: 'Content to write' },
          append: { type: 'boolean', description: 'Append instead of overwrite (default: false)' },
        },
        required: ['path', 'content'],
      },
    },
    handler: async (input) => {
      const path = input.path as string;
      const content = input.content as string;
      const append = input.append as boolean || false;
      const fullPath = join(CONTEXT_DIR, path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (append) {
        const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : '';
        writeFileSync(fullPath, existing + content, 'utf-8');
      } else {
        writeFileSync(fullPath, content, 'utf-8');
      }
      return `Written to ${path}`;
    },
  },
  {
    definition: {
      name: 'git_commit_summary',
      description: 'Get recent git commit summary for a repository.',
      input_schema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repo name under ~/GitHub/' },
          days: { type: 'number', description: 'Number of days to look back (default: 7)' },
        },
        required: ['repo'],
      },
    },
    handler: async (input) => {
      const repo = input.repo as string;
      const days = (input.days as number) || 7;
      let repoPath: string;
      try {
        repoPath = validateRepoName(repo);
      } catch (err) {
        return `git_commit_summary rejected: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const { stdout } = await exec('git', [
          'log',
          `--since=${days} days ago`,
          '--oneline',
          '--no-merges',
          '-20',
        ], { cwd: repoPath });
        return stdout.trim() || `No commits in the last ${days} days.`;
      } catch {
        return `Could not read git log for ${repo}. Is it a valid repo?`;
      }
    },
  },
  {
    definition: {
      name: 'list_repo_files',
      description: 'List files and directories in a local repo path. Use to discover what docs/files exist.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Absolute path to list, e.g. ~/GitHub/<repo>/docs (must be inside an allowlisted repo)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        },
        required: ['path'],
      },
    },
    handler: async (input) => {
      const dirPath = input.path as string;
      const recursive = input.recursive as boolean || false;
      if (!existsSync(dirPath)) return `Path not found: ${dirPath}`;

      function listDir(dir: string, prefix: string = ''): string[] {
        const entries: string[] = [];
        for (const name of readdirSync(dir)) {
          if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
          const full = join(dir, name);
          const isDir = statSync(full).isDirectory();
          entries.push(`${prefix}${name}${isDir ? '/' : ''}`);
          if (isDir && recursive) {
            entries.push(...listDir(full, prefix + '  '));
          }
        }
        return entries;
      }

      const result = listDir(dirPath).join('\n');
      return result.slice(0, 8000) + (result.length > 8000 ? '\n\n[Truncated]' : '');
    },
  },
];
