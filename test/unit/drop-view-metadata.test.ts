import assert from 'node:assert/strict';
import test from 'node:test';

import { DropViewMetadataError, validateDropViewMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

function layer(tableRows: readonly Record<string, unknown>[], dependencyRows: readonly Record<string, unknown>[] = []): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      return [options.sql.includes('VIEW_TABLE_USAGE') ? dependencyRows : tableRows, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function codeOf(callback: () => Promise<unknown>): Promise<string> {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof DropViewMetadataError);
    return (error as DropViewMetadataError).code;
  }
  throw new Error('Expected drop-view metadata validation failure.');
}

test('allows one existing view with no known dependent views', async () => {
  await validateDropViewMetadata(layer([{ schemaName: 'app', tableName: 'account_labels', tableType: 'VIEW' }]), 'app', 'account_labels');
});

test('rejects missing objects, base tables, and known dependent views before execution', async () => {
  assert.equal(await codeOf(() => validateDropViewMetadata(layer([]), 'app', 'missing')), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(
    await codeOf(() =>
      validateDropViewMetadata(layer([{ schemaName: 'app', tableName: 'account_labels', tableType: 'BASE TABLE' }]), 'app', 'account_labels'),
    ),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(
    await codeOf(() =>
      validateDropViewMetadata(
        layer(
          [{ schemaName: 'app', tableName: 'account_labels', tableType: 'VIEW' }],
          [{ viewSchemaName: 'app', viewName: 'account_report', tableSchemaName: 'app', tableName: 'account_labels' }],
        ),
        'app',
        'account_labels',
      ),
    ),
    'MYSQL_DDL_STRUCTURE_INVALID',
  );
});

test('fails closed when dependency metadata is malformed or unavailable', async () => {
  assert.equal(
    await codeOf(() =>
      validateDropViewMetadata(
        layer([{ schemaName: 'app', tableName: 'account_labels', tableType: 'VIEW' }], [{ viewName: 'account_report' }]),
        'app',
        'account_labels',
      ),
    ),
    'MYSQL_DDL_METADATA_INVALID',
  );
});
