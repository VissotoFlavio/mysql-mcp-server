import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { type Environment, type ReadFile } from './config.js';
import { createConnectionLayer, type ConnectionLayer, type PoolFactory } from './db/pool.js';
import { registerDiscoveryTools } from './tools/discovery.js';

const SERVER_INFO = Object.freeze({
  name: 'mysql-mcp-server',
  version: '0.1.0',
});

export interface McpApplicationOptions {
  readonly environment?: Environment;
  readonly driver?: PoolFactory;
  readonly readFile?: ReadFile;
}

export interface McpApplication {
  readonly mysql: ConnectionLayer;
  readonly server: McpServer;
  close(): Promise<void>;
}

export function createMcpApplication(options: McpApplicationOptions = {}): McpApplication {
  const mysql = createConnectionLayer(options);
  const server = new McpServer(SERVER_INFO);
  registerDiscoveryTools(server, mysql);

  return Object.freeze({
    mysql,
    server,
    async close(): Promise<void> {
      try {
        await server.close();
      } finally {
        await mysql.close();
      }
    },
  });
}

function writeStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`Unable to start MySQL MCP server: ${message}\n`);
}

export async function startMcpServer(): Promise<void> {
  const application = createMcpApplication();
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closing ??= application.close();
    return closing;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close()
        .catch(writeStartupError)
        .finally(() => process.exit(process.exitCode ?? 0));
    });
  }

  try {
    await application.server.connect(transport);
  } catch (error) {
    await close().catch(writeStartupError);
    throw error;
  }
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isEntrypoint()) {
  void startMcpServer().catch((error: unknown) => {
    writeStartupError(error);
    process.exitCode = 1;
  });
}
