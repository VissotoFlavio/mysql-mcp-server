import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCreateTableStatement } from '../../src/db/ddl-builder.js';
import { assertCreateTableSql } from '../../src/db/sql-policy.js';
import { MAX_CREATE_TABLE_COLUMNS, MAX_CREATE_TABLE_IDENTIFIER_LENGTH, normalizeCreateTableInput } from '../../src/tools/create-table-input.js';

test('renders every supported CREATE TABLE column form deterministically', () => {
  const statement = buildCreateTableStatement(
    normalizeCreateTableInput({
      schema: 'app',
      table: 'accounts',
      reason: 'Create the account store.',
      columns: [
        { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
        { name: 'balance', type: { kind: 'decimal', precision: 12, scale: 2 }, nullable: false },
        { name: 'code', type: { kind: 'char', length: 4 }, nullable: false },
        { name: 'name', type: { kind: 'varchar', length: 255 }, nullable: true },
        { name: 'notes', type: { kind: 'text' }, nullable: true },
        { name: 'birth_date', type: { kind: 'date' }, nullable: true },
        { name: 'enabled', type: { kind: 'boolean' }, nullable: false },
        { name: 'metadata', type: { kind: 'json' }, nullable: true },
        { name: 'seen_at', type: { kind: 'timestamp', fractionalSecondsPrecision: 6 }, nullable: false },
      ],
      primaryKey: ['id', 'code'],
    }),
  );

  assert.equal(
    statement.sql,
    'CREATE TABLE `app`.`accounts` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `balance` DECIMAL(12,2) NOT NULL, `code` CHAR(4) NOT NULL, `name` VARCHAR(255) NULL, `notes` TEXT NULL, `birth_date` DATE NULL, `enabled` TINYINT(1) NOT NULL, `metadata` JSON NULL, `seen_at` TIMESTAMP(6) NOT NULL, PRIMARY KEY (`id`, `code`))',
  );
  assert.doesNotThrow(() => assertCreateTableSql(statement.sql));
});

test('defensively rejects a value merely cast as normalized input', () => {
  assert.throws(
    () => buildCreateTableStatement({ schema: 'app', table: 'accounts', columns: [], primaryKey: [], reason: 'not valid' } as never),
    /Invalid CREATE TABLE input/,
  );
});

test('accepts builder output at the shared identifier and column bounds', () => {
  const columnName = (index: number): string => `c${String(index).padStart(MAX_CREATE_TABLE_IDENTIFIER_LENGTH - 1, '0')}`;
  const columns = Array.from({ length: MAX_CREATE_TABLE_COLUMNS }, (_, index) => ({
    name: columnName(index),
    type: { kind: 'integer' as const, integerType: 'int' as const },
    nullable: false,
  }));
  const statement = buildCreateTableStatement(
    normalizeCreateTableInput({
      schema: 's'.repeat(MAX_CREATE_TABLE_IDENTIFIER_LENGTH),
      table: 't'.repeat(MAX_CREATE_TABLE_IDENTIFIER_LENGTH),
      reason: 'Exercise the shared CREATE TABLE structural limits.',
      columns,
      primaryKey: columns.map((column) => column.name),
    }),
  );

  assert.doesNotThrow(() => assertCreateTableSql(statement.sql));
});
