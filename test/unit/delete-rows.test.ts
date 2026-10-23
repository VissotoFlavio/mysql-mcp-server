import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { MAX_DML_LIMIT } from '../../src/db/dml-builder.js';
import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

type Response = { readonly result?: Record<string, unknown> };
const metadata = [
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'tenant_id',
    dataType: 'int',
    isNullable: 'NO',
    columnKey: 'PRI',
    ordinalPosition: 1,
    extra: '',
  },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'id',
    dataType: 'int',
    isNullable: 'NO',
    columnKey: 'PRI',
    ordinalPosition: 2,
    extra: '',
  },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'name',
    dataType: 'varchar',
    isNullable: 'NO',
    columnKey: '',
    ordinalPosition: 3,
    extra: '',
  },
];
const primaryKeys = [
  { schemaName: 'app', tableName: 'orders', constraintName: 'PRIMARY', columnName: 'tenant_id', ordinalPosition: 1 },
  { schemaName: 'app', tableName: 'orders', constraintName: 'PRIMARY', columnName: 'id', ordinalPosition: 2 },
];

function createApplication(
  options: {
    readonly metadata?: readonly Record<string, unknown>[];
    readonly execute?: (...args: unknown[]) => Promise<unknown>;
    readonly audit?: (line: string) => void;
  } = {},
) {
  return createMcpApplication({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    dmlAuditWriter: options.audit,
    driver: {
      createPool() {
        return {
          async query(query: { readonly sql: string }) {
            if (query.sql.includes('KEY_COLUMN_USAGE')) return [primaryKeys, []];
            if (query.sql.includes('TABLES AS tables')) return [options.metadata ?? metadata, []];
            return [[], []];
          },
          async execute(...args: unknown[]) {
            return options.execute?.(...args) ?? [{ affectedRows: 2, changedRows: 2, warningStatus: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
}

async function connect(application: ReturnType<typeof createMcpApplication>) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: Response) => void>();
  let id = 0;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as Response);
      pending.delete(message.id);
    }
  };
  await application.server.connect(server);
  await client.start();
  const request = async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id;
    const response = new Promise<Response>((resolve) => pending.set(requestId, resolve));
    await client.send({ jsonrpc: '2.0', id: requestId, method, params } as never);
    return response;
  };
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'delete-rows-unit-test', version: '1.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request, close: () => application.close() };
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'app',
    table: 'orders',
    filters: [
      { column: 'tenant_id', operator: 'eq', value: 7 },
      { column: 'id', operator: 'in', values: [3, 4] },
    ],
    limit: 10,
    reason: 'bounded delete test',
    ...overrides,
  };
}
function text(response: Response) {
  return ((response.result?.content as ReadonlyArray<{ readonly text: string }>)[0] ?? { text: '' }).text;
}

test('executes one deterministic bounded delete and returns only metadata', async () => {
  let receivedOptions: unknown;
  let receivedValues: unknown;
  let executions = 0;
  const application = createApplication({
    execute: async (options, values) => {
      executions += 1;
      receivedOptions = options;
      receivedValues = values;
      return [{ affectedRows: 2, changedRows: 2, warningStatus: 1 }, []];
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'delete_rows', arguments: args() });
    const result = JSON.parse(text(response));
    assert.deepEqual(result, {
      operation: 'delete',
      operationId: result.operationId,
      target: { schema: 'app', table: 'orders' },
      affectedRows: 2,
      warningCount: 1,
    });
    assert.equal(executions, 1);
    assert.deepEqual(receivedOptions, {
      sql: 'DELETE FROM `app`.`orders` WHERE `tenant_id` = ? AND `id` IN (?, ?) ORDER BY `tenant_id` ASC, `id` ASC LIMIT 10',
      timeout: 30_000,
    });
    assert.deepEqual(receivedValues, [7, 3, 4]);
  } finally {
    await client.close();
  }
});

test('rejects missing filters, invalid limits, and tables without a primary key before execution', async () => {
  let executions = 0;
  const application = createApplication({
    metadata: metadata.map((column) => ({ ...column, columnKey: '' })),
    execute: async () => {
      executions += 1;
      return [{ affectedRows: 1, warningStatus: 0 }, []];
    },
  });
  const client = await connect(application);
  try {
    for (const invalid of [args({ filters: [] }), args({ limit: 0 }), args({ limit: MAX_DML_LIMIT + 1 })]) {
      const response = await client.request('tools/call', { name: 'delete_rows', arguments: invalid });
      assert.equal(response.result?.isError, true);
    }
    assert.equal(executions, 0);
  } finally {
    await client.close();
  }
});

test('sanitizes permission denial and does not retry timeout or leak filter values', async () => {
  for (const [code, expected] of [
    ['ER_TABLEACCESS_DENIED_ERROR', 'MYSQL_PERMISSION_DENIED'],
    ['ER_ROW_IS_REFERENCED_2', 'MYSQL_FOREIGN_KEY_VIOLATION'],
    ['ETIMEDOUT', 'MYSQL_DML_OUTCOME_UNKNOWN'],
    ['ECONNRESET', 'MYSQL_DML_OUTCOME_UNKNOWN'],
  ] as const) {
    let executions = 0;
    const auditLines: string[] = [];
    const application = createApplication({
      audit: (line) => auditLines.push(line),
      execute: async () => {
        executions += 1;
        throw Object.assign(new Error(`raw ${code} secret-filter`), { code });
      },
    });
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', {
        name: 'delete_rows',
        arguments: args({ filters: [{ column: 'name', operator: 'eq', value: 'secret-filter' }] }),
      });
      assert.equal(response.result?.isError, true);
      assert.equal((response.result?.structuredContent as { code: string }).code, expected);
      assert.equal(executions, 1);
      assert.doesNotMatch(JSON.stringify(response), /secret-filter|raw/);
      assert.doesNotMatch(auditLines.join('\n'), /secret-filter/);
    } finally {
      await client.close();
    }
  }
});
