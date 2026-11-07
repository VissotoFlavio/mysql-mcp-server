import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AlterTableModifyColumnInputValidationError,
  alterTableModifyColumnInputJsonSchema,
  normalizeAlterTableModifyColumnInput,
} from '../../src/tools/alter-table-modify-column-input.js';

const valid = {
  schema: 'app',
  table: 'accounts',
  column: 'account_id',
  definition: { name: 'account_id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false },
  reason: 'Widen the account identifier.',
};

test('normalizes an immutable fully structured target definition', () => {
  const normalized = normalizeAlterTableModifyColumnInput(valid);
  assert.deepEqual(normalized, valid);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.definition), true);
});

test('requires the target definition to preserve the source name', () => {
  assert.throws(
    () => normalizeAlterTableModifyColumnInput({ ...valid, definition: { ...valid.definition, name: 'other_id' } }),
    (error: unknown) => error instanceof AlterTableModifyColumnInputValidationError && error.code === 'column_name_mismatch',
  );
});

test('rejects SQL-shaped options, missing fields, and malformed target definitions', () => {
  for (const value of [
    { ...valid, sql: 'ALTER TABLE accounts MODIFY COLUMN account_id BIGINT' },
    { ...valid, definition: { ...valid.definition, default: '1' } },
    { ...valid, definition: { ...valid.definition, type: 'BIGINT UNSIGNED' } },
    { ...valid, definition: { ...valid.definition, nullable: 'NO' } },
    { ...valid, reason: '   ' },
  ]) {
    assert.throws(() => normalizeAlterTableModifyColumnInput(value), AlterTableModifyColumnInputValidationError);
  }
});

test('publishes the bounded structured JSON schema', () => {
  const schema = alterTableModifyColumnInputJsonSchema();
  assert.deepEqual(schema.required, ['schema', 'table', 'column', 'definition', 'reason']);
  assert.equal(schema.additionalProperties, false);
  const definition = (schema.properties as Record<string, Record<string, unknown>>).definition;
  assert.equal(definition.additionalProperties, false);
  assert.deepEqual(definition.required, ['name', 'type', 'nullable']);
});
