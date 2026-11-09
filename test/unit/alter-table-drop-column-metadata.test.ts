import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AlterTableDropColumnMetadataError,
  AlterTableDropColumnVerificationError,
  validateAlterTableDropColumnMetadata,
  verifyAlterTableDropColumnMetadata,
} from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

const input = { schema: 'app', table: 'orders', column: 'obsolete_label', reason: 'Remove it.', confirmation: 'DROP_COLUMN' as const };
const columns = [
  { schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE', columnName: 'id', ordinalPosition: 1, extra: '', generationExpression: null },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'obsolete_label',
    ordinalPosition: 2,
    extra: '',
    generationExpression: null,
  },
];

function layer(overrides: Readonly<Record<string, readonly Record<string, unknown>[]>> = {}): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      const sql = options.sql;
      if (sql.includes('COLUMNS AS columns')) return [overrides.columns ?? columns, []] as never;
      if (sql.includes('FROM information_schema.STATISTICS')) return [overrides.statistics ?? [], []] as never;
      if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) return [overrides.constraints ?? [], []] as never;
      if (sql.includes('FROM information_schema.CHECK_CONSTRAINTS')) return [overrides.checks ?? [], []] as never;
      if (sql.includes('FROM information_schema.VIEW_TABLE_USAGE')) return [overrides.views ?? [], []] as never;
      return [[], []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function rejected(callback: () => Promise<unknown>): Promise<string> {
  await assert.rejects(callback, (error: unknown) => {
    assert(error instanceof AlterTableDropColumnMetadataError);
    return true;
  });
  try {
    await callback();
  } catch (error) {
    return (error as AlterTableDropColumnMetadataError).code;
  }
  throw new Error('Expected metadata rejection.');
}

test('allows exactly one existing non-generated column with no visible dependencies', async () => {
  await validateAlterTableDropColumnMetadata(layer(), input);
});

test('fails closed for generated columns and every dependency family', async () => {
  const cases = [
    { columns: columns.map((row) => (row.columnName === input.column ? { ...row, extra: 'STORED GENERATED' } : row)) },
    { columns: columns.map((row) => (row.columnName === 'id' ? { ...row, generationExpression: 'obsolete_label + 1' } : row)) },
    {
      statistics: [
        { indexName: 'orders_label_idx', sequenceInIndex: 1, columnName: input.column, subPart: null, expression: null, indexType: 'BTREE' },
      ],
    },
    {
      constraints: [
        {
          constraintName: 'orders_fk',
          tableName: 'orders',
          columnName: input.column,
          referencedTableName: 'customers',
          referencedColumnName: 'id',
          constraintType: 'FOREIGN KEY',
        },
      ],
    },
    { checks: [{ constraintName: 'orders_check', tableName: 'orders', checkClause: "`obsolete_label` <> ''" }] },
    { views: [{ viewSchemaName: 'app', viewName: 'orders_view', tableSchemaName: 'app', tableName: 'orders' }] },
  ] as const;
  for (const overrides of cases)
    assert.equal(await rejected(() => validateAlterTableDropColumnMetadata(layer(overrides), input)), 'MYSQL_DDL_COLUMN_INVALID');
});

test('rejects missing or non-base tables and malformed dependency metadata', async () => {
  assert.equal(await rejected(() => validateAlterTableDropColumnMetadata(layer({ columns: [] }), input)), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(
    await rejected(() => validateAlterTableDropColumnMetadata(layer({ columns: columns.map((row) => ({ ...row, tableType: 'VIEW' })) }), input)),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(
    await rejected(() => validateAlterTableDropColumnMetadata(layer({ statistics: [{ indexName: 'idx' }] }), input)),
    'MYSQL_DDL_METADATA_INVALID',
  );
  assert.equal(
    await rejected(() =>
      validateAlterTableDropColumnMetadata(layer({ columns: [{ ...columns[0], generationExpression: undefined }, columns[1]] }), input),
    ),
    'MYSQL_DDL_METADATA_INVALID',
  );
});

test('verifies that the target column is absent after execution', async () => {
  await verifyAlterTableDropColumnMetadata(layer({ columns: [columns[0] as Record<string, unknown>] }), input);
  await assert.rejects(
    () => verifyAlterTableDropColumnMetadata(layer(), input),
    (error: unknown) => error instanceof AlterTableDropColumnVerificationError,
  );
});

test('fails closed when post-execution metadata is incomplete or inconsistent', async () => {
  for (const incomplete of [
    [{ schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' }],
    [
      {
        schemaName: 'other',
        tableName: 'orders',
        tableType: 'BASE TABLE',
        columnName: 'id',
        ordinalPosition: 1,
        extra: '',
        generationExpression: null,
      },
    ],
    [
      {
        schemaName: 'app',
        tableName: 'orders',
        tableType: 'BASE TABLE',
        columnName: 'id',
        ordinalPosition: 1,
        extra: '',
        generationExpression: null,
      },
      {
        schemaName: 'app',
        tableName: 'orders',
        tableType: 'BASE TABLE',
        columnName: 'id',
        ordinalPosition: 2,
        extra: '',
        generationExpression: null,
      },
    ],
  ]) {
    await assert.rejects(() => verifyAlterTableDropColumnMetadata(layer({ columns: incomplete }), input), AlterTableDropColumnVerificationError);
  }
});
