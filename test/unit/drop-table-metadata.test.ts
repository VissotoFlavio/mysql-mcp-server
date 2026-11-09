import assert from 'node:assert/strict';
import test from 'node:test';

import { toSafeDdlOutcome } from '../../src/db/ddl-audit.js';
import {
  consumeDropTableMetadataAttestation,
  DropTableMetadataError,
  describeAccessibleTable,
  validateDropTableMetadata,
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
const input = { schema: 'app', table: 'orders', reason: 'Remove it.', confirmation: `DROP_TABLE:${'a'.repeat(64)}` } as const;

function layer(
  tableRows: readonly Record<string, unknown>[],
  foreignKeys: readonly Record<string, unknown>[] = [],
  dependencies: readonly Record<string, unknown>[] = [],
  triggers: readonly Record<string, unknown>[] = [],
): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      if (options.sql.includes('KEY_COLUMN_USAGE')) return [foreignKeys, []] as never;
      if (options.sql.includes('VIEW_TABLE_USAGE')) return [dependencies, []] as never;
      if (options.sql.includes('information_schema.TRIGGERS')) return [triggers, []] as never;
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
    assert.ok(error instanceof DropTableMetadataError);
    return (error as DropTableMetadataError).code;
  }
  throw new Error('Expected drop-table metadata validation failure.');
}

test('accepts one dependency-free base table and returns its recent target-bound metadata revision', async () => {
  const observed = await describeAccessibleTable(layer(table), 'app', 'orders', true);
  assert.ok(observed);
  const result = await validateDropTableMetadata(layer(table), { ...input, confirmation: `DROP_TABLE:${observed.metadataRevision}` });
  assert.equal(result.metadataRevision, observed.metadataRevision);
});

test('rejects missing objects, views, known dependencies, and malformed metadata', async () => {
  const observed = await describeAccessibleTable(layer(table), 'app', 'orders', true);
  assert.ok(observed);
  const confirmedInput = { ...input, confirmation: `DROP_TABLE:${observed.metadataRevision}` };
  assert.equal(await codeOf(() => validateDropTableMetadata(layer([]), confirmedInput)), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(await codeOf(() => validateDropTableMetadata(layer([{ ...table[0], tableType: 'VIEW' }]), confirmedInput)), 'MYSQL_DDL_TABLE_INVALID');
  assert.equal(
    await codeOf(() =>
      validateDropTableMetadata(
        layer(table, [], [{ viewSchemaName: 'app', viewName: 'report', tableSchemaName: 'app', tableName: 'orders' }]),
        confirmedInput,
      ),
    ),
    'MYSQL_DDL_STRUCTURE_INVALID',
  );
  assert.equal(
    await codeOf(() => validateDropTableMetadata(layer(table, [], [], [{ triggerName: 'orders_insert' }]), confirmedInput)),
    'MYSQL_DDL_METADATA_INVALID',
  );
  assert.equal(
    await codeOf(() =>
      validateDropTableMetadata(
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
});

test('rejects a confirmation after table recreation and after one-time consumption', async () => {
  const original = await describeAccessibleTable(layer([{ ...table[0], createTime: '2026-11-09 20:00:00' }]), 'app', 'orders', true);
  assert.ok(original);
  const confirmation = { ...input, confirmation: `DROP_TABLE:${original.metadataRevision}` };
  assert.equal(
    await codeOf(() => validateDropTableMetadata(layer([{ ...table[0], createTime: '2026-11-09 20:01:00' }]), confirmation)),
    'MYSQL_DDL_METADATA_INVALID',
  );
  const validated = await validateDropTableMetadata(layer([{ ...table[0], createTime: '2026-11-09 20:00:00' }]), confirmation);
  consumeDropTableMetadataAttestation('app', 'orders', validated.metadataRevision);
  assert.equal(await codeOf(() => validateDropTableMetadata(layer(table), confirmation)), 'MYSQL_DDL_METADATA_INVALID');
});

test('keeps a target confirmation independent from unrelated metadata reads', async () => {
  const observed = await describeAccessibleTable(layer(table), 'app', 'orders', true);
  assert.ok(observed);
  for (let index = 0; index < 16; index += 1) {
    await describeAccessibleTable(layer([{ ...table[0], schemaName: 'app', tableName: `other_${index}` }]), 'app', `other_${index}`, true);
  }
  const result = await validateDropTableMetadata(layer(table), { ...input, confirmation: `DROP_TABLE:${observed.metadataRevision}` });
  assert.equal(result.metadataRevision, observed.metadataRevision);
});

test('maps table metadata failures to sanitized outcomes', () => {
  assert.deepEqual(toSafeDdlOutcome(new DropTableMetadataError('MYSQL_DDL_STRUCTURE_INVALID', 'internal')), {
    result: 'failed',
    code: 'MYSQL_DDL_STRUCTURE_INVALID',
    message: 'The target table has known dependencies.',
  });
});
