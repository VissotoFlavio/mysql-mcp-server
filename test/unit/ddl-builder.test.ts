import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAlterTableAddColumnStatement,
  buildAlterTableAddForeignKeyStatement,
  buildAlterTableModifyColumnStatement,
  buildAlterTableRenameColumnStatement,
  buildCreateIndexStatement,
  buildCreateTableStatement,
  buildCreateUniqueIndexStatement,
} from '../../src/db/ddl-builder.js';
import {
  assertAlterTableAddColumnSql,
  assertAlterTableAddForeignKeySql,
  assertAlterTableModifyColumnSql,
  assertAlterTableRenameColumnSql,
  assertCreateIndexSql,
  assertCreateTableSql,
  assertCreateUniqueIndexSql,
} from '../../src/db/sql-policy.js';
import { normalizeAlterTableAddColumnInput } from '../../src/tools/alter-table-add-column-input.js';
import { normalizeAlterTableModifyColumnInput } from '../../src/tools/alter-table-modify-column-input.js';
import { normalizeCreateIndexInput } from '../../src/tools/create-index-input.js';
import { MAX_CREATE_TABLE_COLUMNS, MAX_CREATE_TABLE_IDENTIFIER_LENGTH, normalizeCreateTableInput } from '../../src/tools/create-table-input.js';

test('renders only canonical plain CREATE INDEX SQL', () => {
  const statement = buildCreateIndexStatement(
    normalizeCreateIndexInput({
      schema: 'app',
      table: 'orders',
      index: 'orders_created_idx',
      columns: ['tenant_id', 'created_at'],
      reason: 'Support ordered lookups.',
    }),
  );
  assert.equal(statement.sql, 'CREATE INDEX `orders_created_idx` ON `app`.`orders` (`tenant_id`, `created_at`)');
  assert.doesNotThrow(() => assertCreateIndexSql(statement.sql));
  for (const sql of [
    'CREATE UNIQUE INDEX `x` ON `app`.`orders` (`id`)',
    'CREATE INDEX `x` ON `app`.`orders` (`id` DESC)',
    'CREATE INDEX `x` ON `app`.`orders` (`id`) ALGORITHM=INPLACE',
  ])
    assert.throws(() => assertCreateIndexSql(sql));
});

test('renders only canonical plain CREATE UNIQUE INDEX SQL', () => {
  const statement = buildCreateUniqueIndexStatement({
    schema: 'app',
    table: 'orders',
    index: 'orders_tenant_created_uq',
    columns: ['tenant_id', 'created_at'],
    reason: 'Prevent duplicate events.',
  });
  assert.equal(statement.sql, 'CREATE UNIQUE INDEX `orders_tenant_created_uq` ON `app`.`orders` (`tenant_id`, `created_at`)');
  assert.doesNotThrow(() => assertCreateUniqueIndexSql(statement.sql));
  for (const sql of [
    'CREATE INDEX `x` ON `app`.`orders` (`id`)',
    'CREATE UNIQUE INDEX `x` ON `app`.`orders` (`id` DESC)',
    'CREATE UNIQUE INDEX `x` ON `app`.`orders` (`id`) ALGORITHM=INPLACE',
  ])
    assert.throws(() => assertCreateUniqueIndexSql(sql));
});

test('renders only a canonical nullable ALTER TABLE ADD COLUMN statement', () => {
  const statement = buildAlterTableAddColumnStatement(
    normalizeAlterTableAddColumnInput({
      schema: 'app',
      table: 'accounts',
      column: { name: 'nickname', type: { kind: 'varchar', length: 100 }, nullable: true },
      reason: 'Add an optional profile nickname.',
    }),
  );
  assert.equal(statement.sql, 'ALTER TABLE `app`.`accounts` ADD COLUMN `nickname` VARCHAR(100) NULL');
  assert.doesNotThrow(() => assertAlterTableAddColumnSql(statement.sql));
  for (const sql of [
    'ALTER TABLE `app`.`accounts` ADD COLUMN `nickname` VARCHAR(100) NOT NULL',
    "ALTER TABLE `app`.`accounts` ADD COLUMN `nickname` VARCHAR(100) NULL DEFAULT 'anonymous'",
    'ALTER TABLE `app`.`accounts` ADD COLUMN `nickname` VARCHAR(100) NULL FIRST',
    'ALTER TABLE `app`.`accounts` ADD COLUMN `nickname` VARCHAR(100) NULL, ADD COLUMN `other` INT NULL',
  ])
    assert.throws(() => assertAlterTableAddColumnSql(sql));
});

