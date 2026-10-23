import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import mysql from 'mysql2/promise';

import { createMcpApplication } from '../../src/server.js';

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DML_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DML_ENABLED === 'true' &&
  process.env.MYSQL_DML_INTEGRATION_CONFIRM === 'isolated-database';
const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const table = process.env.MYSQL_DML_INTEGRATION_TABLE;

test('runs the opt-in DML contract against a pre-provisioned isolated table', { skip: !enabled }, async () => {
  assert.match(table ?? '', /^[A-Za-z0-9_]{1,64}$/);
  assert.ok(schema, 'MYSQL_DATABASE or MYSQL_INTEGRATION_SCHEMA is required.');
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: schema,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  });
  const application = createMcpApplication();
  let insertId: number | undefined;
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: { result?: Record<string, unknown> }) => void>();
  let requestId = 0;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as { result?: Record<string, unknown> });
      pending.delete(message.id);
    }
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<{ result?: Record<string, unknown> }>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  try {
    await application.server.connect(server);
    await client.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dml-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
    const args = { schema, table, reason: 'isolated opt-in integration test' };
    const insert = await request('tools/call', { name: 'insert_rows', arguments: { ...args, rows: [{ label: `synthetic-${process.pid}` }] } });
    assert.equal((insert.result?.structuredContent as { operation: string }).operation, 'insert');
    insertId = (insert.result?.structuredContent as { insertId: number }).insertId;
    const update = await request('tools/call', {
      name: 'update_rows',
      arguments: {
        ...args,
        values: { label: `synthetic-updated-${process.pid}` },
        filters: [{ column: 'id', operator: 'eq', value: insertId }],
        limit: 1,
      },
    });
    assert.equal((update.result?.structuredContent as { operation: string }).operation, 'update');
    const deletion = await request('tools/call', {
      name: 'delete_rows',
      arguments: { ...args, filters: [{ column: 'id', operator: 'eq', value: insertId }], limit: 1 },
    });
    assert.equal((deletion.result?.structuredContent as { operation: string }).operation, 'delete');
  } finally {
    await application.close();
    if (insertId !== undefined) {
      await connection.execute(`DELETE FROM \`${table}\` WHERE id = ?`, [insertId]);
    }
    await connection.end();
  }
});
