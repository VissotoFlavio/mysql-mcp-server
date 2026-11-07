import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { RowDataPacket } from 'mysql2';
import mysql from 'mysql2/promise';

import { loadConnectionConfig } from '../../src/config.js';
import { createMcpApplication } from '../../src/server.js';

const enabled =
  process.env.MYSQL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_TEST === 'true' &&
  process.env.MYSQL_DDL_ENABLED === 'true' &&
  process.env.MYSQL_DML_ENABLED === 'true' &&
  process.env.MYSQL_DDL_INTEGRATION_CONFIRM === 'isolated-database-schema';
const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
const table = process.env.MYSQL_DDL_INTEGRATION_TABLE;
const parentTable = table === undefined ? undefined : `${table}_parent`;

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
}

interface IndexRow extends RowDataPacket {
  readonly INDEX_NAME: string;
  readonly COLUMN_NAME: string;
  readonly NON_UNIQUE: number;
}

interface ForeignKeyRow extends RowDataPacket {
  readonly CONSTRAINT_NAME: string;
  readonly COLUMN_NAME: string;
  readonly REFERENCED_TABLE_NAME: string;
  readonly REFERENCED_COLUMN_NAME: string;
  readonly UPDATE_RULE: string;
  readonly DELETE_RULE: string;
}

interface ColumnTypeRow extends RowDataPacket {
  readonly COLUMN_TYPE: string;
}

