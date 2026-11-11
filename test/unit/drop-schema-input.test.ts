import assert from 'node:assert/strict';
import test from 'node:test';

import { DropSchemaInputValidationError, createDropSchemaConfirmation, normalizeDropSchemaInput } from '../../src/tools/drop-schema-input.js';

const revision = 'a'.repeat(64);

test('supports a reasoned preflight and an exact target-bound confirmation', () => {
  assert.deepEqual(normalizeDropSchemaInput({ schema: 'isolated', reason: '  Retire the isolated catalog.  ' }), {
    schema: 'isolated',
    reason: 'Retire the isolated catalog.',
  });
  assert.deepEqual(normalizeDropSchemaInput({ schema: 'isolated', reason: 'Retire it.', confirmation: createDropSchemaConfirmation(revision) }), {
    schema: 'isolated',
    reason: 'Retire it.',
    confirmation: `DROP_SCHEMA:${revision}`,
  });
});

test('rejects SQL-shaped, forged, and additional drop_schema input', () => {
  for (const [value, code] of [
    [{ schema: 'isolated', reason: 'x', confirmation: 'DROP_SCHEMA' }, 'confirmation_required'],
    [{ schema: 'isolated', reason: 'x', confirmation: `DROP_SCHEMA:${revision.toUpperCase()}` }, 'confirmation_required'],
    [{ schema: 'isolated', reason: 'x', sql: 'DROP SCHEMA isolated' }, 'additional_property'],
    [{ schema: '`isolated`', reason: 'x' }, 'invalid_identifier'],
  ] as const) {
    assert.throws(
      () => normalizeDropSchemaInput(value),
      (error: unknown) => error instanceof DropSchemaInputValidationError && error.code === code,
    );
  }
  assert.throws(() => createDropSchemaConfirmation('short'));
});
