import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { RowDataPacket } from 'mysql2';
import mysql from 'mysql2/promise';

import { loadConnectionConfig } from '../../src/config.js';
import { createMcpApplication } from '../../src/server.js';

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_CONFIRM === 'isolated-database-schema';
const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const table = process.env.MYSQL_DDL_INTEGRATION_TABLE === undefined ? undefined : process.env.MYSQL_DDL_INTEGRATION_TABLE + '_rt';
const renamedTable = table === undefined ? undefined : table + '_r';

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}

interface TableNameRow extends RowDataPacket {
  readonly TABLE_NAME: string;
}

interface FixtureTableRow extends RowDataPacket {
  readonly TABLE_NAME: string;
  readonly TABLE_TYPE: string;
}

interface FixtureColumnRow extends RowDataPacket {
  readonly COLUMN_NAME: string;
  readonly COLUMN_TYPE: string;
  readonly IS_NULLABLE: string;
  readonly COLUMN_KEY: string;
}

test('runs the opt-in rename_table contract against one isolated temporary table', { skip: !enabled }, async () => {
  assert.match(table ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,50}$/);
  assert.match(renamedTable ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,52}$/);
  assert.match(schema ?? '', /^[A-Za-z0-9_]{1,64}$/);
  if (schema === undefined || table === undefined || renamedTable === undefined) throw new Error('Required integration names are unavailable.');

  const connectionConfig = loadConnectionConfig();
  const preflightConnection = await mysql.createConnection({
    host: connectionConfig.host,
    port: connectionConfig.port,
    database: schema,
    user: connectionConfig.user,
    password: connectionConfig.password,
    ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
  });
  try {
    const [existingTables] = await preflightConnection.query<TableNameRow[]>(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)',
      [schema, table, renamedTable],
    );
    assert.deepEqual(existingTables, []);
  } finally {
    await preflightConnection.end();
  }

  const application = createMcpApplication();
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  let createAttempted = false;
  let applicationClosed = false;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as JsonRpcResponse);
      pending.delete(message.id);
    }
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };

  try {
    await application.server.connect(server);
    await client.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'rename-table-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

    createAttempted = true;
    const createResponse = await request('tools/call', {
      name: 'create_table',
      arguments: {
        schema,
        table,
        columns: [{ name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false }],
        primaryKey: ['id'],
        reason: 'Create the isolated rename_table integration fixture',
      },
    });
    assert.equal((createResponse.result?.structuredContent as { operation: string }).operation, 'create_table');

    const renameResponse = await request('tools/call', {
      name: 'rename_table',
      arguments: { schema, table, newTable: renamedTable, reason: 'Run the isolated rename_table integration contract' },
    });
    const renameResult = renameResponse.result?.structuredContent as {
      operation: string;
      target: { schema: string; table: string; newTable: string };
    };
    assert.equal(renameResult.operation, 'rename_table');
    assert.deepEqual(renameResult.target, { schema, table, newTable: renamedTable });

    const missingSource = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    assert.equal(missingSource.result?.isError, true);
    const renamedDescription = await request('tools/call', { name: 'describe_table', arguments: { schema, table: renamedTable } });
    const renamedTableMetadata = renamedDescription.result?.structuredContent as {
      table: { schemaName: string; tableName: string; tableType: string };
    };
    assert.deepEqual(renamedTableMetadata.table, { schemaName: schema, tableName: renamedTable, tableType: 'BASE TABLE' });

    await application.close();
    applicationClosed = true;
  } finally {
    try {
      if (!applicationClosed) await application.close();
    } finally {
      const cleanupConnection = await mysql.createConnection({
        host: connectionConfig.host,
        port: connectionConfig.port,
        database: schema,
        user: connectionConfig.user,
        password: connectionConfig.password,
        ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
      });
      try {
        const isOwnedFixture = async (candidate: string): Promise<boolean> => {
          const [tableRows] = await cleanupConnection.query<FixtureTableRow[]>(
            'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            [schema, candidate],
          );
          if (tableRows.length !== 1 || tableRows[0]?.TABLE_TYPE !== 'BASE TABLE') return false;
          const [columnRows] = await cleanupConnection.query<FixtureColumnRow[]>(
            'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
            [schema, candidate],
          );
          return (
            columnRows.length === 1 &&
            columnRows[0]?.COLUMN_NAME === 'id' &&
            columnRows[0]?.COLUMN_TYPE === 'bigint unsigned' &&
            columnRows[0]?.IS_NULLABLE === 'NO' &&
            columnRows[0]?.COLUMN_KEY === 'PRI'
          );
        };
        if (createAttempted) {
          const quote = String.fromCharCode(96);
          for (const candidate of [renamedTable, table]) {
            if (await isOwnedFixture(candidate)) {
              await cleanupConnection.query('DROP TABLE ' + quote + schema + quote + '.' + quote + candidate + quote);
            }
          }
        }
      } finally {
        await cleanupConnection.end();
      }
    }
  }
});
