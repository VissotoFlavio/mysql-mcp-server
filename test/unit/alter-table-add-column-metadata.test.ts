import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableAddColumnMetadataError, validateAlterTableAddColumnMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', columnName: 'id', ordinalPosition: 1, ...overrides };
}

function layer(rows: readonly Record<string, unknown>[]): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query() {
      return [rows, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function codeOf(callback: () => Promise<unknown>): Promise<string> {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof AlterTableAddColumnMetadataError);
    return error.code;
  }
  throw new Error('Expected metadata validation failure.');
}

test('accepts a base table without the requested column', async () => {
  await validateAlterTableAddColumnMetadata(layer([row(), row({ columnName: 'email', ordinalPosition: 2 })]), 'app', 'accounts', 'nickname');
});

test('rejects inaccessible, non-base, malformed, and duplicate-column metadata', async () => {
  assert.equal(await codeOf(() => validateAlterTableAddColumnMetadata(layer([]), 'app', 'accounts', 'nickname')), 'MYSQL_DDL_METADATA_INVALID');
  assert.equal(
    await codeOf(() => validateAlterTableAddColumnMetadata(layer([row({ tableType: 'VIEW' })]), 'app', 'accounts', 'nickname')),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(await codeOf(() => validateAlterTableAddColumnMetadata(layer([row()]), 'app', 'accounts', 'id')), 'MYSQL_DDL_COLUMN_EXISTS');
  assert.equal(
    await codeOf(() =>
      validateAlterTableAddColumnMetadata(layer([row(), row({ columnName: 'id', ordinalPosition: 2 })]), 'app', 'accounts', 'nickname'),
    ),
    'MYSQL_DDL_METADATA_INVALID',
  );
});