test('renders only a canonical ALTER TABLE RENAME COLUMN statement', () => {
  const statement = buildAlterTableRenameColumnStatement({
    schema: 'app',
    table: 'accounts',
    column: 'nickname',
    newColumn: 'display_name',
    reason: 'Clarify the account field.',
  });
  assert.equal(statement.sql, 'ALTER TABLE `app`.`accounts` RENAME COLUMN `nickname` TO `display_name`');
  assert.doesNotThrow(() => assertAlterTableRenameColumnSql(statement.sql));
  for (const sql of [
    'ALTER TABLE `app`.`accounts` RENAME COLUMN `nickname` TO `nickname`',
    'ALTER TABLE `app`.`accounts` RENAME `nickname` TO `display_name`',
    'ALTER TABLE `app`.`accounts` RENAME COLUMN `nickname` TO `display_name`, RENAME COLUMN `email` TO `address`',
  ])
    assert.throws(() => assertAlterTableRenameColumnSql(sql));
});

test('renders only a canonical ALTER TABLE MODIFY COLUMN statement', () => {
  const statement = buildAlterTableModifyColumnStatement(
    normalizeAlterTableModifyColumnInput({
      schema: 'app',
      table: 'accounts',
      column: 'account_id',
      definition: { name: 'account_id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false },
      reason: 'Widen the account identifier.',
    }),
  );
  assert.equal(statement.sql, 'ALTER TABLE `app`.`accounts` MODIFY COLUMN `account_id` BIGINT UNSIGNED NOT NULL');
  assert.doesNotThrow(() => assertAlterTableModifyColumnSql(statement.sql));
  for (const sql of [
    'ALTER TABLE `app`.`accounts` MODIFY COLUMN `account_id` BIGINT UNSIGNED NULL DEFAULT 0',
    'ALTER TABLE `app`.`accounts` MODIFY COLUMN `account_id` BIGINT UNSIGNED NOT NULL AFTER `other`',
    'ALTER TABLE `app`.`accounts` MODIFY COLUMN `account_id` BIGINT UNSIGNED NOT NULL, MODIFY COLUMN `name` TEXT NULL',
  ])
    assert.throws(() => assertAlterTableModifyColumnSql(sql));
});

test('preserves a structured text column character set and collation', () => {
  const statement = buildAlterTableModifyColumnStatement(
    normalizeAlterTableModifyColumnInput({
      schema: 'app',
      table: 'accounts',
      column: 'display_name',
      definition: {
        name: 'display_name',
        type: { kind: 'varchar', length: 200 },
        nullable: false,
        characterSet: 'utf8mb4',
        collation: 'utf8mb4_bin',
      },
      reason: 'Widen the display name without changing comparison semantics.',
    }),
  );
  assert.equal(
    statement.sql,
    'ALTER TABLE `app`.`accounts` MODIFY COLUMN `display_name` VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
  );
  assert.doesNotThrow(() => assertAlterTableModifyColumnSql(statement.sql));
});

test('renders only a canonical intra-schema ALTER TABLE ADD CONSTRAINT FOREIGN KEY statement', () => {
  const statement = buildAlterTableAddForeignKeyStatement({
    schema: 'app',
    table: 'orders',
    constraint: 'orders_customer_fk',
    columns: ['customer_id'],
    referencedTable: 'customers',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
    reason: 'Keep orders valid.',
  });
  assert.equal(
    statement.sql,
    'ALTER TABLE `app`.`orders` ADD CONSTRAINT `orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `app`.`customers` (`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
  );
  assert.doesNotThrow(() => assertAlterTableAddForeignKeySql(statement.sql));
  for (const sql of [
    'ALTER TABLE `app`.`orders` ADD CONSTRAINT `fk` FOREIGN KEY (`customer_id`) REFERENCES `other`.`customers` (`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    'ALTER TABLE `app`.`orders` ADD CONSTRAINT `fk` FOREIGN KEY (`customer_id`) REFERENCES `app`.`customers` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
    'ALTER TABLE `app`.`orders` ADD CONSTRAINT `fk` FOREIGN KEY (`customer_id`) REFERENCES `app`.`customers` (`id`) ON DELETE RESTRICT ON UPDATE SET NULL',
  ])
    assert.throws(() => assertAlterTableAddForeignKeySql(sql));
});

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
