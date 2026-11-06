import assert from 'node:assert/strict';
import test from 'node:test';

import { CreateIndexMetadataError, validateCreateIndexMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

function column(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE', columnName: 'id', ordinalPosition: 1, extra: '', ...overrides };
}

function statistic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaName: 'app',
    tableName: 'orders',
    indexName: 'PRIMARY',
    nonUnique: 0,
    sequenceInIndex: 1,
    collation: 'A',
    columnName: 'id',
    subPart: null,
    expression: null,
    indexType: 'BTREE',
    ...overrides,
  };
}

function layer(columns: readonly Record<string, unknown>[], statistics: readonly Record<string, unknown>[]): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      return [options.sql.includes('information_schema.STATISTICS') ? statistics : columns, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function codeOf(callback: () => Promise<unknown>): Promise<string> {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof CreateIndexMetadataError);
    return (error as CreateIndexMetadataError).code;
  }
  throw new Error('Expected metadata validation failure.');
}

test('accepts a base table and distinct visible non-generated columns with no duplicate index', async () => {
  await validateCreateIndexMetadata(
    layer([column(), column({ columnName: 'created_at', ordinalPosition: 2 })], [statistic()]),
    'app',
    'orders',
    'orders_created_at_idx',
    ['created_at'],
  );
});

test('rejects unavailable table metadata and unsafe target columns', async () => {
  assert.equal(await codeOf(() => validateCreateIndexMetadata(layer([], []), 'app', 'orders', 'orders_idx', ['id'])), 'MYSQL_DDL_METADATA_INVALID');
  assert.equal(
    await codeOf(() => validateCreateIndexMetadata(layer([column({ tableType: 'VIEW' })], []), 'app', 'orders', 'orders_idx', ['id'])),
    'MYSQL_DDL_TABLE_INVALID',
  );
  for (const [columns, requested] of [
    [[column()], 'missing'],
    [[column(), column({ columnName: 'generated', ordinalPosition: 2, extra: 'STORED GENERATED' })], 'missing'],
    [[column(), column({ columnName: 'hidden', ordinalPosition: 2, extra: 'INVISIBLE' })], 'hidden'],
  ] as const) {
    assert.equal(
      await codeOf(() => validateCreateIndexMetadata(layer(columns, []), 'app', 'orders', 'orders_idx', [requested])),
      'MYSQL_DDL_COLUMN_INVALID',
    );
  }
  assert.equal(
    await codeOf(() =>
      validateCreateIndexMetadata(
        layer([column(), column({ columnName: 'generated', ordinalPosition: 2, extra: 'STORED GENERATED' })], []),
        'app',
        'orders',
        'orders_idx',
        ['generated'],
      ),
    ),
    'MYSQL_DDL_COLUMN_INVALID',
  );
});

test('rejects an occupied index name or existing equivalent B-tree definition', async () => {
  const columns = [column(), column({ columnName: 'tenant_id', ordinalPosition: 2 }), column({ columnName: 'created_at', ordinalPosition: 3 })];
  assert.equal(
    await codeOf(() =>
      validateCreateIndexMetadata(layer(columns, [statistic({ indexName: 'orders_idx', columnName: 'tenant_id' })]), 'app', 'orders', 'orders_idx', [
        'created_at',
      ]),
    ),
    'MYSQL_DDL_INDEX_EXISTS',
  );
  assert.equal(
    await codeOf(() =>
      validateCreateIndexMetadata(layer(columns, [statistic({ indexName: 'ORDERS_IDX', columnName: 'tenant_id' })]), 'app', 'orders', 'orders_idx', [
        'created_at',
      ]),
    ),
    'MYSQL_DDL_INDEX_EXISTS',
  );
  assert.equal(
    await codeOf(() =>
      validateCreateIndexMetadata(
        layer(columns, [
          statistic({ indexName: 'tenant_created_idx', nonUnique: 1, columnName: 'tenant_id' }),
          statistic({ indexName: 'tenant_created_idx', nonUnique: 1, sequenceInIndex: 2, columnName: 'created_at' }),
        ]),
        'app',
        'orders',
        'other_idx',
        ['tenant_id', 'created_at'],
      ),
    ),
    'MYSQL_DDL_INDEX_EXISTS',
  );
});

test('does not mistake prefix, expression, or non-B-tree metadata for the supported definition', async () => {
  const columns = [column(), column({ columnName: 'created_at', ordinalPosition: 2 })];
  for (const statisticOverride of [
    { subPart: 4 },
    { expression: 'lower(`created_at`)', columnName: null },
    { indexType: 'FULLTEXT', collation: null },
    { collation: 'D' },
    { nonUnique: 0 },
  ]) {
    await validateCreateIndexMetadata(
      layer(columns, [statistic({ ...statisticOverride, columnName: statisticOverride.columnName ?? 'created_at' })]),
      'app',
      'orders',
      'orders_idx',
      ['created_at'],
    );
  }
});

test('rejects malformed non-contiguous index statistics', async () => {
  assert.equal(
    await codeOf(() => validateCreateIndexMetadata(layer([column()], [statistic({ sequenceInIndex: 2 })]), 'app', 'orders', 'other_idx', ['id'])),
    'MYSQL_DDL_METADATA_INVALID',
  );
});
