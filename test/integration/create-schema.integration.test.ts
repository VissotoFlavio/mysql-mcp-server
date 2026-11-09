import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { RowDataPacket } from 'mysql2';
import mysql from 'mysql2/promise';

import { loadConnectionConfig } from '../../src/config.js';
import { createMcpApplication } from '../../src/server.js';

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_CREATE_SCHEMA_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DDL_CREATE_SCHEMA_ENABLED === 'true' &&
  process.env.MYSQL_DDL_CREATE_SCHEMA_INTEGRATION_CONFIRM === 'isolated-schema-create-drop';
const contextSchema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const requestedName = process.env.MYSQL_DDL_INTEGRATION_TABLE;
const targetSchema = requestedName === undefined ? undefined : `${requestedName}_schema`;
const MAX_MYSQL_IDENTIFIER_LENGTH = 64;

function isValidCreateSchemaIntegrationTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MYSQL_IDENTIFIER_LENGTH && /^mcp_ddl_test_[A-Za-z0-9_]{1,44}_schema$/.test(value);
}

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}

test('keeps the derived create_schema integration target within MySQL identifier limits', () => {
  const maximum = `mcp_ddl_test_${'a'.repeat(44)}_schema`;
  assert.equal(maximum.length, MAX_MYSQL_IDENTIFIER_LENGTH);
  assert.equal(isValidCreateSchemaIntegrationTarget(maximum), true);
  assert.equal(isValidCreateSchemaIntegrationTarget(`mcp_ddl_test_${'a'.repeat(45)}_schema`), false);
});

test('runs the opt-in CREATE SCHEMA contract only for one isolated mcp_ddl_test_ target', { skip: !enabled }, async () => {
  assert.equal(isValidCreateSchemaIntegrationTarget(targetSchema), true);
  assert.match(contextSchema ?? '', /^[A-Za-z0-9_]{1,64}$/);
  if (targetSchema === undefined || contextSchema === undefined) throw new Error('Required integration names are unavailable.');
  const connectionConfig = loadConnectionConfig();
  assert.notEqual(targetSchema, connectionConfig.database, 'the target schema must be distinct from MYSQL_DATABASE');
  assert.notEqual(targetSchema, contextSchema, 'the target schema must be distinct from the configured connection context');
  const preflight = await mysql.createConnection({
    host: connectionConfig.host,
    port: connectionConfig.port,
    database: contextSchema,
    user: connectionConfig.user,
    password: connectionConfig.password,
    ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
  });
  try {
    const [existing] = await preflight.query<(RowDataPacket & { SCHEMA_NAME: string })[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 2',
      [targetSchema],
    );
    assert.deepEqual(existing, []);
  } finally {
    await preflight.end();
  }

  const application = createMcpApplication();
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  let schemaCreated = false;
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

  try {
    await application.server.connect(server);
    await client.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'create-schema-integration', version: '1' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
    const listed = (await request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.ok(listed.some(({ name }) => name === 'create_schema'));
    const response = await request('tools/call', {
      name: 'create_schema',
      arguments: { schema: targetSchema, charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', reason: 'Create isolated integration catalog.' },
    });
    assert.equal(response.result?.isError, undefined);
    const result = response.result?.structuredContent as { operation?: string; target?: { schema?: string } };
    assert.equal(result.operation, 'create_schema');
    assert.equal(result.target?.schema, targetSchema);
    schemaCreated = true;
  } finally {
    try {
      await application.close();
    } finally {
      if (schemaCreated && isValidCreateSchemaIntegrationTarget(targetSchema)) {
        const cleanup = await mysql.createConnection({
          host: connectionConfig.host,
          port: connectionConfig.port,
          database: contextSchema,
          user: connectionConfig.user,
          password: connectionConfig.password,
          ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
        });
        try {
          await cleanup.query(`DROP DATABASE \`${targetSchema.replaceAll('`', '``')}\``);
        } finally {
          await cleanup.end();
        }
      }
    }
  }
});
