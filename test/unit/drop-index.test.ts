import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}

const input = { schema: 'app', table: 'orders', index: 'orders_lookup_idx', reason: 'Remove the redundant lookup index.' };

const tableRows = [{ schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' }];
const primaryIndex = {
  schemaName: 'app',
  tableName: 'orders',
  indexName: 'PRIMARY',
  nonUnique: 0,
  sequenceInIndex: 1,
  collation: 'A',
  columnName: 'id',
  subPart: null,
  expression: null,
  indexType: 'BTREE',
  isVisible: 'YES',
};
const removableIndex = {
  schemaName: 'app',
  tableName: 'orders',
  indexName: 'orders_lookup_idx',
  nonUnique: 1,
  sequenceInIndex: 1,
  collation: 'A',
  columnName: 'customer_id',
  subPart: null,
  expression: null,
  indexType: 'BTREE',
  isVisible: 'YES',
};

async function connect(application: ReturnType<typeof createMcpApplication>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  clientTransport.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      const response = message as JsonRpcResponse;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  };
  await application.server.connect(serverTransport);
  await clientTransport.start();
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'drop-index-unit-test', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request };
}

function toolText(response: JsonRpcResponse): string {
  const content = response.result?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
  assert.equal(content[0]?.type, 'text');
  return content[0].text;
}

function createDropApplication(
  statistics: readonly Record<string, unknown>[],
  foreignKeys: readonly Record<string, unknown>[] = [],
  afterExecuteStatistics: readonly Record<string, unknown>[] = [],
  auditLines: string[] = [],
) {
  let executed = false;
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    ddlAuditWriter: (line) => auditLines.push(line),
    driver: {
      createPool() {
        return {
          async query(options: { sql: string }) {
            if (options.sql.includes('information_schema.TABLES')) return [tableRows, []];
            if (options.sql.includes('KEY_COLUMN_USAGE')) return [foreignKeys, []];
            if (options.sql.includes('information_schema.STATISTICS')) return [executed ? afterExecuteStatistics : statistics, []];
            throw new Error('unexpected metadata query');
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'DROP INDEX `orders_lookup_idx` ON `app`.`orders`');
            executed = true;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  return { application, getExecuteCalls: () => executeCalls };
}

test('runs one canonical drop_index after complete preflight and verifies absence', async () => {
  const auditLines: string[] = [];
  const { application, getExecuteCalls } = createDropApplication([primaryIndex, removableIndex], [], [primaryIndex], auditLines);
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'drop_index', arguments: input });
    assert.equal(response.result?.isError, undefined);
    const result = JSON.parse(toolText(response)) as Record<string, unknown>;
    assert.equal(result.operation, 'drop_index');
    assert.deepEqual(result.target, { schema: 'app', table: 'orders', index: 'orders_lookup_idx' });
    assert.equal(typeof result.operationId, 'string');
    assert.equal(result.warnings, 0);
    assert.equal(getExecuteCalls(), 1);
    assert.equal(auditLines.at(-1) && JSON.parse(auditLines.at(-1) as string).result, 'succeeded');
    assert.doesNotMatch(JSON.stringify(response), /DROP INDEX|redundant/);
  } finally {
    await application.close();
  }
});

test('rejects protected, unsupported, and foreign-key-supporting indexes before execution', async () => {
  const cases: readonly [string, readonly Record<string, unknown>[], readonly Record<string, unknown>[]][] = [
    ['primary', [{ ...primaryIndex, indexName: 'orders_lookup_idx', nonUnique: 0 }], []],
    ['unique-equivalent', [removableIndex, { ...removableIndex, indexName: 'orders_customer_uq', nonUnique: 0 }], []],
    ['descending', [{ ...removableIndex, collation: 'D' }], []],
    [
      'foreign-key-supporting',
      [removableIndex],
      [
        {
          constraintSchemaName: 'app',
          schemaName: 'app',
          tableName: 'orders',
          constraintName: 'orders_customer_fk',
          columnName: 'customer_id',
          ordinalPosition: 1,
          referencedSchemaName: 'app',
          referencedTableName: 'customers',
          referencedColumnName: 'id',
        },
      ],
    ],
    [
      'referenced-parent-index-supporting',
      [removableIndex],
      [
        {
          constraintSchemaName: 'app',
          schemaName: 'app',
          tableName: 'orders_child',
          constraintName: 'orders_child_customer_fk',
          columnName: 'customer_id',
          ordinalPosition: 1,
          referencedSchemaName: 'app',
          referencedTableName: 'orders',
          referencedColumnName: 'customer_id',
        },
      ],
    ],
  ];
  for (const [, statistics, foreignKeys] of cases) {
    const { application, getExecuteCalls } = createDropApplication(statistics, foreignKeys);
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', { name: 'drop_index', arguments: input });
      assert.equal(response.result?.isError, true);
      assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_STRUCTURE_INVALID');
      assert.equal(getExecuteCalls(), 0);
      assert.doesNotMatch(JSON.stringify(response), /DROP INDEX|orders_customer_fk/);
    } finally {
      await application.close();
    }
  }
});

test('classifies a failed post-execution verification as indeterminate without retrying', async () => {
  const { application, getExecuteCalls } = createDropApplication([primaryIndex, removableIndex], [], [primaryIndex, removableIndex]);
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'drop_index', arguments: input });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, {
      result: 'indeterminate',
      code: 'MYSQL_DDL_OUTCOME_UNKNOWN',
      message: 'The DDL outcome is unknown; verify state before retrying.',
      retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
    });
    assert.equal(getExecuteCalls(), 1);
    assert.doesNotMatch(JSON.stringify(response), /DROP INDEX|redundant/);
  } finally {
    await application.close();
  }
});
