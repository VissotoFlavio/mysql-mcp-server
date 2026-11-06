import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import mysql from 'mysql2/promise';

import { createMcpApplication } from '../../src/server.js';

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_CONFIRM === 'isolated-database-schema';
const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const table = process.env.MYSQL_DDL_INTEGRATION_TABLE;

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}

test('runs the opt-in CREATE TABLE contract against an explicitly isolated schema', { skip: !enabled }, async () => {
  assert.match(table ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,50}$/);
  assert.match(schema ?? '', /^[A-Za-z0-9_]{1,64}$/);

  const application = createMcpApplication();
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  let createRequested = false;
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
      clientInfo: { name: 'ddl-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

    const existingResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    assert.equal(existingResponse.result?.isError, true, 'the temporary test table must not already exist');

    createRequested = true;
    const createdResponse = await request('tools/call', {
      name: 'create_table',
      arguments: {
        schema,
        table,
        columns: [
          { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
          { name: 'label', type: { kind: 'varchar', length: 255 }, nullable: false },
        ],
        primaryKey: ['id'],
        reason: 'Run the isolated CREATE TABLE integration contract',
      },
    });
    const createResult = createdResponse.result?.structuredContent as { operation: string; target: { schema: string; table: string } };
    assert.equal(createResult.operation, 'create_table');
    assert.deepEqual(createResult.target, { schema, table });

    const describedResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const described = describedResponse.result?.structuredContent as { table: { schemaName: string; tableName: string; tableType: string } };
    assert.deepEqual(described.table, { schemaName: schema, tableName: table, tableType: 'BASE TABLE' });
  } finally {
    try {
      await application.close();
    } finally {
      const cleanupConnection = await mysql.createConnection({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT ?? 3306),
        database: schema,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
      });
      try {
        if (createRequested) await cleanupConnection.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``);
      } finally {
        await cleanupConnection.end();
      }
    }
  }
});
