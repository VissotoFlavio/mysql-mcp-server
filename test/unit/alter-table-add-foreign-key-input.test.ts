import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AlterTableAddForeignKeyInputValidationError,
  alterTableAddForeignKeyInputJsonSchema,
  normalizeAlterTableAddForeignKeyInput,
} from '../../src/tools/alter-table-add-foreign-key-input.js';

function request() {
  return {
    schema: 'app',
    table: 'orders',
    constraint: 'orders_customer_fk',
    columns: ['customer_id'],
    referencedTable: 'customers',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT' as const,
    onUpdate: 'NO ACTION' as const,
    reason: 'Keep orders associated with existing customers.',
  };
}

test('normalizes the bounded intra-schema foreign-key contract', () => {
  const normalized = normalizeAlterTableAddForeignKeyInput(request());
  assert.deepEqual(normalized, request());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.columns), true);
  assert.equal(Object.isFrozen(normalized.referencedColumns), true);
  assert.deepEqual((alterTableAddForeignKeyInputJsonSchema().properties as Record<string, unknown>).onDelete, { enum: ['RESTRICT', 'NO ACTION'] });
});

test('rejects implicit actions, cross-schema fields, repeated columns, and cardinality changes before driver access', () => {
  for (const [value, code, path] of [
    [{ ...request(), onDelete: 'CASCADE' }, 'invalid_action', 'input.onDelete'],
    [{ ...request(), onUpdate: 'SET NULL' }, 'invalid_action', 'input.onUpdate'],
    [{ ...request(), referencedSchema: 'other' }, 'additional_property', 'input'],
    [{ ...request(), columns: ['customer_id', 'customer_id'], referencedColumns: ['id', 'region_id'] }, 'duplicate_column', 'input.columns'],
    [{ ...request(), referencedColumns: ['id', 'region_id'] }, 'column_count_mismatch', 'input.referencedColumns'],
    [{ ...request(), reason: '  ' }, 'invalid_value', 'input.reason'],
  ] as const) {
    assert.throws(
      () => normalizeAlterTableAddForeignKeyInput(value),
      (error: unknown) => error instanceof AlterTableAddForeignKeyInputValidationError && error.code === code && error.path === path,
    );
  }
});