test('runs the opt-in CREATE TABLE contract against an explicitly isolated schema', { skip: !enabled }, async () => {
  assert.match(table ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,50}$/);
  assert.match(parentTable ?? '', /^mcp_ddl_test_[A-Za-z0-9_]{1,57}$/);
  assert.match(schema ?? '', /^[A-Za-z0-9_]{1,64}$/);

  const connectionConfig = loadConnectionConfig();
  const application = createMcpApplication();
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  let createRequested = false;
  let parentCreateRequested = false;
  let applicationClosed = false;
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
      clientInfo: { name: 'ddl-integration', version: '1.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

    const existingResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    assert.equal(existingResponse.result?.isError, true, 'the temporary test table must not already exist');
    const existingParentResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table: parentTable } });
    assert.equal(existingParentResponse.result?.isError, true, 'the temporary parent table must not already exist');

    parentCreateRequested = true;
    const createdParentResponse = await request('tools/call', {
      name: 'create_table',
      arguments: {
        schema,
        table: parentTable,
        columns: [{ name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false }],
        primaryKey: ['id'],
        reason: 'Create the isolated foreign-key parent table',
      },
    });
    assert.equal((createdParentResponse.result?.structuredContent as { operation: string }).operation, 'create_table');

    createRequested = true;
    const createdResponse = await request('tools/call', {
      name: 'create_table',
      arguments: {
        schema,
        table,
        columns: [
          { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
          { name: 'label', type: { kind: 'varchar', length: 100 }, nullable: false },
          { name: 'parent_id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: true },
          { name: 'unique_value', type: { kind: 'varchar', length: 255 }, nullable: false },
          { name: 'duplicate_value', type: { kind: 'varchar', length: 255 }, nullable: false },
        ],
        primaryKey: ['id'],
        reason: 'Run the isolated CREATE TABLE integration contract',
      },
    });
    const createResult = createdResponse.result?.structuredContent as { operation: string; target: { schema: string; table: string } };
    assert.equal(createResult.operation, 'create_table');
    assert.deepEqual(createResult.target, { schema, table });

    const describedResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const described = describedResponse.result?.structuredContent as { table: { schemaName: string; tableName: string; tableType: string } };
    assert.deepEqual(described.table, { schemaName: schema, tableName: table, tableType: 'BASE TABLE' });

    const foreignKeyWithoutIndexResponse = await request('tools/call', {
      name: 'alter_table_add_foreign_key',
      arguments: {
        schema,
        table,
        constraint: 'mcp_ddl_test_parent_fk',
        columns: ['parent_id'],
        referencedTable: parentTable,
        referencedColumns: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'NO ACTION',
        reason: 'Verify the isolated foreign-key index precondition',
      },
    });
    assert.equal(foreignKeyWithoutIndexResponse.result?.isError, true);
    assert.equal((foreignKeyWithoutIndexResponse.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_STRUCTURE_INVALID');

    const indexResponse = await request('tools/call', {
      name: 'create_index',
      arguments: { schema, table, index: 'mcp_ddl_test_label_idx', columns: ['label'], reason: 'Run the isolated CREATE INDEX integration contract' },
    });
    const indexResult = indexResponse.result?.structuredContent as { operation: string; target: { schema: string; table: string; index: string } };
    assert.equal(indexResult.operation, 'create_index');
    assert.deepEqual(indexResult.target, { schema, table, index: 'mcp_ddl_test_label_idx' });

    const foreignKeyIndexResponse = await request('tools/call', {
      name: 'create_index',
      arguments: {
        schema,
        table,
        index: 'mcp_ddl_test_parent_id_idx',
        columns: ['parent_id'],
        reason: 'Create the isolated foreign-key supporting index',
      },
    });
    assert.equal((foreignKeyIndexResponse.result?.structuredContent as { operation: string }).operation, 'create_index');

    const insertResponse = await request('tools/call', {
      name: 'insert_rows',
      arguments: {
        schema,
        table,
        rows: [
          { label: 'unique-index-row-1', unique_value: 'unique-1', duplicate_value: 'duplicate' },
          { label: 'unique-index-row-2', unique_value: 'unique-2', duplicate_value: 'duplicate' },
        ],
        reason: 'Seed isolated unique-index integration rows',
      },
    });
    assert.equal((insertResponse.result?.structuredContent as { operation: string }).operation, 'insert');

    const uniqueIndexResponse = await request('tools/call', {
      name: 'create_unique_index',
      arguments: {
        schema,
        table,
        index: 'mcp_ddl_test_unique_value_uq',
        columns: ['unique_value'],
        reason: 'Run the isolated CREATE UNIQUE INDEX success contract',
      },
    });
    const uniqueIndexResult = uniqueIndexResponse.result?.structuredContent as {
      operation: string;
      target: { schema: string; table: string; index: string };
    };
    assert.equal(uniqueIndexResult.operation, 'create_unique_index');
    assert.deepEqual(uniqueIndexResult.target, { schema, table, index: 'mcp_ddl_test_unique_value_uq' });

    const duplicateUniqueIndexResponse = await request('tools/call', {
      name: 'create_unique_index',
      arguments: {
        schema,
        table,
        index: 'mcp_ddl_test_duplicate_value_uq',
        columns: ['duplicate_value'],
        reason: 'Run the isolated CREATE UNIQUE INDEX duplicate contract',
      },
    });
    assert.equal(duplicateUniqueIndexResponse.result?.isError, true);
    assert.equal((duplicateUniqueIndexResponse.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_DUPLICATE_DATA');

    const addColumnResponse = await request('tools/call', {
      name: 'alter_table_add_column',
      arguments: {
        schema,
        table,
        column: { name: 'note', type: { kind: 'varchar', length: 100 }, nullable: true },
        reason: 'Run the isolated ALTER TABLE ADD COLUMN integration contract',
      },
    });
    const addColumnResult = addColumnResponse.result?.structuredContent as {
      operation: string;
      target: { schema: string; table: string; column: string };
    };
    assert.equal(addColumnResult.operation, 'alter_table_add_column');
    assert.deepEqual(addColumnResult.target, { schema, table, column: 'note' });

    const afterAlterResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const afterAlter = afterAlterResponse.result?.structuredContent as {
      columns: readonly { columnName: string; dataType: string; isNullable: boolean }[];
    };
    assert.ok(afterAlter.columns.some((column) => column.columnName === 'note' && column.dataType === 'varchar' && column.isNullable));

    const modifyColumnResponse = await request('tools/call', {
      name: 'alter_table_modify_column',
      arguments: {
        schema,
        table,
        column: 'label',
        definition: { name: 'label', type: { kind: 'varchar', length: 255 }, nullable: false },
        reason: 'Widen the isolated label column without changing nullability',
      },
    });
    const modifyColumnResult = modifyColumnResponse.result?.structuredContent as {
      operation: string;
      target: { schema: string; table: string; column: string };
    };
    assert.equal(modifyColumnResult.operation, 'alter_table_modify_column');
    assert.deepEqual(modifyColumnResult.target, { schema, table, column: 'label' });
    const afterModifyResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const afterModify = afterModifyResponse.result?.structuredContent as {
      columns: readonly { columnName: string; dataType: string; isNullable: boolean }[];
    };
    assert.ok(afterModify.columns.some((column) => column.columnName === 'label' && column.dataType === 'varchar' && !column.isNullable));

    const foreignKeyResponse = await request('tools/call', {
      name: 'alter_table_add_foreign_key',
      arguments: {
        schema,
        table,
        constraint: 'mcp_ddl_test_parent_fk',
        columns: ['parent_id'],
        referencedTable: parentTable,
        referencedColumns: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'NO ACTION',
        reason: 'Create the isolated parent relationship',
      },
    });
    const foreignKeyResult = foreignKeyResponse.result?.structuredContent as {
      operation: string;
      target: { schema: string; table: string; constraint: string };
    };
    assert.equal(foreignKeyResult.operation, 'alter_table_add_foreign_key');
    assert.deepEqual(foreignKeyResult.target, { schema, table, constraint: 'mcp_ddl_test_parent_fk' });

    const renameColumnResponse = await request('tools/call', {
      name: 'alter_table_rename_column',
      arguments: {
        schema,
        table,
        column: 'note',
        newColumn: 'renamed_note',
        reason: 'Run the isolated ALTER TABLE RENAME COLUMN integration contract',
      },
    });
    const renameColumnResult = renameColumnResponse.result?.structuredContent as {
      operation: string;
      target: { schema: string; table: string; column: string; newColumn: string };
    };
    assert.equal(renameColumnResult.operation, 'alter_table_rename_column');
    assert.deepEqual(renameColumnResult.target, { schema, table, column: 'note', newColumn: 'renamed_note' });
    const afterRenameResponse = await request('tools/call', { name: 'describe_table', arguments: { schema, table } });
    const afterRename = afterRenameResponse.result?.structuredContent as {
      columns: readonly { columnName: string; dataType: string; isNullable: boolean }[];
    };
    assert.ok(afterRename.columns.some((column) => column.columnName === 'renamed_note' && column.dataType === 'varchar' && column.isNullable));
    assert.ok(!afterRename.columns.some((column) => column.columnName === 'note'));

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
      const [indexes] = await verificationConnection.query<IndexRow[]>(
        'SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME IN (?, ?) ORDER BY INDEX_NAME',
        [schema, table, 'mcp_ddl_test_label_idx', 'mcp_ddl_test_unique_value_uq'],
      );
      assert.deepEqual(indexes, [
        { INDEX_NAME: 'mcp_ddl_test_label_idx', COLUMN_NAME: 'label', NON_UNIQUE: 1 },
        { INDEX_NAME: 'mcp_ddl_test_unique_value_uq', COLUMN_NAME: 'unique_value', NON_UNIQUE: 0 },
      ]);
      const [foreignKeys] = await verificationConnection.query<ForeignKeyRow[]>(
        `SELECT key_columns.CONSTRAINT_NAME, key_columns.COLUMN_NAME, key_columns.REFERENCED_TABLE_NAME,
                key_columns.REFERENCED_COLUMN_NAME, constraints.UPDATE_RULE, constraints.DELETE_RULE
           FROM information_schema.KEY_COLUMN_USAGE AS key_columns
           INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS AS constraints
             ON constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
            AND constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
          WHERE key_columns.CONSTRAINT_SCHEMA = ?
            AND key_columns.TABLE_NAME = ?
            AND key_columns.CONSTRAINT_NAME = ?
          ORDER BY key_columns.ORDINAL_POSITION ASC`,
        [schema, table, 'mcp_ddl_test_parent_fk'],
      );
      assert.deepEqual(foreignKeys, [
        {
          CONSTRAINT_NAME: 'mcp_ddl_test_parent_fk',
          COLUMN_NAME: 'parent_id',
          REFERENCED_TABLE_NAME: parentTable,
          REFERENCED_COLUMN_NAME: 'id',
          UPDATE_RULE: 'NO ACTION',
          DELETE_RULE: 'RESTRICT',
        },
      ]);
      const [columnTypes] = await verificationConnection.query<ColumnTypeRow[]>(
        'SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [schema, table, 'label'],
      );
      assert.deepEqual(columnTypes, [{ COLUMN_TYPE: 'varchar(255)' }]);
    } finally {
      await verificationConnection.end();
    }
  } finally {
    try {
      if (!applicationClosed) await application.close();
    } finally {
      const cleanupConnection = await mysql.createConnection({
        host: connectionConfig.host,
        port: connectionConfig.port,
        database: schema,
        user: connectionConfig.user,
        password: connectionConfig.password,
        ssl: connectionConfig.tls ? { ...connectionConfig.tls } : undefined,
      });
      try {
        if (createRequested) await cleanupConnection.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``);
        if (parentCreateRequested) await cleanupConnection.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${parentTable}\``);
      } finally {
        await cleanupConnection.end();
      }
    }
  }
});
