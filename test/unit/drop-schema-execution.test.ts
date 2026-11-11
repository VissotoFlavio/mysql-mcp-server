import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { inspectDropSchemaMetadata } from '../../src/db/metadata.js';
import { createConnectionLayer, createDropSchemaStatement } from '../../src/db/pool.js';
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
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<Response>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  await application.server.connect(server);
  await client.start();
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'drop-schema-unit-test', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request };
}

test('drop_schema performs sanitized preflight, canonical execution, verification, and replay protection', async () => {
  let executeCalls = 0;
  let generalQueryCalls = 0;
  let exclusiveQueryCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_SCHEMA_ENABLED: 'true',
      MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated',
    }),
    driver: {
      createPool: () => {
        const respond = async (options: { sql: string }) => {
          if (options.sql.includes('SCHEMATA')) return executeCalls === 0 ? [[{ schemaName: 'isolated' }], []] : [[], []];
          if (options.sql.includes('TABLES'))
            return [
              [{ objectName: 'orders', objectType: 'BASE TABLE', engine: 'InnoDB', creationIdentity: 'table-orders-v1', durableIdentity: '101' }],
              [],
            ];
          return [[], []];
        };
        const exclusiveConnection = {
          async query(options: { sql: string }) {
            exclusiveQueryCalls += 1;
            return respond(options);
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'DROP SCHEMA `isolated`');
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async ping() {},
          release() {},
        };
        return {
          async query(options: { sql: string }) {
            generalQueryCalls += 1;
            return respond(options);
          },
          async getConnection() {
            return exclusiveConnection;
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const listed = (await client.request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'drop_schema'));
    const preflight = await client.request('tools/call', {
      name: 'drop_schema',
      arguments: { schema: 'isolated', reason: 'Remove the retired isolated schema.' },
    });
    const preview = preflight.result?.structuredContent as { confirmation: string; impact: { tables: { names: string[] } } };
    assert.match(preview.confirmation, /^DROP_SCHEMA:[0-9a-f]{64}$/u);
    assert.deepEqual(preview.impact.tables.names, ['orders']);
    const dropped = await client.request('tools/call', {
      name: 'drop_schema',
      arguments: { schema: 'isolated', reason: 'Remove the retired isolated schema.', confirmation: preview.confirmation },
    });
    assert.equal((dropped.result?.structuredContent as { operation: string }).operation, 'drop_schema');
    assert.equal(executeCalls, 1);
    assert.equal(generalQueryCalls, 5);
    assert.equal(exclusiveQueryCalls, 6);
    assert.doesNotMatch(JSON.stringify(dropped), /DROP SCHEMA|retired isolated schema|[a-f0-9]{64}/);
    const replay = await client.request('tools/call', {
      name: 'drop_schema',
      arguments: { schema: 'isolated', reason: 'Remove the retired isolated schema.', confirmation: preview.confirmation },
    });
    assert.equal(replay.result?.isError, true);
    assert.equal((replay.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_METADATA_INVALID');
    assert.equal(executeCalls, 1);
  } finally {
    await application.close();
  }
});

test('drop_schema rejects a non-allowlisted schema before touching the driver', async () => {
  let queryCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_SCHEMA_ENABLED: 'true', MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated' }),
    driver: {
      createPool: () =>
        ({
          async query() {
            queryCalls += 1;
            return [[], []];
          },
          async end() {},
        }) as never,
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', {
      name: 'drop_schema',
      arguments: { schema: 'other', reason: 'Must be rejected by policy.' },
    });
    assert.equal(response.result?.isError, true);
    assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_SCHEMA_NOT_ALLOWED');
    assert.equal(queryCalls, 0);
  } finally {
    await application.close();
  }
});

test('the executable DDL boundary rejects forged confirmations before driver access', async () => {
  let queryCalls = 0;
  let executeCalls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({
      MYSQL_DDL_ENABLED: 'true',
      MYSQL_DDL_DROP_SCHEMA_ENABLED: 'true',
      MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated',
    }),
    driver: {
      createPool: () =>
        ({
          async query() {
            queryCalls += 1;
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
  const statement = createDropSchemaStatement({
    schema: 'isolated',
    reason: 'Remove the isolated schema.',
    confirmation: `DROP_SCHEMA:${'a'.repeat(64)}`,
  });

  await assert.rejects(
    layer.ddl.executeDropSchemaWithOperationId(statement),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
  assert.equal(queryCalls, 0);
  assert.equal(executeCalls, 0);
  await layer.close();
});

test('schema confirmations stay scoped to one connection layer before execution', async () => {
  let executeCalls = 0;
  const environment = validEnvironment({
    MYSQL_DDL_ENABLED: 'true',
    MYSQL_DDL_DROP_SCHEMA_ENABLED: 'true',
    MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated',
  });
  const createDriver = () => {
    let dropped = false;
    return {
      async query(options: { sql: string }) {
        if (options.sql.includes('SCHEMATA')) return dropped ? [[], []] : [[{ schemaName: 'isolated' }], []];
        if (options.sql.includes('TABLES'))
          return [
            [{ objectName: 'orders', objectType: 'BASE TABLE', engine: 'InnoDB', creationIdentity: 'table-orders-v1', durableIdentity: '101' }],
            [],
          ];
        return [[], []];
      },
      async execute() {
        executeCalls += 1;
        dropped = true;
        return [{ affectedRows: 0, warningStatus: 0 }, []];
      },
      async end() {},
    } as never;
  };
  const layerA = createConnectionLayer({ environment, driver: { createPool: createDriver } });
  const layerB = createConnectionLayer({ environment, driver: { createPool: createDriver } });
  try {
    const preview = await inspectDropSchemaMetadata(layerA, 'isolated');
    const statement = createDropSchemaStatement({
      schema: 'isolated',
      reason: 'Remove the isolated schema.',
      confirmation: preview.confirmation,
    });

    await assert.rejects(
      layerB.ddl.executeDropSchemaWithOperationId(statement),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MYSQL_DDL_METADATA_INVALID',
    );
    assert.equal(executeCalls, 0);

    await assert.doesNotReject(layerA.ddl.executeDropSchemaWithOperationId(statement));
    assert.equal(executeCalls, 1);
  } finally {
    await layerA.close();
    await layerB.close();
  }
});
