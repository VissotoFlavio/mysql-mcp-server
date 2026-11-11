import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import mysql from 'mysql2/promise';

import { loadConnectionConfig } from '../../src/config.js';
import { createMcpApplication } from '../../src/server.js';

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}

const targetSchema = process.env.MYSQL_DDL_DROP_SCHEMA_INTEGRATION_SCHEMA;

function isDisposableSchema(value: unknown): value is string {
  return typeof value === 'string' && /^mcp_ddl_test_[A-Za-z0-9_]{1,50}$/u.test(value) && value.length <= 64;
}

const targetIsDisposable = isDisposableSchema(targetSchema);
const targetIsExactlyAllowlisted = targetIsDisposable && process.env.MYSQL_DDL_DROP_SCHEMA_ALLOWLIST === targetSchema;
const targetDiffersFromDatabase =
  targetIsDisposable && typeof process.env.MYSQL_DATABASE === 'string' && targetSchema.toLowerCase() !== process.env.MYSQL_DATABASE.toLowerCase();
const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_DROP_SCHEMA_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DDL_DROP_SCHEMA_ENABLED === 'true' &&
  process.env.MYSQL_DDL_DROP_SCHEMA_INTEGRATION_CONFIRM === 'isolated-schema-create-drop' &&
  targetIsDisposable &&
  targetIsExactlyAllowlisted &&
  targetDiffersFromDatabase;

test('runs the guarded drop_schema lifecycle only for one disposable allowlisted schema', { skip: !enabled }, async () => {
  assert.equal(isDisposableSchema(targetSchema), true);
  if (!isDisposableSchema(targetSchema)) throw new Error('Required disposable schema is unavailable.');
  const config = loadConnectionConfig();
  assert.notEqual(targetSchema.toLowerCase(), config.database.toLowerCase(), 'the target schema must be distinct from MYSQL_DATABASE');
  assert.deepEqual(config.dropSchemaAllowlist, [targetSchema]);

  let created = false;
  let application: ReturnType<typeof createMcpApplication> | undefined;
  try {
    const setup = await mysql.createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.tls ? { ...config.tls } : undefined,
    });
    try {
      const [existing] = await setup.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 2', [targetSchema]);
      assert.deepEqual(existing, []);
      await setup.query(`CREATE SCHEMA \`${targetSchema.replaceAll('`', '``')}\``);
      created = true;
      await setup.query(`CREATE TABLE \`${targetSchema.replaceAll('`', '``')}\`.\`drop_schema_probe\` (\`id\` INT NOT NULL PRIMARY KEY)`);
    } finally {
      await setup.end();
    }

    application = createMcpApplication();
    const [client, server] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (response: JsonRpcResponse) => void>();
    let requestId = 0;
    client.onmessage = (message) => {
      if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
        pending.get(message.id)?.(message as JsonRpcResponse);
        pending.delete(message.id);
      }
    };
    const request = async (method: string, params: Record<string, unknown>) => {
      const id = ++requestId;
      const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
      await client.send({ jsonrpc: '2.0', id, method, params } as never);
      return response;
    };

    await application.server.connect(server);
    await client.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'drop-schema-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
    const listed = (await request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'drop_schema'));
    const preflight = await request('tools/call', {
      name: 'drop_schema',
      arguments: { schema: targetSchema, reason: 'Remove the disposable schema after lifecycle validation.' },
    });
    const preview = preflight.result?.structuredContent as {
      confirmation: string;
      impact: {
        tables: { count: number; names: string[] };
        views: { count: number; names: string[] };
        otherObjects: { count: number; names: string[] };
      };
    };
    assert.match(preview.confirmation, /^DROP_SCHEMA:[0-9a-f]{64}$/u);
    assert.deepEqual(preview.impact.tables, { count: 1, names: ['drop_schema_probe'] });
    assert.deepEqual(preview.impact.views, { count: 0, names: [] });
    assert.deepEqual(preview.impact.otherObjects, { count: 0, names: [] });
    const dropped = await request('tools/call', {
      name: 'drop_schema',
      arguments: { schema: targetSchema, reason: 'Remove the disposable schema after lifecycle validation.', confirmation: preview.confirmation },
    });
    assert.equal((dropped.result?.structuredContent as { operation: string }).operation, 'drop_schema');
    const verification = await mysql.createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.tls ? { ...config.tls } : undefined,
    });
    try {
      const [absent] = await verification.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 2', [targetSchema]);
      assert.deepEqual(absent, []);
      created = false;
    } finally {
      await verification.end();
    }
  } finally {
    await application?.close();
    if (created) {
      const cleanup = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.tls ? { ...config.tls } : undefined,
      });
      try {
        await cleanup.query(`DROP SCHEMA \`${targetSchema.replaceAll('`', '``')}\``);
      } finally {
        await cleanup.end();
      }
    }
  }
});
