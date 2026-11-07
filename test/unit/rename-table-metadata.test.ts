import assert from 'node:assert/strict';
import test from 'node:test';

import { RenameTableMetadataError, validateRenameTableMetadata } from '../../src/db/metadata.js';

const row = (overrides: Record<string, unknown> = {}) => ({ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', ...overrides });
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
    assert.ok(error instanceof RenameTableMetadataError);
    return error.code;
  }
  throw new Error('Expected metadata failure');
};

test('accepts a base source and absent destination in the same schema', async () => {
  await validateRenameTableMetadata(layer([row()]), 'app', 'accounts', 'customers');
  await validateRenameTableMetadata(layer([row({ schemaName: 'APP' })]), 'app', 'accounts', 'customers');
});

test('rejects views, missing sources, destination conflicts, malformed, and unavailable metadata', async () => {
  assert.equal(
    await code(() => validateRenameTableMetadata(layer([row({ tableType: 'VIEW' })]), 'app', 'accounts', 'customers')),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(await code(() => validateRenameTableMetadata(layer([]), 'app', 'accounts', 'customers')), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(
    await code(() => validateRenameTableMetadata(layer([row(), row({ tableName: 'customers' })]), 'app', 'accounts', 'customers')),
    'MYSQL_DDL_TABLE_EXISTS',
  );
  assert.equal(
    await code(() => validateRenameTableMetadata(layer([row({ tableName: 'unknown' })]), 'app', 'accounts', 'customers')),
    'MYSQL_DDL_METADATA_INVALID',
  );
  assert.equal(await code(() => validateRenameTableMetadata(layer([], true), 'app', 'accounts', 'customers')), 'MYSQL_DDL_METADATA_INVALID');
});
