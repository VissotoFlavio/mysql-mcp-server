import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableRenameColumnInputValidationError, normalizeAlterTableRenameColumnInput } from '../../src/tools/alter-table-rename-column-input.js';

test('normalizes the exact rename-column contract', () => {
  assert.deepEqual(
    normalizeAlterTableRenameColumnInput({
      schema: 'app',
      table: 'accounts',
      column: 'nickname',
      newColumn: 'display_name',
      reason: ' Rename account field. ',
    }),
    { schema: 'app', table: 'accounts', column: 'nickname', newColumn: 'display_name', reason: 'Rename account field.' },
  );
});
test('rejects extra, same-name, and unsafe rename-column arguments', () => {
  for (const value of [
    { schema: 'app', table: 'accounts', column: 'nickname', newColumn: 'display_name', reason: 'x', sql: 'DROP TABLE accounts' },
    { schema: 'app', table: 'accounts', column: 'nickname', newColumn: 'nickname', reason: 'x' },
    { schema: 'app', table: 'accounts', column: '`nickname`', newColumn: 'display_name', reason: 'x' },
  ])
    assert.throws(
      () => normalizeAlterTableRenameColumnInput(value),
      (error: unknown) => error instanceof AlterTableRenameColumnInputValidationError,
    );
});
