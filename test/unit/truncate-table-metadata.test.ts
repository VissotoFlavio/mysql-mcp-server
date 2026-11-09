import assert from 'node:assert/strict';
import test from 'node:test';

import { toSafeDdlOutcome } from '../../src/db/ddl-audit.js';
import {
  consumeTruncateTableMetadataAttestation,
  createTableMetadataRevision,
  describeAccessibleTable,
  TruncateTableMetadataError,
  validateTruncateTableMetadata,
} from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

const table = [
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    createTime: '2026-11-09 20:00:00',
    columnName: 'id',
    dataType: 'bigint',
    isNullable: 'NO',
    columnKey: 'PRI',
  },
];
const input = { schema: 'app', table: 'orders', reason: 'Clear it.', confirmation: `TRUNCATE_TABLE:${'a'.repeat(64)}` } as const;

function layer(tableRows: readonly Record<string, unknown>[], foreignKeys: readonly Record<string, unknown>[] = []): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      if (options.sql.includes('KEY_COLUMN_USAGE')) return [foreignKeys, []] as never;
      return [tableRows, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

async function codeOf(callback: () => Promise<unknown>): Promise<string> {
  try {
    await callback();
  } catch (error) {
    assert.ok(error instanceof TruncateTableMetadataError);
    return (error as TruncateTableMetadataError).code;
  }
  throw new Error('Expected truncate-table metadata validation failure.');
}

test('accepts one dependency-free base table and returns its target-bound truncate revision', async () => {
  const observed = await describeAccessibleTable(layer(table), 'app', 'orders', true);
  assert.ok(observed);
  const result = await validateTruncateTableMetadata(layer(table), { ...input, confirmation: `TRUNCATE_TABLE:${observed.metadataRevision}` });
  assert.equal(result.metadataRevision, observed.metadataRevision);
});

test('rejects missing objects, views, malformed metadata, and every foreign-key relationship', async () => {
  const observed = await describeAccessibleTable(layer(table), 'app', 'orders', true);
  assert.ok(observed);
  const confirmedInput = { ...input, confirmation: `TRUNCATE_TABLE:${observed.metadataRevision}` };
  assert.equal(await codeOf(() => validateTruncateTableMetadata(layer([]), confirmedInput)), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(
    await codeOf(() => validateTruncateTableMetadata(layer([{ ...table[0], tableType: 'VIEW' }]), confirmedInput)),
    'MYSQL_DDL_TABLE_INVALID',
  );
  assert.equal(
    await codeOf(() =>
      validateTruncateTableMetadata(
        layer(table, [
          {
            constraintSchemaName: 'app',
            schemaName: 'app',
            tableName: 'child',
            constraintName: 'child_orders_fk',
            referencedSchemaName: 'app',
            referencedTableName: 'orders',
          },
        ]),
        confirmedInput,
      ),
    ),
    'MYSQL_DDL_STRUCTURE_INVALID',
  );
  assert.equal(
    await codeOf(() => validateTruncateTableMetadata(layer([{ ...table[0], dataType: undefined }]), confirmedInput)),
    'MYSQL_DDL_METADATA_INVALID',
  );
});

test('rejects a column metadata result truncated at the safety limit', async () => {
  const tooManyColumns = Array.from({ length: 101 }, (_, index) => ({
    ...table[0],
    columnName: `column_${index}`,
    columnKey: '',
  }));
  const observed = await describeAccessibleTable(layer(tooManyColumns), 'app', 'orders', true);
  assert.ok(observed);
  assert.equal(observed.columns.length, 100);
  assert.equal(
    await codeOf(() =>
      validateTruncateTableMetadata(layer(tooManyColumns), {
        ...input,
        confirmation: `TRUNCATE_TABLE:${observed.metadataRevision}`,
      }),
    ),
    'MYSQL_DDL_METADATA_INVALID',
  );
});

test('rejects malformed table identity metadata', async () => {
  for (const malformed of [[{ ...table[0], createTime: 'not-a-date' }], [{ ...table[0], isNullable: 'MAYBE' }]]) {
    const observed = await describeAccessibleTable(layer(malformed as never), 'app', 'orders', true);
    assert.ok(observed);
    assert.equal(
      observed.metadataRevision,
      createTableMetadataRevision({
        table: { schemaName: 'app', tableName: 'orders', tableType: 'BASE TABLE' },
        columns: [{ columnName: 'id', dataType: 'bigint', isNullable: false, columnKey: 'PRI' }],
      }),
    );
    assert.equal(
      await codeOf(() =>
        validateTruncateTableMetadata(layer(malformed as never), {
          ...input,
          confirmation: `TRUNCATE_TABLE:${observed.metadataRevision}`,
        }),
      ),
      'MYSQL_DDL_METADATA_INVALID',
    );
  }
});

test('consumes a truncate confirmation once and maps foreign-key rejection safely', async () => {
  const observed = await describeAccessibleTable(layer(table), 'app', 'orders', true);
  assert.ok(observed);
  const confirmedInput = { ...input, confirmation: `TRUNCATE_TABLE:${observed.metadataRevision}` };
  const validated = await validateTruncateTableMetadata(layer(table), confirmedInput);
  consumeTruncateTableMetadataAttestation('app', 'orders', validated.metadataRevision);
  assert.equal(await codeOf(() => validateTruncateTableMetadata(layer(table), confirmedInput)), 'MYSQL_DDL_METADATA_INVALID');
  assert.deepEqual(toSafeDdlOutcome(new TruncateTableMetadataError('MYSQL_DDL_STRUCTURE_INVALID', 'internal')), {
    result: 'failed',
    code: 'MYSQL_DDL_STRUCTURE_INVALID',
    message: 'The target table has known dependencies.',
  });
});
