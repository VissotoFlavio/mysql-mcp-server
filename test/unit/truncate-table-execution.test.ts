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
    clientInfo: { name: 'truncate-table-unit-test', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request };
}

const description = {
  table: { schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' },
  columns: [{ columnName: 'id', dataType: 'bigint', isNullable: false, columnKey: 'PRI' }],
};

test('truncate_table is capability-gated, target-bound, canonical, audited, effect-documented, and sanitized', async () => {
  let executeCalls = 0;
  let createTime = '2026-11-09 20:00:00';
  const audit: string[] = [];
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'true',
      MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE: 'true',
    }),
    ddlAuditWriter: (line) => audit.push(line),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('KEY_COLUMN_USAGE')) return [[], []];
            return [
              [
                {
                  ...description.table,
                  createTime,
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
            assert.equal(options.sql, 'TRUNCATE TABLE `app`.`orders`');
            createTime = '2026-11-09 20:01:00';
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const listed = (await client.request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'truncate_table'));
    const described = await client.request('tools/call', { name: 'describe_table', arguments: { schema: 'app', table: 'orders' } });
    const metadataRevision = (described.result?.structuredContent as { metadataRevision: string }).metadataRevision;
    const response = await client.request('tools/call', {
      name: 'truncate_table',
      arguments: { schema: 'app', table: 'orders', reason: 'Clear the staging rows.', confirmation: `TRUNCATE_TABLE:${metadataRevision}` },
    });
    assert.equal(response.result?.isError, undefined);
    assert.equal(executeCalls, 1);
    assert.deepEqual(JSON.parse((response.result?.content as readonly { text: string }[])[0].text), {
      operation: 'truncate_table',
      operationId: (response.result?.structuredContent as { operationId: string }).operationId,
      target: { schema: 'app', table: 'orders' },
      warnings: 0,
      effects: ['AUTO_INCREMENT_RESET', 'IMPLICIT_COMMIT_NO_ROLLBACK', 'METADATA_LOCKS'],
    });
    assert.doesNotMatch(JSON.stringify(response), /TRUNCATE TABLE|staging rows|[a-f0-9]{64}/);
    const completedAudit = audit.map((line) => JSON.parse(line)).find((event) => event.phase === 'completed');
    assert.equal(completedAudit.operation, 'truncate_table');
    assert.equal(completedAudit.reason.length, 64);
  } finally {
    await application.close();
  }
});

test('rejects a stale truncate revision before execution and returns a sanitized permission outcome', async () => {
  let executeCalls = 0;
  let dataType = 'bigint';
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'true',
      MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('KEY_COLUMN_USAGE')) return [[], []];
            return [
              [{ ...description.table, createTime: '2026-11-09 20:00:00', columnName: 'id', dataType, isNullable: 'NO', columnKey: 'PRI' }],
              [],
            ];
          },
          async execute() {
            executeCalls += 1;
            const error = new Error('driver detail') as Error & { code: string };
            error.code = 'ER_TABLEACCESS_DENIED_ERROR';
            throw error;
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
    const stale = await client.request('tools/call', {
      name: 'truncate_table',
      arguments: { schema: 'app', table: 'orders', reason: 'Clear it.', confirmation: `TRUNCATE_TABLE:${metadataRevision}` },
    });
    assert.equal(stale.result?.isError, true);
    assert.deepEqual(stale.result?.structuredContent, {
      code: 'MYSQL_DDL_METADATA_INVALID',
      message: 'Unable to validate the requested table metadata.',
    });
    assert.equal(executeCalls, 0);
    dataType = 'bigint';
    const fresh = await client.request('tools/call', { name: 'describe_table', arguments: { schema: 'app', table: 'orders' } });
    const freshRevision = (fresh.result?.structuredContent as { metadataRevision: string }).metadataRevision;
    const denied = await client.request('tools/call', {
      name: 'truncate_table',
      arguments: { schema: 'app', table: 'orders', reason: 'Clear it.', confirmation: `TRUNCATE_TABLE:${freshRevision}` },
    });
    assert.equal(denied.result?.isError, true);
    assert.deepEqual(denied.result?.structuredContent, {
      code: 'MYSQL_DDL_PERMISSION_DENIED',
      message: 'MySQL denied permission for this DDL operation.',
    });
    assert.equal(executeCalls, 1);
  } finally {
    await application.close();
  }
});

test('returns an indeterminate outcome when the target identity changes after submission', async () => {
  let createTime = '2026-11-09 20:00:00';
  let dataType = 'bigint';
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'true',
      MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('KEY_COLUMN_USAGE')) return [[], []];
            return [[{ ...description.table, createTime, columnName: 'id', dataType, isNullable: 'NO', columnKey: 'PRI' }], []];
          },
          async execute() {
            executeCalls += 1;
            createTime = '2026-11-09 20:01:00';
            dataType = 'varchar';
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
    const response = await client.request('tools/call', {
      name: 'truncate_table',
      arguments: { schema: 'app', table: 'orders', reason: 'Clear it.', confirmation: `TRUNCATE_TABLE:${metadataRevision}` },
    });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, {
      result: 'indeterminate',
      code: 'MYSQL_DDL_OUTCOME_UNKNOWN',
      message: 'The DDL outcome is unknown; verify state before retrying.',
      retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
    });
    assert.equal(executeCalls, 1);
  } finally {
    await application.close();
  }
});
