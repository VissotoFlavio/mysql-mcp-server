import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableRenameColumnMetadataError, validateAlterTableRenameColumnMetadata } from '../../src/db/metadata.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  schemaName: 'app',
  tableName: 'accounts',
  tableType: 'BASE TABLE',
  columnName: 'nickname',
  ordinalPosition: 1,
  ...overrides,
});
const layer = (rows: unknown, throws = false) =>
  ({
    queryOptions: () => ({ timeout: 30_000 }),
    query: async () => {
      if (throws) throw new Error('driver secret');
      return [rows, []];
    },
  }) as never;
const code = async (callback: () => Promise<void>) => {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof AlterTableRenameColumnMetadataError);
    return error.code;
  }
  throw new Error('Expected metadata failure');
};

test('accepts an existing source and absent destination base-table column', async () => {
  await validateAlterTableRenameColumnMetadata(
    layer([row(), row({ columnName: 'email', ordinalPosition: 2 })]),
    'app',
    'accounts',
    'nickname',
    'display_name',
  );
  await validateAlterTableRenameColumnMetadata(layer([row({ columnName: 'NickName' })]), 'app', 'accounts', 'nickname', 'display_name');
});

test('rejects non-base, missing source, destination conflict, malformed, and unavailable rename metadata', async () => {
  assert.equal(
    await code(() => validateAlterTableRenameColumnMetadata(layer([row({ tableType: 'VIEW' })]), 'app', 'accounts', 'nickname', 'display_name')),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(
    await code(() =>
      validateAlterTableRenameColumnMetadata(
        layer([row(), row({ columnName: 'Display_Name', ordinalPosition: 2 })]),
        'app',
        'accounts',
        'nickname',
        'display_name',
      ),
    ),
    'MYSQL_DDL_COLUMN_EXISTS',
  );
  assert.equal(
    await code(() => validateAlterTableRenameColumnMetadata(layer([row({ columnName: 'email' })]), 'app', 'accounts', 'nickname', 'display_name')),
    'MYSQL_DDL_COLUMN_INVALID',
  );
  assert.equal(
    await code(() =>
      validateAlterTableRenameColumnMetadata(
        layer([row(), row({ columnName: 'display_name', ordinalPosition: 2 })]),
        'app',
        'accounts',
        'nickname',
        'display_name',
      ),
    ),
    'MYSQL_DDL_COLUMN_EXISTS',
  );
  assert.equal(
    await code(() => validateAlterTableRenameColumnMetadata(layer([row({ ordinalPosition: 2 })]), 'app', 'accounts', 'nickname', 'display_name')),
    'MYSQL_DDL_METADATA_INVALID',
  );
  assert.equal(
    await code(() => validateAlterTableRenameColumnMetadata(layer([], true), 'app', 'accounts', 'nickname', 'display_name')),
    'MYSQL_DDL_METADATA_INVALID',
  );
});
