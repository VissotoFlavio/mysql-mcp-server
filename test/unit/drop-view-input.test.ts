import assert from 'node:assert/strict';
import test from 'node:test';

import { DROP_VIEW_CONFIRMATION, DropViewInputValidationError, normalizeDropViewInput } from '../../src/tools/drop-view-input.js';

test('normalizes the exact drop_view contract and trims only the audit reason', () => {
  assert.deepEqual(
    normalizeDropViewInput({
      schema: 'app',
      view: 'account_labels',
      reason: '  Remove the obsolete projection.  ',
      confirmation: DROP_VIEW_CONFIRMATION,
    }),
    { schema: 'app', view: 'account_labels', reason: 'Remove the obsolete projection.', confirmation: DROP_VIEW_CONFIRMATION },
  );
});

test('rejects unconfirmed, additional, and unsafe drop_view fields', () => {
  const base = { schema: 'app', view: 'account_labels', reason: 'Remove it.', confirmation: DROP_VIEW_CONFIRMATION };
  for (const [value, code] of [
    [{ ...base, confirmation: 'DROP VIEW app.account_labels' }, 'confirmation_required'],
    [{ ...base, sql: 'DROP VIEW app.account_labels' }, 'additional_property'],
    [{ ...base, view: '`account_labels`' }, 'invalid_identifier'],
    [{ ...base, reason: '\u0000reason' }, 'control_character'],
  ] as const) {
    assert.throws(
      () => normalizeDropViewInput(value),
      (error: unknown) => {
        assert(error instanceof DropViewInputValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});
