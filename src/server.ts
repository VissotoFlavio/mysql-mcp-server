#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { type Environment, type ReadFile } from './config.js';
import type { DdlAuditWriter } from './db/ddl-audit.js';
import type { DmlAuditWriter } from './db/dml-audit.js';
import { createConnectionLayer, type ConnectionLayerBundle, type PoolFactory } from './db/pool.js';
import { registerAlterTableAddColumnTool } from './tools/alter-table-add-column.js';
import { registerAlterTableAddForeignKeyTool } from './tools/alter-table-add-foreign-key.js';
import { registerAlterTableDropColumnTool } from './tools/alter-table-drop-column.js';
import { registerAlterTableDropForeignKeyTool } from './tools/alter-table-drop-foreign-key.js';
import { registerAlterTableModifyColumnTool } from './tools/alter-table-modify-column.js';
import { registerAlterTableRenameColumnTool } from './tools/alter-table-rename-column.js';
import { registerCreateIndexTool } from './tools/create-index.js';
import { registerCreateSchemaTool } from './tools/create-schema.js';
import { registerCreateTableTool } from './tools/create-table.js';
import { registerCreateUniqueIndexTool } from './tools/create-unique-index.js';
import { registerCreateViewTool } from './tools/create-view.js';
import { registerDeleteRowsTool } from './tools/delete-rows.js';
import { registerDescribeTableTool } from './tools/describe-table.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerDropIndexTool } from './tools/drop-index.js';
import { registerDropSchemaTool } from './tools/drop-schema.js';
import { registerDropTableTool } from './tools/drop-table.js';
import { registerDropViewTool } from './tools/drop-view.js';
import { registerExplainQueryTool } from './tools/explain.js';
import { registerInsertRowsTool } from './tools/insert-rows.js';
import { registerReadOnlyQueryTool } from './tools/query.js';
import { registerRenameTableTool } from './tools/rename-table.js';
import { registerTruncateTableTool } from './tools/truncate-table.js';
import { registerUpdateRowsTool } from './tools/update-rows.js';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const SERVER_INFO = Object.freeze({
  name: 'mysql-mcp-server',
  version: packageMetadata.version,
});

export interface McpApplicationOptions {
  readonly environment?: Environment;
  readonly driver?: PoolFactory;
  readonly readFile?: ReadFile;
  readonly dmlAuditWriter?: DmlAuditWriter;
  readonly ddlAuditWriter?: DdlAuditWriter;
}

export interface McpApplication {
  readonly mysql: ConnectionLayerBundle;
  readonly server: McpServer;
  close(): Promise<void>;
}

export function createMcpApplication(options: McpApplicationOptions = {}): McpApplication {
  const mysql = createConnectionLayer(options);
  const server = new McpServer(SERVER_INFO);
  registerDiscoveryTools(server, mysql);
  registerDescribeTableTool(server, mysql);
  registerReadOnlyQueryTool(server, mysql);
  registerExplainQueryTool(server, mysql);
  if (mysql.dmlEnabled) {
    registerInsertRowsTool(server, mysql);
    registerUpdateRowsTool(server, mysql);
    registerDeleteRowsTool(server, mysql);
  }
  if (mysql.createSchemaEnabled) registerCreateSchemaTool(server, mysql);
  if (mysql.ddlEnabled) {
    registerCreateTableTool(server, mysql);
    registerCreateViewTool(server, mysql);
    registerCreateIndexTool(server, mysql);
    registerCreateUniqueIndexTool(server, mysql);
    registerDropIndexTool(server, mysql);
    if (mysql.dropViewMetadataComplete) registerDropViewTool(server, mysql);
    if (mysql.dropTableEnabled && mysql.dropTableMetadataComplete) registerDropTableTool(server, mysql);
    if (mysql.dropSchemaEnabled && mysql.dropSchemaAllowlist.length > 0) registerDropSchemaTool(server, mysql);
    if (mysql.truncateTableEnabled && mysql.truncateTableMetadataComplete) registerTruncateTableTool(server, mysql);
    registerAlterTableAddColumnTool(server, mysql);
    registerAlterTableAddForeignKeyTool(server, mysql);
    registerAlterTableDropForeignKeyTool(server, mysql);
    if (mysql.dropColumnEnabled && mysql.dropColumnMetadataComplete) registerAlterTableDropColumnTool(server, mysql);
    registerAlterTableModifyColumnTool(server, mysql);
    registerAlterTableRenameColumnTool(server, mysql);
    registerRenameTableTool(server, mysql);
  }

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
