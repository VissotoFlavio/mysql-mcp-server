import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

const input = { schema: 'app', table: 'orders', constraint: 'orders_customer_fk', reason: 'Remove the obsolete relationship.' };
test('runs DROP FOREIGN KEY once after metadata preflight and sanitizes driver failures', async () => {
  const responses = [
    [{ schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' }],
    [{ schemaName: 'app', tableSchemaName: 'app', tableName: 'orders', constraintName: 'orders_customer_fk', constraintType: 'FOREIGN KEY' }],
  ];
  let queryIndex = 0;
  let executions = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [responses[queryIndex++], []];
          },
          async execute() {
            executions += 1;
            throw Object.assign(new Error('mysql://secret'), { code: 'ER_CANNOT_DROP_FIELD_OR_KEY' });
          },
          async end() {},
        } as never;
      },
    },
  });
  const [client, server] = InMemoryTransport.createLinkedPair();
  let id = 0;
  const pending = new Map<number, (value: { result?: Record<string, unknown> }) => void>();
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number')
      pending.get(message.id)?.(message as { result?: Record<string, unknown> });
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = new Promise<{ result?: Record<string, unknown> }>((resolve) => pending.set(++id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  try {
    await application.server.connect(server);
    await client.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'drop-fk-test', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
    const response = await request('tools/call', { name: 'alter_table_drop_foreign_key', arguments: input });
    assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_STRUCTURE_INVALID');
    assert.equal(executions, 1);
  } finally {
    await application.close();
  }
});
