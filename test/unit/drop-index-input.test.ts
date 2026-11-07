import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DropIndexInputValidationError,
  MAX_DROP_INDEX_IDENTIFIER_LENGTH,
  MAX_DROP_INDEX_REASON_LENGTH,
  normalizeDropIndexInput,
} from '../../src/tools/drop-index-input.js';

test('normalizes the exact drop_index contract and trims only the audit reason', () => {
  const input = normalizeDropIndexInput({ schema: 'app', table: 'orders', index: 'orders_created_idx', reason: '  Remove redundancy.  ' });
  assert.deepEqual(input, { schema: 'app', table: 'orders', index: 'orders_created_idx', reason: 'Remove redundancy.' });
  assert.throws(
    () => normalizeDropIndexInput({ ...input, sql: 'DROP INDEX anything' }),
    (error: unknown) => {
      assert(error instanceof DropIndexInputValidationError);
      assert.equal(error.code, 'additional_property');
      return true;
    },
  );
});

test('rejects unbounded or unsafe drop_index fields', () => {
  const base = { schema: 'app', table: 'orders', index: 'orders_idx', reason: 'Remove it.' };
  for (const [value, code] of [
    [{ ...base, index: '' }, 'invalid_value'],
    [{ ...base, table: '`orders`' }, 'invalid_identifier'],
    [{ ...base, reason: '\u0000reason' }, 'control_character'],
    [{ ...base, schema: 'a'.repeat(MAX_DROP_INDEX_IDENTIFIER_LENGTH + 1) }, 'string_too_long'],
    [{ ...base, reason: 'a'.repeat(MAX_DROP_INDEX_REASON_LENGTH + 1) }, 'string_too_long'],
  ] as const) {
    assert.throws(
      () => normalizeDropIndexInput(value),
      (error: unknown) => {
        assert(error instanceof DropIndexInputValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});
