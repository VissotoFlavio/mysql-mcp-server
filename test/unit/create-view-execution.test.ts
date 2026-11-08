import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface Response {
  readonly result?: Record<string, unknown>;
}

test('create_view is DDL-gated, preflights only metadata, emits canonical SQL, and sanitizes errors', async () => {
  let executeCalls = 0;
  let statement: unknown;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('information_schema.TABLES'))
              return [[{ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE' }], []];
            return [
              [
                { columnName: 'id', ordinalPosition: 1, extra: '' },
                { columnName: 'label', ordinalPosition: 2, extra: '' },
              ],
              [],
            ];
          },
          async execute(options: unknown) {
            executeCalls += 1;
            statement = options;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: Response) => void>();
  let id = 0;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as Response);
      pending.delete(message.id);
    }
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id;
    const response = new Promise<Response>((resolve) => pending.set(requestId, resolve));
    await client.send({ jsonrpc: '2.0', id: requestId, method, params } as never);
    return response;
  };
  try {
    await application.server.connect(server);
    await client.start();
    await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
    const listed = (await request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'create_view'));
    const response = await request('tools/call', {
      name: 'create_view',
      arguments: {
        schema: 'app',
        view: 'account_labels',
        definition: { table: 'accounts', columns: ['id', 'label'] },
        reason: 'Expose reporting labels.',
      },
    });
    assert.equal(response.result?.isError, undefined);
    assert.equal(executeCalls, 1);
    assert.deepEqual(statement, {
      sql: 'CREATE SQL SECURITY INVOKER VIEW `app`.`account_labels` AS SELECT `id`, `label` FROM `app`.`accounts`',
      timeout: 30_000,
    });
    assert.doesNotMatch(JSON.stringify(response), /CREATE SQL|Expose reporting/);
  } finally {
    await application.close();
  }
});

test('rejects unsafe metadata and returns one sanitized indeterminate execution outcome without retrying', async () => {
  for (const [columns, requestedColumns, failure, code, retryAdvice, expectedCalls] of [
    [[{ columnName: 'id', ordinalPosition: 1, extra: '' }], ['missing'], undefined, 'MYSQL_DDL_STRUCTURE_INVALID', undefined, 0],
    [
      [{ columnName: 'id', ordinalPosition: 1, extra: '' }],
      ['id'],
      Object.assign(new Error('view-driver-secret'), { code: 'ECONNRESET' }),
      'MYSQL_DDL_OUTCOME_UNKNOWN',
      'VERIFY_STATE_BEFORE_RETRYING',
      1,
    ],
  ] as const) {
    let executeCalls = 0;
    const application = createMcpApplication({
      environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
      driver: {
        createPool: () =>
          ({
            async query(options: { sql: string }) {
              if (options.sql.includes('information_schema.TABLES'))
                return [[{ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE' }], []];
              return [columns, []];
            },
            async execute() {
              executeCalls += 1;
              if (failure !== undefined) throw failure;
              return [{ affectedRows: 0, warningStatus: 0 }, []];
            },
            async end() {},
          }) as never,
      },
    });
    const [client, server] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (response: Response) => void>();
    let id = 0;
    client.onmessage = (message) => {
      if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
        pending.get(message.id)?.(message as Response);
        pending.delete(message.id);
      }
    };
    const request = async (method: string, params: Record<string, unknown>) => {
      const requestId = ++id;
      const response = new Promise<Response>((resolve) => pending.set(requestId, resolve));
      await client.send({ jsonrpc: '2.0', id: requestId, method, params } as never);
      return response;
    };
    try {
      await application.server.connect(server);
      await client.start();
      await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
      const response = await request('tools/call', {
        name: 'create_view',
        arguments: {
          schema: 'app',
          view: 'account_ids',
          definition: { table: 'accounts', columns: requestedColumns },
          reason: 'Create a test view.',
        },
      });
      const structured = response.result?.structuredContent as { code: string; retryAdvice?: string };
      assert.equal(response.result?.isError, true);
      assert.equal(structured.code, code);
      assert.equal(structured.retryAdvice, retryAdvice);
      assert.deepEqual(Object.keys(structured).sort(), retryAdvice === undefined ? ['code', 'message'] : ['code', 'message', 'retryAdvice']);
      assert.equal(executeCalls, expectedCalls);
      assert.doesNotMatch(JSON.stringify(response), /view-driver-secret|CREATE SQL|missing/);
    } finally {
      await application.close();
    }
  }
});
