import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableDropForeignKeyMetadataError, validateAlterTableDropForeignKeyMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

const input = { schema: 'app', table: 'orders', constraint: 'orders_customer_fk', reason: 'Remove the obsolete relationship.' };
function layer(responses: readonly unknown[]): ConnectionLayer {
  let index = 0;
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query() {
      return [responses[index++], []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}
async function codeOf(responses: readonly unknown[]): Promise<string> {
  try {
    await validateAlterTableDropForeignKeyMetadata(layer(responses), input);
  } catch (error) {
    assert(error instanceof AlterTableDropForeignKeyMetadataError);
    return error.code;
  }
  throw new Error('Expected metadata validation failure.');
}

test('accepts the named foreign key on the requested base table', async () => {
  await validateAlterTableDropForeignKeyMetadata(
    layer([
      [{ schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' }],
      [{ schemaName: 'app', tableSchemaName: 'app', tableName: 'orders', constraintName: 'orders_customer_fk', constraintType: 'FOREIGN KEY' }],
    ]),
    input,
  );
});

test('rejects views, missing constraints, and non-foreign-key constraints before execution', async () => {
  assert.equal(await codeOf([[{ schemaName: 'app', tableName: 'orders', tableType: 'VIEW' }], []]), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(await codeOf([[{ schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' }], []]), 'MYSQL_DDL_STRUCTURE_INVALID');
  assert.equal(
    await codeOf([
      [{ schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' }],
      [{ schemaName: 'app', tableSchemaName: 'app', tableName: 'orders', constraintName: 'orders_customer_fk', constraintType: 'UNIQUE' }],
    ]),
    'MYSQL_DDL_STRUCTURE_INVALID',
  );
});
