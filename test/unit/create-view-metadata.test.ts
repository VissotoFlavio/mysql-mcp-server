import assert from 'node:assert/strict';
import test from 'node:test';

import { CreateViewMetadataError, validateCreateViewMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

function layer(columns: readonly Record<string, unknown>[]): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      return [
        options.sql.includes('information_schema.TABLES') ? [{ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE' }] : columns,
        [],
      ] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function codeOf(callback: () => Promise<unknown>): Promise<string> {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof CreateViewMetadataError);
    return (error as CreateViewMetadataError).code;
  }
  throw new Error('Expected create-view metadata validation failure.');
}

test('allows visible selected columns when a different source column is invisible', async () => {
  await validateCreateViewMetadata(
    layer([
      { columnName: 'id', ordinalPosition: 1, extra: '' },
      { columnName: 'internal_token', ordinalPosition: 2, extra: 'INVISIBLE' },
      { columnName: 'label', ordinalPosition: 3, extra: '' },
    ]),
    'app',
    'account_labels',
    'accounts',
    ['id', 'label'],
  );
});

test('rejects an invisible requested source column with the safe column outcome', async () => {
  assert.equal(
    await codeOf(() =>
      validateCreateViewMetadata(
        layer([
          { columnName: 'id', ordinalPosition: 1, extra: '' },
          { columnName: 'internal_token', ordinalPosition: 2, extra: 'INVISIBLE' },
        ]),
        'app',
        'account_tokens',
        'accounts',
        ['internal_token'],
      ),
    ),
    'MYSQL_DDL_COLUMN_INVALID',
  );
});
