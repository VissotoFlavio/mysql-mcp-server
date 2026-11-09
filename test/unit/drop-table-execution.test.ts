import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface Response {
  readonly result?: Record<string, unknown>;
}

async function connect(application: ReturnType<typeof createMcpApplication>) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: Response) => void>();
  let requestId = 0;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as Response);
      pending.delete(message.id);
    }
  };
  await application.server.connect(server);
  await client.start();
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<Response>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'drop-table-unit-test', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request };
}

const description = {
  table: { schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' },
  columns: [{ columnName: 'id', dataType: 'bigint', isNullable: false, columnKey: 'PRI' }],
};
test('drop_table is capability-gated, revision-bound, canonical, verified, and sanitized', async () => {
  let executed = false;
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_TABLE_ENABLED: 'true',
      MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (
              options.sql.includes('KEY_COLUMN_USAGE') ||
              options.sql.includes('VIEW_TABLE_USAGE') ||
              options.sql.includes('information_schema.TRIGGERS')
            )
              return [[], []];
            return executed
              ? [[], []]
              : [
                  [
                    {
                      ...description.table,
                      createTime: '2026-11-09 20:00:00',
                      columnName: 'id',
                      dataType: 'bigint',
                      isNullable: 'NO',
                      columnKey: 'PRI',
                    },
                  ],
                  [],
                ];
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'DROP TABLE `app`.`orders`');
            executed = true;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const listed = (await client.request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'drop_table'));
    const described = await client.request('tools/call', { name: 'describe_table', arguments: { schema: 'app', table: 'orders' } });
    const metadataRevision = (described.result?.structuredContent as { metadataRevision: string }).metadataRevision;
    const response = await client.request('tools/call', {
      name: 'drop_table',
      arguments: { schema: 'app', table: 'orders', reason: 'Remove the retired table.', confirmation: `DROP_TABLE:${metadataRevision}` },
    });
    assert.equal(response.result?.isError, undefined);
    assert.equal(executeCalls, 1);
    assert.deepEqual(JSON.parse((response.result?.content as readonly { text: string }[])[0].text), {
      operation: 'drop_table',
      operationId: (response.result?.structuredContent as { operationId: string }).operationId,
      target: { schema: 'app', table: 'orders' },
      warnings: 0,
    });
    assert.doesNotMatch(JSON.stringify(response), /DROP TABLE|retired table|[a-f0-9]{64}/);
  } finally {
    await application.close();
  }
});

test('rejects a stale revision before executing DROP TABLE', async () => {
  let executeCalls = 0;
  let dataType = 'bigint';
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_TABLE_ENABLED: 'true',
      MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (
              options.sql.includes('KEY_COLUMN_USAGE') ||
              options.sql.includes('VIEW_TABLE_USAGE') ||
              options.sql.includes('information_schema.TRIGGERS')
            )
              return [[], []];
            return [
              [{ ...description.table, createTime: '2026-11-09 20:00:00', columnName: 'id', dataType, isNullable: 'NO', columnKey: 'PRI' }],
              [],
            ];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const described = await client.request('tools/call', { name: 'describe_table', arguments: { schema: 'app', table: 'orders' } });
    const metadataRevision = (described.result?.structuredContent as { metadataRevision: string }).metadataRevision;
    dataType = 'varchar';
    const response = await client.request('tools/call', {
      name: 'drop_table',
      arguments: { schema: 'app', table: 'orders', reason: 'Remove it.', confirmation: `DROP_TABLE:${metadataRevision}` },
    });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, {
      code: 'MYSQL_DDL_METADATA_INVALID',
      message: 'Unable to validate the requested table metadata.',
    });
    assert.equal(executeCalls, 0);
  } finally {
    await application.close();
  }
});
