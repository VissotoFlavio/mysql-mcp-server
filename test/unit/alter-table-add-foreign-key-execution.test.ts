import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}
const input = {
  schema: 'app',
  table: 'orders',
  constraint: 'orders_customer_fk',
  columns: ['customer_id'],
  referencedTable: 'customers',
  referencedColumns: ['id'],
  onDelete: 'RESTRICT',
  onUpdate: 'NO ACTION',
  reason: 'Keep orders associated with customers.',
};
async function connect(application: ReturnType<typeof createMcpApplication>) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  let id = 0;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as JsonRpcResponse);
      pending.delete(message.id);
    }
  };
  await application.server.connect(server);
  await client.start();
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(++id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'foreign-key-test', version: '1.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request, close: () => application.close() };
}
function table(tableName: string) {
  return { schemaName: 'app', tableName, tableType: 'BASE TABLE', engine: 'InnoDB' };
}
function column(columnName: string) {
  return { columnName, ordinalPosition: 1, columnType: 'BIGINT UNSIGNED', characterSetName: null, collationName: null, extra: '' };
}
function index(columnName: string, nonUnique = 1) {
  return {
    indexName: 'required_idx',
    nonUnique,
    sequenceInIndex: 1,
    collation: 'A',
    columnName,
    subPart: null,
    expression: null,
    indexType: 'BTREE',
  };
}

test('runs foreign-key DDL once only after its complete metadata preflight', async () => {
  let queryIndex = 0;
  let executed: unknown;
  const responses = [
    [table('orders')],
    [table('customers')],
    [column('customer_id')],
    [column('id')],
    [index('customer_id')],
    [index('id', 0)],
    [],
    [{ orphanExists: 0 }],
  ];
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [responses[queryIndex++], []];
          },
          async execute(options: unknown) {
            executed = options;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'alter_table_add_foreign_key', arguments: input });
    assert.equal(response.result?.isError, undefined);
    assert.equal(queryIndex, 8);
    assert.deepEqual(executed, {
      sql: 'ALTER TABLE `app`.`orders` ADD CONSTRAINT `orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `app`.`customers` (`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
      timeout: 30_000,
    });
    const result = JSON.parse((response.result?.content as readonly { text: string }[])[0]!.text) as Record<string, unknown>;
    assert.deepEqual(result.target, { schema: 'app', table: 'orders', constraint: 'orders_customer_fk' });
  } finally {
    await client.close();
  }
});

test('rejects a non-unique referenced index before DDL execution', async () => {
  let executions = 0;
  const responses = [
    [table('orders')],
    [table('customers')],
    [column('customer_id')],
    [column('id')],
    [index('customer_id')],
    [index('id')],
    [],
    [{ orphanExists: 0 }],
  ];
  let queryIndex = 0;
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
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'alter_table_add_foreign_key', arguments: input });
    assert.equal(response.result?.isError, true);
    assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_STRUCTURE_INVALID');
    assert.equal(executions, 0);
    assert.equal(queryIndex, 7);
  } finally {
    await client.close();
  }
});

test('rejects invalid foreign-key input before accessing the driver', async () => {
  let queries = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            queries += 1;
            return [[], []];
          },
          async execute() {
            throw new Error('must not execute');
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'alter_table_add_foreign_key', arguments: { ...input, onDelete: 'CASCADE' } });
    assert.equal(response.result?.isError, true);
    assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_INVALID_ARGUMENT');
    assert.equal(queries, 0);
  } finally {
    await client.close();
  }
});
