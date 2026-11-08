import assert from 'node:assert/strict';
import test from 'node:test';

import { CreateSchemaMetadataError, validateCreateSchemaMetadata } from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

function layer(rows: readonly Record<string, unknown>[], fail = false): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query() {
      if (fail) throw new Error('metadata-secret');
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
    assert.ok(error instanceof CreateSchemaMetadataError);
    return error.code;
  }
  throw new Error('Expected CREATE SCHEMA metadata validation failure.');
}

test('preflights only bounded SCHEMATA metadata and allows a target absent from the configured database context', async () => {
  let sql = '';
  let values: unknown;
  const mysql: ConnectionLayer = {
    ...layer([]),
    async query(options, receivedValues) {
      sql = options.sql;
      values = receivedValues;
      return [[], []] as never;
    },
  };
  await validateCreateSchemaMetadata(mysql, 'new_catalog');
  assert.match(sql, /information_schema\.SCHEMATA/);
  assert.match(sql, /LIMIT \?/);
  assert.deepEqual(values, ['new_catalog', 2]);
});

test('rejects an existing schema and malformed or unavailable metadata with safe classifications', async () => {
  assert.equal(await codeOf(() => validateCreateSchemaMetadata(layer([{ schemaName: 'catalog' }]), 'catalog')), 'MYSQL_DDL_SCHEMA_EXISTS');
  assert.equal(await codeOf(() => validateCreateSchemaMetadata(layer([{ schemaName: 'other' }]), 'catalog')), 'MYSQL_DDL_METADATA_INVALID');
  assert.equal(await codeOf(() => validateCreateSchemaMetadata(layer([], true), 'catalog')), 'MYSQL_DDL_METADATA_INVALID');
});
