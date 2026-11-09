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
  await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'drop-column-test', version: '1' } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request };
}

const input = { schema: 'app', table: 'orders', column: 'obsolete_label', reason: 'Remove the obsolete label.', confirmation: 'DROP_COLUMN' };

test('advertises only with both DDL opt-ins, executes once, verifies, and sanitizes the result', async () => {
  let targetPresent = true;
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_COLUMN_ENABLED: 'true',
      MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('COLUMNS AS columns'))
              return [
                targetPresent
                  ? [
                      {
                        schemaName: 'app',
                        tableName: 'orders',
                        tableType: 'BASE TABLE',
                        columnName: 'id',
                        ordinalPosition: 1,
                        extra: '',
                        generationExpression: null,
                      },
                      {
                        schemaName: 'app',
                        tableName: 'orders',
                        tableType: 'BASE TABLE',
                        columnName: 'obsolete_label',
                        ordinalPosition: 2,
                        extra: '',
                        generationExpression: null,
                      },
                    ]
                  : [
                      {
                        schemaName: 'app',
                        tableName: 'orders',
                        tableType: 'BASE TABLE',
                        columnName: 'id',
                        ordinalPosition: 1,
                        extra: '',
                        generationExpression: null,
                      },
                    ],
                [],
              ];
            return [[], []];
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'ALTER TABLE `app`.`orders` DROP COLUMN `obsolete_label`');
            targetPresent = false;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const listed = (await client.request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'alter_table_drop_column'));
    const response = await client.request('tools/call', { name: 'alter_table_drop_column', arguments: input });
    assert.equal(response.result?.isError, undefined);
    assert.equal(executeCalls, 1);
    assert.deepEqual(response.result?.structuredContent, {
      operation: 'alter_table_drop_column',
      operationId: (response.result?.structuredContent as { operationId: string }).operationId,
      target: { schema: 'app', table: 'orders', column: 'obsolete_label' },
      warnings: 0,
    });
    assert.doesNotMatch(JSON.stringify(response), /ALTER TABLE|obsolete label/iu);
  } finally {
    await application.close();
  }
});

test('does not advertise the operation when either opt-in is absent', async () => {
  for (const environment of [
    validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    validEnvironment({ MYSQL_DDL_ENABLED: 'false', MYSQL_DDL_DROP_COLUMN_ENABLED: 'true' }),
  ]) {
    let executeCalls = 0;
    const application = createMcpApplication({
      environment,
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[], []];
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
      const listed = (await client.request('tools/list', {})).result?.tools as readonly { name: string }[];
      assert.ok(!listed.some(({ name }) => name === 'alter_table_drop_column'));
      assert.equal(executeCalls, 0);
    } finally {
      await application.close();
    }
  }
});

test('returns a sanitized structural driver outcome without exposing SQL or reason', async () => {
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_COLUMN_ENABLED: 'true',
      MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('COLUMNS AS columns'))
              return [
                [
                  {
                    schemaName: 'app',
                    tableName: 'orders',
                    tableType: 'BASE TABLE',
                    columnName: 'id',
                    ordinalPosition: 1,
                    extra: '',
                    generationExpression: null,
                  },
                  {
                    schemaName: 'app',
                    tableName: 'orders',
                    tableType: 'BASE TABLE',
                    columnName: 'obsolete_label',
                    ordinalPosition: 2,
                    extra: '',
                    generationExpression: null,
                  },
                ],
                [],
              ];
            return [[], []];
          },
          async execute() {
            throw Object.assign(new Error('mysql://secret/raw details'), { code: 'ER_CANNOT_DROP_FIELD_OR_KEY' });
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'alter_table_drop_column', arguments: input });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, { code: 'MYSQL_DDL_STRUCTURE_INVALID', message: 'MySQL rejected the table structure.' });
    assert.doesNotMatch(JSON.stringify(response), /mysql:\/\/secret|raw details|ALTER TABLE|obsolete label/iu);
  } finally {
    await application.close();
  }
});

test('keeps indeterminate outcomes within the documented error schema', async () => {
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_COLUMN_ENABLED: 'true',
      MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'true',
    }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('COLUMNS AS columns'))
              return [
                [
                  {
                    schemaName: 'app',
                    tableName: 'orders',
                    tableType: 'BASE TABLE',
                    columnName: 'id',
                    ordinalPosition: 1,
                    extra: '',
                    generationExpression: null,
                  },
                  {
                    schemaName: 'app',
                    tableName: 'orders',
                    tableType: 'BASE TABLE',
                    columnName: 'obsolete_label',
                    ordinalPosition: 2,
                    extra: '',
                    generationExpression: null,
                  },
                ],
                [],
              ];
            return [[], []];
          },
          async execute() {
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'alter_table_drop_column', arguments: input });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, {
      code: 'MYSQL_DDL_OUTCOME_UNKNOWN',
      message: 'The DDL outcome is unknown; verify state before retrying.',
      retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
    });
    assert.equal('result' in (response.result?.structuredContent as Record<string, unknown>), false);
  } finally {
    await application.close();
  }
});
