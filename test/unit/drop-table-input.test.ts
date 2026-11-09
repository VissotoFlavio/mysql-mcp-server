import assert from 'node:assert/strict';
import test from 'node:test';

import { DropTableInputValidationError, createDropTableConfirmation, normalizeDropTableInput } from '../../src/tools/drop-table-input.js';

const revision = 'a'.repeat(64);
const input = () => ({ schema: 'app', table: 'orders', reason: 'Remove the retired table.', confirmation: createDropTableConfirmation(revision) });

test('normalizes the exact target-bound drop_table contract', () => {
  assert.deepEqual(normalizeDropTableInput({ ...input(), reason: '  Remove the retired table.  ' }), {
    schema: 'app',
    table: 'orders',
    reason: 'Remove the retired table.',
    confirmation: `DROP_TABLE:${revision}`,
  });
});

test('rejects stale-shaped, additional, and unsafe drop_table fields', () => {
  for (const [value, code] of [
    [{ ...input(), confirmation: 'DROP_TABLE' }, 'confirmation_required'],
    [{ ...input(), confirmation: `DROP_TABLE:${revision.toUpperCase()}` }, 'confirmation_required'],
    [{ ...input(), sql: 'DROP TABLE app.orders' }, 'additional_property'],
    [{ ...input(), table: '`orders`' }, 'invalid_identifier'],
    [{ ...input(), reason: '\u0000reason' }, 'control_character'],
  ] as const) {
    assert.throws(
      () => normalizeDropTableInput(value),
      (error: unknown) => {
        assert(error instanceof DropTableInputValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test('builds and validates only a 64-hex metadata revision confirmation', () => {
  assert.equal(createDropTableConfirmation(revision), `DROP_TABLE:${revision}`);
  assert.throws(() => createDropTableConfirmation('short'));
});
