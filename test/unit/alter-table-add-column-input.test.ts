import assert from 'node:assert/strict';
import test from 'node:test';

import { AlterTableAddColumnInputValidationError, normalizeAlterTableAddColumnInput } from '../../src/tools/alter-table-add-column-input.js';

function request() {
  return {
    schema: 'app',
    table: 'accounts',
    column: { name: 'nickname', type: { kind: 'varchar' as const, length: 100 }, nullable: true },
    reason: 'Add an optional nickname for the account profile.',
  };
}

test('normalizes one nullable structured column using the CREATE TABLE type subset', () => {
  const normalized = normalizeAlterTableAddColumnInput(request());
  assert.deepEqual(normalized, request());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.column), true);
});

test('rejects a non-nullable or expanded ALTER TABLE surface before driver access', () => {
  for (const [value, code, path] of [
    [{ ...request(), column: { ...request().column, nullable: false } }, 'column_not_nullable', 'input.column.nullable'],
    [{ ...request(), column: { ...request().column, autoIncrement: false } }, 'additional_property', 'input.column'],
    [{ ...request(), column: { ...request().column, default: 'anonymous' } }, 'additional_property', 'input.column'],
    [{ ...request(), column: { ...request().column, generated: 'LOWER(nickname)' } }, 'additional_property', 'input.column'],
    [{ ...request(), column: { ...request().column, after: 'id' } }, 'additional_property', 'input.column'],
    [{ ...request(), algorithm: 'INPLACE' }, 'additional_property', 'input'],
  ] as const) {
    assert.throws(
      () => normalizeAlterTableAddColumnInput(value),
      (error: unknown) => error instanceof AlterTableAddColumnInputValidationError && error.code === code && error.path === path,
    );
  }
});
