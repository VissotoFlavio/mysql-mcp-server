import assert from 'node:assert/strict';
import test from 'node:test';

import { DmlMetadataError, validateDmlMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

function metadataLayer(
  columns: readonly Record<string, unknown>[],
  primaryKey: readonly Record<string, unknown>[] = [],
  calls: { count: number; values: unknown[][]; sqls: string[] } = { count: 0, values: [], sqls: [] },
): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options, values) {
      calls.count += 1;
      calls.values.push(values as unknown[]);
      calls.sqls.push(options.sql);
      return [options.sql.includes('KEY_COLUMN_USAGE') ? primaryKey : columns, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

function column(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'id',
    dataType: 'bigint',
    isNullable: 'NO',
    columnKey: 'PRI',
    ordinalPosition: 1,
    extra: 'auto_increment',
    ...overrides,
  };
}

function primaryKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaName: 'app',
    tableName: 'orders',
    constraintName: 'PRIMARY',
    columnName: 'id',
    ordinalPosition: 1,
    ...overrides,
  };
}

test('returns primary-key constraint order and full column metadata for each operation', async () => {
  const calls = { count: 0, values: [] as unknown[][], sqls: [] as string[] };
  const mysql = metadataLayer(
    [
      column({ columnName: 'tenant_id', ordinalPosition: 2, extra: '' }),
      column({ columnName: 'id', ordinalPosition: 1 }),
      column({ columnName: 'unique_id', ordinalPosition: 3, columnKey: 'UNI', extra: '' }),
    ],
    [primaryKey({ columnName: 'tenant_id', ordinalPosition: 1 }), primaryKey({ columnName: 'id', ordinalPosition: 2 })],
    calls,
  );

  const first = await validateDmlMetadata(mysql, 'app', 'orders', ['unique_id']);
  const second = await validateDmlMetadata(mysql, 'app', 'orders', ['unique_id']);

  assert.deepEqual(first.primaryKey, ['tenant_id', 'id']);
  assert.deepEqual(
    first.columns.map(({ columnName, isAutoIncrement, isGenerated }) => ({ columnName, isAutoIncrement, isGenerated })),
    [
      { columnName: 'id', isAutoIncrement: true, isGenerated: false },
      { columnName: 'tenant_id', isAutoIncrement: false, isGenerated: false },
      { columnName: 'unique_id', isAutoIncrement: false, isGenerated: false },
    ],
  );
  assert.deepEqual(second, first);
  assert.equal(calls.count, 4);
  assert.deepEqual(calls.values, [
    ['app', 'orders', 101],
    ['app', 'orders'],
    ['app', 'orders', 101],
    ['app', 'orders'],
  ]);
  assert.match(calls.sqls[0], /LIMIT \?/);
  assert.match(calls.sqls[0], /columns\.EXTRA AS extra/);
  assert.doesNotMatch(calls.sqls[0], /IS_GENERATED|IS_VISIBLE/);
});

test('rejects metadata beyond the DML column ceiling', async () => {
  const columns = Array.from({ length: 101 }, (_, index) =>
    column({
      columnName: `column_${index + 1}`,
      ordinalPosition: index + 1,
      columnKey: index === 100 ? 'PRI' : '',
      extra: '',
    }),
  );
  const mysql = metadataLayer(columns, [primaryKey({ columnName: 'column_101', ordinalPosition: 1 })]);

  await assert.rejects(validateDmlMetadata(mysql, 'app', 'orders', ['column_101']), /Unable to validate the requested table metadata/);
});

test('rejects unknown, invisible, generated, and auto-increment supplied columns', async () => {
  const mysql = metadataLayer(
    [
      column(),
      column({ columnName: 'generated_value', ordinalPosition: 2, columnKey: '', extra: 'VIRTUAL GENERATED' }),
      column({ columnName: 'hidden_value', ordinalPosition: 3, columnKey: '', extra: 'INVISIBLE' }),
    ],
    [primaryKey()],
  );

  for (const suppliedColumn of ['missing', 'hidden_value']) {
    await assert.rejects(validateDmlMetadata(mysql, 'app', 'orders', [suppliedColumn]), (error: unknown) => {
      assert(error instanceof DmlMetadataError);
      assert.equal(error.message, 'One or more supplied DML columns are unknown or inaccessible.');
      return true;
    });
  }
  await assert.rejects(validateDmlMetadata(mysql, 'app', 'orders', ['generated_value']), /Generated columns cannot be supplied for DML/);
  await assert.rejects(validateDmlMetadata(mysql, 'app', 'orders', ['id']), /AUTO_INCREMENT columns cannot be supplied for DML/);
});

