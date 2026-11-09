import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { RowDataPacket } from 'mysql2';
import mysql from 'mysql2/promise';

import { loadConnectionConfig } from '../../src/config.js';
import { createMcpApplication } from '../../src/server.js';

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}
interface RowCountRow extends RowDataPacket {
  readonly rowCount: number;
}
interface IdRow extends RowDataPacket {
  readonly id: number;
}

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DML_ENABLED === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DDL_TRUNCATE_TABLE_ENABLED === 'true' &&
  process.env.MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_CONFIRM === 'isolated-database-schema' &&
  typeof process.env.MYSQL_DDL_TRUNCATE_TABLE_INTEGRATION_TABLE === 'string';
const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const table = process.env.MYSQL_DDL_TRUNCATE_TABLE_INTEGRATION_TABLE;

test('runs the controlled truncate_table contract against one isolated temporary table', { skip: !enabled }, async () => {
  assert.match(table ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,50}$/);
  assert.match(schema ?? '', /^[A-Za-z0-9_]{1,64}$/);

  const connectionConfig = loadConnectionConfig();
  const application = createMcpApplication();
  let applicationClosed = false;
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  let tableCreated = false;
  let tableTruncated = false;
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
      clientInfo: { name: 'truncate-table-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

    const existing = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    assert.equal(existing.result?.isError, true, 'the isolated truncate_table target must not already exist');

    const created = await request('tools/call', {
      name: 'create_table',
      arguments: {
        schema,
        table,
        columns: [
          { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
          { name: 'label', type: { kind: 'varchar', length: 100 }, nullable: false },
        ],
        primaryKey: ['id'],
        reason: 'Create one isolated truncate_table integration target',
      },
    });
    assert.equal((created.result?.structuredContent as { operation: string }).operation, 'create_table');
    tableCreated = true;

    const inserted = await request('tools/call', {
      name: 'insert_rows',
      arguments: {
        schema,
        table,
        rows: [{ label: 'truncate-me' }],
        reason: 'Seed one isolated truncate_table integration row',
      },
    });
    assert.equal((inserted.result?.structuredContent as { operation: string }).operation, 'insert');

    const described = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const metadataRevision = (described.result?.structuredContent as { metadataRevision: string }).metadataRevision;
    const truncated = await request('tools/call', {
      name: 'truncate_table',
      arguments: {
        schema,
        table,
        reason: 'Clear the isolated truncate_table integration rows',
        confirmation: `TRUNCATE_TABLE:${metadataRevision}`,
      },
    });
    assert.equal((truncated.result?.structuredContent as { operation: string }).operation, 'truncate_table');
    tableTruncated = true;

    await application.close();
    applicationClosed = true;

    const verificationConnection = await mysql.createConnection({
      host: connectionConfig.host,
      port: connectionConfig.port,
      database: schema,
      user: connectionConfig.user,
      password: connectionConfig.password,
      ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
    });
    try {
      const [rows] = await verificationConnection.query<RowCountRow[]>(`SELECT COUNT(*) AS rowCount FROM \`${schema}\`.\`${table}\``);
      assert.deepEqual(rows, [{ rowCount: 0 }]);
      await verificationConnection.query(`INSERT INTO \`${schema}\`.\`${table}\` (label) VALUES (?)`, ['auto-increment-check']);
      const [ids] = await verificationConnection.query<IdRow[]>(`SELECT id FROM \`${schema}\`.\`${table}\` LIMIT 1`);
      assert.deepEqual(ids, [{ id: 1 }]);
    } finally {
      await verificationConnection.end();
    }
  } finally {
    if (!applicationClosed) await application.close();
    const cleanupConnection = await mysql.createConnection({
      host: connectionConfig.host,
      port: connectionConfig.port,
      database: schema,
      user: connectionConfig.user,
      password: connectionConfig.password,
      ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
    });
    try {
      if (tableCreated && tableTruncated) await cleanupConnection.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``);
      else if (tableCreated) await cleanupConnection.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``);
    } finally {
      await cleanupConnection.end();
    }
  }
});
