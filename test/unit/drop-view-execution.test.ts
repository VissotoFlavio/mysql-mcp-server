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
    clientInfo: { name: 'drop-view-unit-test', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request };
}

test('drop_view is DDL-gated, dependency-aware, canonical, verified, and sanitized', async () => {
  let executed = false;
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE: 'true' }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('VIEW_TABLE_USAGE')) return [[], []];
            return [executed ? [] : [{ schemaName: 'app', tableName: 'account_labels', tableType: 'VIEW' }], []];
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'DROP VIEW `app`.`account_labels`');
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
    assert.ok(listed.some(({ name }) => name === 'drop_view'));
    const response = await client.request('tools/call', {
      name: 'drop_view',
      arguments: { schema: 'app', view: 'account_labels', reason: 'Remove the obsolete projection.', confirmation: 'DROP_VIEW' },
    });
    assert.equal(response.result?.isError, undefined);
    assert.equal(executeCalls, 1);
    assert.deepEqual(JSON.parse((response.result?.content as readonly { text: string }[])[0].text), {
      operation: 'drop_view',
      operationId: (response.result?.structuredContent as { operationId: string }).operationId,
      target: { schema: 'app', view: 'account_labels' },
      warnings: 0,
    });
    assert.doesNotMatch(JSON.stringify(response), /DROP VIEW|obsolete projection/);
  } finally {
    await application.close();
  }
});

test('rejects an unconfirmed or dependent drop_view without executing DDL', async () => {
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE: 'true' }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('VIEW_TABLE_USAGE'))
              return [[{ viewSchemaName: 'app', viewName: 'account_report', tableSchemaName: 'app', tableName: 'account_labels' }], []];
            return [[{ schemaName: 'app', tableName: 'account_labels', tableType: 'VIEW' }], []];
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
    const dependent = await client.request('tools/call', {
      name: 'drop_view',
      arguments: { schema: 'app', view: 'account_labels', reason: 'Remove it.', confirmation: 'DROP_VIEW' },
    });
    assert.deepEqual(dependent.result?.structuredContent, {
      code: 'MYSQL_DDL_STRUCTURE_INVALID',
      message: 'The target view has known dependent views.',
    });
    assert.equal(executeCalls, 0);
  } finally {
    await application.close();
  }
});

test('fails closed when metadata completeness is not explicitly attested', async () => {
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool: () =>
        ({
          async query() {
            return [[{ schemaName: 'app', tableName: 'account_labels', tableType: 'VIEW' }], []];
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
    assert.ok(!listed.some(({ name }) => name === 'drop_view'));
    assert.equal(executeCalls, 0);
  } finally {
    await application.close();
  }
});

test('returns view-specific sanitized messages for metadata rejection paths', async () => {
  const cases = [
    {
      name: 'missing view',
      query: () => [[], []],
      expected: { code: 'MYSQL_DDL_TABLE_INVALID', message: 'The target must be an existing view.' },
    },
    {
      name: 'base table',
      query: (sql: string) =>
        sql.includes('VIEW_TABLE_USAGE') ? [[], []] : [[{ schemaName: 'app', tableName: 'account_labels', tableType: 'BASE TABLE' }], []],
      expected: { code: 'MYSQL_DDL_TABLE_INVALID', message: 'The target must be an existing view.' },
    },
    {
      name: 'unavailable metadata',
      query: () => {
        throw new Error('driver detail is not exposed');
      },
      expected: { code: 'MYSQL_DDL_METADATA_INVALID', message: 'Unable to validate the requested table metadata.' },
    },
  ] as const;

  for (const testCase of cases) {
    let executeCalls = 0;
    const application = createMcpApplication({
      environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE: 'true' }),
      driver: {
        createPool: () =>
          ({
            async query(options: { sql: string }) {
              return testCase.query(options.sql) as never;
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
      const response = await client.request('tools/call', {
        name: 'drop_view',
        arguments: { schema: 'app', view: 'account_labels', reason: `Reject ${testCase.name}.`, confirmation: 'DROP_VIEW' },
      });
      assert.equal(response.result?.isError, true);
      assert.deepEqual(response.result?.structuredContent, testCase.expected);
      assert.deepEqual(response.result?.content, [{ type: 'text', text: testCase.expected.message }]);
      assert.equal(executeCalls, 0);
    } finally {
      await application.close();
    }
  }
});
