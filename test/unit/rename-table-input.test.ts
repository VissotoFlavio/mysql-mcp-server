import assert from 'node:assert/strict';
import test from 'node:test';

import { RenameTableInputValidationError, normalizeRenameTableInput } from '../../src/tools/rename-table-input.js';

test('normalizes the exact rename_table contract', () => {
  assert.deepEqual(normalizeRenameTableInput({ schema: 'app', table: 'accounts', newTable: 'customers', reason: ' Rename the account table. ' }), {
    schema: 'app',
    table: 'accounts',
    newTable: 'customers',
    reason: 'Rename the account table.',
  });
});

test('rejects extra, same-name, unsafe, and oversized rename_table arguments', () => {
  for (const value of [
    { schema: 'app', table: 'accounts', newTable: 'customers', reason: 'x', sql: 'DROP TABLE accounts' },
    { schema: 'app', table: 'accounts', newTable: 'ACCOUNTS', reason: 'x' },
    { schema: 'app', table: '`accounts`', newTable: 'customers', reason: 'x' },
    { schema: 'app', table: 'accounts', newTable: 'customers', reason: '   ' },
  ]) {
    assert.throws(
      () => normalizeRenameTableInput(value),
      (error: unknown) => error instanceof RenameTableInputValidationError,
    );
  }
});
