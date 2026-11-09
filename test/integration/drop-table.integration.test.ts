import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import mysql from 'mysql2/promise';

import { loadConnectionConfig } from '../../src/config.js';
import { createMcpApplication } from '../../src/server.js';

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DDL_DROP_TABLE_ENABLED === 'true' &&
  process.env.MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_CONFIRM === 'isolated-database-schema' &&
  typeof process.env.MYSQL_DDL_DROP_TABLE_INTEGRATION_TABLE === 'string';
const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const table = process.env.MYSQL_DDL_DROP_TABLE_INTEGRATION_TABLE;

test('runs the controlled drop_table contract against one isolated temporary table', { skip: !enabled }, async () => {
  assert.match(table ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,50}$/);
  assert.match(schema ?? '', /^[A-Za-z0-9_]{1,64}$/);

  const connectionConfig = loadConnectionConfig();
  const application = createMcpApplication();
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  let tableCreated = false;
  let tableDropped = false;
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
      clientInfo: { name: 'drop-table-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

    const existing = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    assert.equal(existing.result?.isError, true, 'the isolated drop_table target must not already exist');

    const created = await request('tools/call', {
      name: 'create_table',
      arguments: {
        schema,
        table,
        columns: [
          { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
          { name: 'label', type: { kind: 'varchar', length: 100 }, nullable: false },
        ],
        primaryKey: ['id'],
        reason: 'Create one isolated drop_table integration target',
      },
    });
    assert.equal((created.result?.structuredContent as { operation: string }).operation, 'create_table');
    tableCreated = true;

    const described = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const metadataRevision = (described.result?.structuredContent as { metadataRevision: string }).metadataRevision;
    assert.match(metadataRevision, /^[0-9a-f]{64}$/u);

    const dropped = await request('tools/call', {
      name: 'drop_table',
      arguments: {
        schema,
        table,
        reason: 'Remove the isolated drop_table integration target',
        confirmation: `DROP_TABLE:${metadataRevision}`,
      },
    });
    assert.equal((dropped.result?.structuredContent as { operation: string }).operation, 'drop_table');
    tableDropped = true;
    const absent = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    assert.equal(absent.result?.isError, true, 'the isolated target must be absent after drop_table');
  } finally {
    await application.close();
    const cleanupConnection = await mysql.createConnection({
      host: connectionConfig.host,
      port: connectionConfig.port,
      database: schema,
      user: connectionConfig.user,
      password: connectionConfig.password,
      ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
    });
    try {
      if (tableCreated && !tableDropped) await cleanupConnection.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``);
    } finally {
      await cleanupConnection.end();
    }
  }
});
