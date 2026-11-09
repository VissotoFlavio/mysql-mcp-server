import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableDropColumnInputValidationError, normalizeAlterTableDropColumnInput } from '../../src/tools/alter-table-drop-column-input.js';

test('normalizes the exact DROP COLUMN contract', () => {
  assert.deepEqual(
    normalizeAlterTableDropColumnInput({
      schema: 'app',
      table: 'orders',
      column: 'obsolete_label',
      reason: '  Remove the obsolete label.  ',
      confirmation: 'DROP_COLUMN',
    }),
    { schema: 'app', table: 'orders', column: 'obsolete_label', reason: 'Remove the obsolete label.', confirmation: 'DROP_COLUMN' },
  );
});

test('rejects unconfirmed, extended, unsafe, and mutable payloads', () => {
  const base = { schema: 'app', table: 'orders', column: 'obsolete_label', reason: 'Remove it.', confirmation: 'DROP_COLUMN' };
  for (const [value, code] of [
    [{ ...base, confirmation: 'drop_column' }, 'confirmation_required'],
    [{ ...base, sql: 'DROP COLUMN' }, 'additional_property'],
    [{ ...base, column: '`label`' }, 'invalid_identifier'],
    [{ ...base, reason: '\u0000reason' }, 'control_character'],
    [{ ...base, reason: '   ' }, 'invalid_value'],
  ] as const) {
    assert.throws(
      () => normalizeAlterTableDropColumnInput(value),
      (error: unknown) => {
        assert(error instanceof AlterTableDropColumnInputValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
  const input = { ...base };
  const normalized = normalizeAlterTableDropColumnInput(input);
  input.column = 'changed';
  assert.equal(normalized.column, 'obsolete_label');
});
