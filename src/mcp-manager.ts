import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDef } from './tools/index.js';

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  serverName: string;
}

const connections: McpConnection[] = [];
const CONFIG_PATH = resolve(process.cwd(), 'mcp-servers.json');

function loadConfig(): McpConfigFile | null {
  if (!existsSync(CONFIG_PATH)) {
    console.log('[MCP] No mcp-servers.json found — skipping MCP initialization');
    return null;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as McpConfigFile;
  } catch (err) {
    console.error('[MCP] Failed to parse mcp-servers.json:', err);
    return null;
  }
}

async function connectServer(name: string, config: McpServerConfig): Promise<ToolDef[]> {
  if (Boolean(config.command) === Boolean(config.url)) {
    throw new Error('Configure exactly one MCP transport: command or url.');
  }
  const expandEnv = (value: string): string => value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const resolved = process.env[key]?.trim();
    if (!resolved) throw new Error(`Missing required MCP environment variable: ${key}`);
    return resolved;
  });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.url) {
    const url = new URL(expandEnv(config.url));
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Remote MCP URLs must use HTTPS and may not contain credentials.');
    }
    const headers = Object.fromEntries(
      Object.entries(config.headers || {}).map(([key, value]) => [key, expandEnv(value)]),
    );
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
  } else {
    transport = new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });
  }

  const client = new Client({ name: `assistant-${name}`, version: '1.0.0' });

  await client.connect(transport);
  connections.push({ client, transport, serverName: name });

  const { tools } = await client.listTools();
  console.log(`[MCP] ${name}: ${tools.length} tool(s) discovered`);

  return tools.map((tool) => ({
    definition: {
      name: `mcp_${name}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_')}`,
      description: tool.description || `${name}: ${tool.name}`,
      input_schema: {
        type: 'object' as const,
        ...((tool.inputSchema as Record<string, unknown>) || {}),
      } as Anthropic.Tool.InputSchema,
    },
    handler: async (input: Record<string, unknown>) => {
      try {
        const result = await client.callTool({ name: tool.name, arguments: input });
        const parts = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text);
        return parts.join('\n') || 'Done (no text output).';
      } catch (err) {
        return `MCP tool error (${name}/${tool.name}): ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }));
}

export async function startMcpServers(): Promise<Record<string, ToolDef[]>> {
  const config = loadConfig();
  if (!config || !config.mcpServers) return {};

  const result: Record<string, ToolDef[]> = {};

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    // A server whose ${VAR} references aren't set (e.g. no INSTACART_API_KEY)
    // can't start; skip it quietly instead of failing on every boot.
    const missing = [...JSON.stringify(serverConfig).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]).filter((k) => !process.env[k]?.trim());
    if (missing.length) {
      console.log(`[MCP] ${name}: skipped (set ${missing.join(', ')} to enable)`);
      continue;
    }
    try {
      const target = serverConfig.url || `${serverConfig.command} ${(serverConfig.args || []).join(' ')}`;
      console.log(`[MCP] Starting ${name} (${target})...`);
      const tools = await connectServer(name, serverConfig);
      if (tools.length > 0) {
        result[name] = tools;
      }
      console.log(`[MCP] ${name}: ready`);
    } catch (err) {
      console.warn(`[MCP] ${name}: failed to start — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export async function stopMcpServers(): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.client.close();
      console.log(`[MCP] ${conn.serverName}: disconnected`);
    } catch {
      // Best effort cleanup
    }
  }
  connections.length = 0;
}