test('rejects malformed or inconsistent column and primary-key metadata', async () => {
  const invalidColumns = [
    column({ ordinalPosition: 0 }),
    column({ columnName: 'other', ordinalPosition: 2, extra: 123 }),
    column({ columnName: 'other', ordinalPosition: 2, extra: undefined }),
    column({ columnName: 'other', ordinalPosition: 2, schemaName: 'other_app' }),
    column({ columnName: 'other', ordinalPosition: 2, tableName: 'other_orders' }),
    column({ columnName: 'other', ordinalPosition: 1, extra: '' }),
    column({ columnName: 'id', ordinalPosition: 2 }),
  ];
  for (const columns of invalidColumns.map((invalid) => [column(), invalid])) {
    await assert.rejects(validateDmlMetadata(metadataLayer(columns), 'app', 'orders'), /Unable to validate the requested table metadata/);
  }

  for (const keys of [
    [primaryKey({ columnName: 'missing' })],
    [primaryKey({ columnName: 'unique_id' })],
    [primaryKey({ schemaName: 'other_app' })],
    [primaryKey({ tableName: 'other_orders' })],
    [primaryKey(), primaryKey()],
    [primaryKey({ ordinalPosition: 0 })],
    [primaryKey({ constraintName: 'unique_orders' })],
  ]) {
    await assert.rejects(validateDmlMetadata(metadataLayer([column()], keys), 'app', 'orders'), /Unable to validate the requested table metadata/);
  }

  await assert.rejects(
    validateDmlMetadata(
      metadataLayer(
        [column(), column({ columnName: 'unique_id', ordinalPosition: 2, columnKey: 'UNI', extra: '' })],
        [primaryKey({ columnName: 'unique_id' })],
      ),
      'app',
      'orders',
    ),
    /Unable to validate the requested table metadata/,
  );

  const compositeColumns = [column(), column({ columnName: 'tenant_id', ordinalPosition: 2, columnKey: 'PRI', extra: '' })];
  await assert.rejects(validateDmlMetadata(metadataLayer(compositeColumns), 'app', 'orders'), /Unable to validate the requested table metadata/);
  await assert.rejects(
    validateDmlMetadata(metadataLayer(compositeColumns, [primaryKey()]), 'app', 'orders'),
    /Unable to validate the requested table metadata/,
  );
  await assert.rejects(
    validateDmlMetadata(
      metadataLayer(compositeColumns, [primaryKey(), primaryKey({ columnName: 'tenant_id', ordinalPosition: 3 })]),
      'app',
      'orders',
    ),
    /Unable to validate the requested table metadata/,
  );
  await assert.rejects(
    validateDmlMetadata(
      metadataLayer([column({ columnKey: '', extra: '' }), column({ columnName: 'second', ordinalPosition: 3, columnKey: '', extra: '' })]),
      'app',
      'orders',
    ),
    /Unable to validate the requested table metadata/,
  );
  await assert.rejects(
    validateDmlMetadata(metadataLayer([column({ columnKey: '', extra: '' })]), 'app', 'orders'),
    /Unable to validate the requested table metadata/,
  );
});

test('sanitizes missing, inaccessible, and incompatible metadata', async () => {
  await assert.rejects(validateDmlMetadata(metadataLayer([]), 'app', 'missing'), (error: unknown) => {
    assert(error instanceof DmlMetadataError);
    assert.equal(error.message, 'Unable to validate the requested table metadata.');
    return true;
  });
  await assert.rejects(validateDmlMetadata(metadataLayer([column({ tableName: 'view', tableType: 'VIEW' })]), 'app', 'view'), /base tables only/);
  await assert.rejects(
    validateDmlMetadata(
      {
        ...metadataLayer([]),
        query: async () => {
          throw new Error('secret mysql details');
        },
      },
      'app',
      'hidden',
    ),
    (error: unknown) => {
      assert(error instanceof DmlMetadataError);
      assert.equal(error.message, 'Unable to validate the requested table metadata.');
      assert.doesNotMatch(error.message, /secret|mysql details/);
      return true;
    },
  );
});
