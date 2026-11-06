import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableAddForeignKeyMetadataError, validateAlterTableAddForeignKeyMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

const input = {
  schema: 'app',
  table: 'orders',
  constraint: 'orders_customer_fk',
  columns: ['customer_id'],
  referencedTable: 'customers',
  referencedColumns: ['id'],
};
const table = (tableName: string) => ({ schemaName: 'app', tableName, tableType: 'BASE TABLE', engine: 'InnoDB' });
const column = (columnName: string, overrides: Record<string, unknown> = {}) => ({
  columnName,
  ordinalPosition: 1,
  columnType: 'BIGINT UNSIGNED',
  characterSetName: null,
  collationName: null,
  extra: '',
  ...overrides,
});
const index = (columnName: string, nonUnique = 1) => ({
  indexName: 'required_idx',
  nonUnique,
  sequenceInIndex: 1,
  collation: 'A',
  columnName,
  subPart: null,
  expression: null,
  indexType: 'BTREE',
});
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
async function codeOf(callback: () => Promise<unknown>): Promise<string> {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof AlterTableAddForeignKeyMetadataError);
    return error.code;
  }
  throw new Error('Expected metadata validation failure.');
}

test('accepts compatible InnoDB base tables, ordered index prefixes, and no orphan data', async () => {
  await validateAlterTableAddForeignKeyMetadata(
    layer([
      [table('orders')],
      [table('customers')],
      [column('customer_id')],
      [column('id')],
      [index('customer_id')],
      [index('id', 0)],
      [],
      [{ orphanExists: 0 }],
    ]),
    input,
  );
});
test('rejects non-InnoDB tables, missing required index, conflicting constraint, and orphan data without exposing rows', async () => {
  assert.equal(
    await codeOf(() =>
      validateAlterTableAddForeignKeyMetadata(
        layer([
          [{ ...table('orders'), engine: 'MyISAM' }],
          [table('customers')],
          [column('customer_id')],
          [column('id')],
          [index('customer_id')],
          [index('id', 0)],
          [],
          [{ orphanExists: 0 }],
        ]),
        input,
      ),
    ),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(
    await codeOf(() =>
      validateAlterTableAddForeignKeyMetadata(
        layer([[table('orders')], [table('customers')], [column('customer_id')], [column('id')], [], [index('id', 0)], [], [{ orphanExists: 0 }]]),
        input,
      ),
    ),
    'MYSQL_DDL_COLUMN_INVALID',
  );
  assert.equal(
    await codeOf(() =>
      validateAlterTableAddForeignKeyMetadata(
        layer([
          [table('orders')],
          [table('customers')],
          [column('customer_id')],
          [column('id')],
          [index('customer_id')],
          [index('id', 0)],
          [{ schemaName: 'app', tableName: 'orders', constraintName: 'orders_customer_fk', constraintType: 'FOREIGN KEY' }],
          [{ orphanExists: 0 }],
        ]),
        input,
      ),
    ),
    'MYSQL_DDL_FOREIGN_KEY_EXISTS',
  );
  assert.equal(
    await codeOf(() =>
      validateAlterTableAddForeignKeyMetadata(
        layer([
          [table('orders')],
          [table('customers')],
          [column('customer_id')],
          [column('id')],
          [index('customer_id')],
          [index('id', 0)],
          [],
          [{ orphanExists: 1, customer_id: 'must-not-leak' }],
        ]),
        input,
      ),
    ),
    'MYSQL_DDL_FOREIGN_KEY_ORPHANS',
  );
});

test('accepts character columns with different lengths but rejects charset or collation mismatch', async () => {
  const compatible = [
    [table('orders')],
    [table('customers')],
    [column('customer_code', { columnType: 'varchar(32)', characterSetName: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' })],
    [column('code', { columnType: 'varchar(255)', characterSetName: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' })],
    [index('customer_code')],
    [index('code', 0)],
    [],
    [{ orphanExists: 0 }],
  ];
  await validateAlterTableAddForeignKeyMetadata(layer(compatible), { ...input, columns: ['customer_code'], referencedColumns: ['code'] });
  for (const parentColumn of [
    column('code', { columnType: 'varchar(255)', characterSetName: 'latin1', collationName: 'latin1_swedish_ci' }),
    column('code', { columnType: 'varchar(255)', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' }),
  ]) {
    assert.equal(
      await codeOf(() =>
        validateAlterTableAddForeignKeyMetadata(
          layer([
            [table('orders')],
            [table('customers')],
            [compatible[2]![0]],
            [parentColumn],
            [index('customer_code')],
            [index('code', 0)],
            [],
            [{ orphanExists: 0 }],
          ]),
          { ...input, columns: ['customer_code'], referencedColumns: ['code'] },
        ),
      ),
      'MYSQL_DDL_COLUMN_INVALID',
    );
  }
});
