import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TruncateTableInputValidationError,
  createTruncateTableConfirmation,
  normalizeTruncateTableInput,
} from '../../src/tools/truncate-table-input.js';

const revision = 'a'.repeat(64);
const input = () => ({ schema: 'app', table: 'orders', reason: 'Clear the staging rows.', confirmation: createTruncateTableConfirmation(revision) });

test('normalizes the exact target-bound truncate_table contract', () => {
  assert.deepEqual(normalizeTruncateTableInput({ ...input(), reason: '  Clear the staging rows.  ' }), {
    schema: 'app',
    table: 'orders',
    reason: 'Clear the staging rows.',
    confirmation: `TRUNCATE_TABLE:${revision}`,
  });
});

test('rejects stale-shaped, additional, unsafe, and arbitrary SQL fields', () => {
  for (const [value, code] of [
    [{ ...input(), confirmation: 'TRUNCATE_TABLE' }, 'confirmation_required'],
    [{ ...input(), confirmation: `TRUNCATE_TABLE:${revision.toUpperCase()}` }, 'confirmation_required'],
    [{ ...input(), sql: 'TRUNCATE TABLE app.orders' }, 'additional_property'],
    [{ ...input(), filters: [] }, 'additional_property'],
    [{ ...input(), table: '`orders`' }, 'invalid_identifier'],
    [{ ...input(), reason: '\u0000reason' }, 'control_character'],
  ] as const) {
    assert.throws(
      () => normalizeTruncateTableInput(value),
      (error: unknown) => {
        assert(error instanceof TruncateTableInputValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test('builds only a distinct 64-hex TRUNCATE_TABLE confirmation', () => {
  assert.equal(createTruncateTableConfirmation(revision), `TRUNCATE_TABLE:${revision}`);
  assert.throws(() => createTruncateTableConfirmation('short'));
});
