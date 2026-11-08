import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AlterTableDropForeignKeyInputValidationError,
  normalizeAlterTableDropForeignKeyInput,
} from '../../src/tools/alter-table-drop-foreign-key-input.js';

test('normalizes the exact drop foreign key contract', () => {
  assert.deepEqual(
    normalizeAlterTableDropForeignKeyInput({
      schema: 'app',
      table: 'orders',
      constraint: 'orders_customer_fk',
      reason: '  Remove obsolete relationship.  ',
    }),
    {
      schema: 'app',
      table: 'orders',
      constraint: 'orders_customer_fk',
      reason: 'Remove obsolete relationship.',
    },
  );
  assert.throws(
    () =>
      normalizeAlterTableDropForeignKeyInput({
        schema: 'app',
        table: 'orders',
        constraint: 'orders_customer_fk',
        reason: 'remove',
        sql: 'DROP FOREIGN KEY',
      }),
    (error: unknown) => {
      assert(error instanceof AlterTableDropForeignKeyInputValidationError);
      assert.equal(error.code, 'additional_property');
      return true;
    },
  );
});

test('rejects unsafe identifiers and reasons', () => {
  const base = { schema: 'app', table: 'orders', constraint: 'orders_customer_fk', reason: 'Remove it.' };
  for (const [value, code] of [
    [{ ...base, constraint: '`fk`' }, 'invalid_identifier'],
    [{ ...base, reason: '\u0000reason' }, 'control_character'],
    [{ ...base, reason: '   ' }, 'invalid_value'],
  ] as const) {
    assert.throws(
      () => normalizeAlterTableDropForeignKeyInput(value),
      (error: unknown) => {
        assert(error instanceof AlterTableDropForeignKeyInputValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});
