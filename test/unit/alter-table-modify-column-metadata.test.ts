import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableModifyColumnMetadataError, validateAlterTableModifyColumnMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';
import type { AlterTableModifyColumnInput } from '../../src/tools/alter-table-modify-column-input.js';

const input: AlterTableModifyColumnInput = {
  schema: 'app',
  table: 'accounts',
  column: 'account_id',
  definition: { name: 'account_id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false },
  reason: 'Widen the account identifier.',
};

function column(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaName: 'app',
    tableName: 'accounts',
    tableType: 'BASE TABLE',
    columnName: 'account_id',
    ordinalPosition: 1,
    columnType: 'int unsigned',
    characterSetName: null,
    collationName: null,
    isNullable: 'NO',
    columnDefault: null,
    extra: '',
    ...overrides,
  };
}

function statistic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { indexName: 'PRIMARY', sequenceInIndex: 1, columnName: 'account_id', subPart: null, expression: null, indexType: 'BTREE', ...overrides };
}

function layer(
  rows: readonly Record<string, unknown>[],
  statistics: readonly Record<string, unknown>[] = [statistic()],
  constraints: readonly Record<string, unknown>[] = [],
  checks: readonly Record<string, unknown>[] = [],
): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      if (options.sql.includes('STATISTICS')) return [statistics, []] as never;
      if (options.sql.includes('KEY_COLUMN_USAGE')) return [constraints, []] as never;
      if (options.sql.includes('CHECK_CONSTRAINTS')) return [checks, []] as never;
      return [rows, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function errorCode(mysql: ConnectionLayer, request: AlterTableModifyColumnInput = input): Promise<string> {
  try {
    await validateAlterTableModifyColumnMetadata(mysql, request);
  } catch (error) {
    assert.ok(error instanceof AlterTableModifyColumnMetadataError);
    return error.code;
  }
  throw new Error('Expected metadata validation failure.');
}

test('accepts a same-signedness integer widening with an existing B-tree dependency', async () => {
  await validateAlterTableModifyColumnMetadata(layer([column()]), input);
});

test('accepts making an existing non-nullable column nullable without changing its type', async () => {
  await validateAlterTableModifyColumnMetadata(
    layer(
      [column({ columnType: 'varchar(100)', isNullable: 'NO', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' })],
      [statistic({ indexName: 'label_idx' })],
    ),
    { ...input, column: 'account_id', definition: { name: 'account_id', type: { kind: 'varchar', length: 100 }, nullable: true } },
  );
});

test('rejects narrowing, signedness changes, no-ops, defaults, foreign keys, and unsupported index dependencies', async () => {
  const cases: Array<[Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], AlterTableModifyColumnInput]> = [
    [[column({ columnType: 'bigint unsigned' })], [statistic()], [], input],
    [[column()], [statistic({ subPart: 10 })], [], input],
    [[column()], [statistic({ columnName: null, expression: 'lower(account_id)' })], [], input],
    [[column({ columnDefault: '0' })], [statistic()], [], input],
    [
      [column()],
      [statistic()],
      [
        {
          constraintName: 'orders_customer_fk',
          tableName: 'orders',
          columnName: 'account_id',
          referencedTableName: 'customers',
          referencedColumnName: 'id',
          constraintType: 'FOREIGN KEY',
        },
      ],
      input,
    ],
    [
      [column()],
      [statistic()],
      [],
      { ...input, definition: { name: 'account_id', type: { kind: 'integer', integerType: 'tinyint', unsigned: true }, nullable: false } },
    ],
  ];
  for (const [rows, statistics, constraints, request] of cases) {
    assert.equal(await errorCode(layer(rows, statistics, constraints), request), 'MYSQL_DDL_COLUMN_INVALID');
  }
});

test('fails closed for missing, view, and malformed metadata', async () => {
  assert.equal(await errorCode(layer([])), 'MYSQL_DDL_METADATA_INVALID');
  assert.equal(await errorCode(layer([column({ tableType: 'VIEW' })])), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(await errorCode(layer([column({ columnType: 'not-a-type' })])), 'MYSQL_DDL_COLUMN_INVALID');
  assert.equal(await errorCode(layer([column(), column({ columnName: 'account_id', ordinalPosition: 2 })])), 'MYSQL_DDL_METADATA_INVALID');
});

test('rejects nullable primary keys and CHECK-constrained tables', async () => {
  assert.equal(
    await errorCode(
      layer(
        [column({ columnType: 'varchar(100)', isNullable: 'NO', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' })],
        [statistic({ indexName: 'PRIMARY' })],
        [
          {
            constraintName: 'PRIMARY',
            tableName: 'accounts',
            columnName: 'account_id',
            referencedTableName: null,
            referencedColumnName: null,
            constraintType: 'PRIMARY KEY',
          },
        ],
      ),
      { ...input, definition: { name: 'account_id', type: { kind: 'varchar', length: 100 }, nullable: true } },
    ),
    'MYSQL_DDL_COLUMN_INVALID',
  );
  assert.equal(
    await errorCode(
      layer(
        [column({ columnType: 'varchar(100)', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' })],
        [statistic({ indexName: 'label_idx' })],
        [],
        [{ constraintName: 'account_id_check' }],
      ),
      { ...input, definition: { name: 'account_id', type: { kind: 'varchar', length: 200 }, nullable: false } },
    ),
    'MYSQL_DDL_COLUMN_INVALID',
  );
});

test('preserves character set and collation in the prepared definition', async () => {
  const prepared = await validateAlterTableModifyColumnMetadata(
    layer(
      [column({ columnType: 'varchar(100)', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' })],
      [statistic({ indexName: 'label_idx', columnName: 'account_id' })],
    ),
    { ...input, definition: { name: 'account_id', type: { kind: 'varchar', length: 200 }, nullable: false } },
  );
  assert.deepEqual(prepared.definition, {
    name: 'account_id',
    type: { kind: 'varchar', length: 200 },
    nullable: false,
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_bin',
  });
});

test('preserves character set and collation when widening TEXT nullability', async () => {
  const prepared = await validateAlterTableModifyColumnMetadata(
    layer([column({ columnType: 'text', isNullable: 'NO', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' })], []),
    { ...input, definition: { name: 'account_id', type: { kind: 'text' }, nullable: true } },
  );
  assert.deepEqual(prepared.definition, {
    name: 'account_id',
    type: { kind: 'text' },
    nullable: true,
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_bin',
  });
});
