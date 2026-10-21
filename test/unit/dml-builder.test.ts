import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DML_FILTER_IN_VALUES, MAX_DML_FILTERS, MAX_DML_LIMIT, buildDeleteStatement, buildUpdateStatement } from '../../src/db/dml-builder.js';
import { DmlInputValidationError, MAX_DML_COLUMNS, MAX_DML_PARAMETERS } from '../../src/tools/dml-input.js';

const target = Object.freeze({ schema: 'app`schema', table: 'user`profiles', reason: 'controlled update' });
const columns = Object.freeze(['id', 'tenant_id', 'name', 'active', 'deleted_at', 'score', 'role']);
const primaryKey = Object.freeze(['tenant_id', 'id']);

function update(overrides: Record<string, unknown> = {}) {
  return {
    target,
    values: { name: 'Ada' },
    filters: [{ column: 'id', operator: 'eq', value: 7 }],
    limit: 1,
    columns,
    primaryKey,
    ...overrides,
  } as unknown as Parameters<typeof buildUpdateStatement>[0];
}

function deletion(overrides: Record<string, unknown> = {}) {
  return {
    target,
    filters: [{ column: 'id', operator: 'eq', value: 7 }],
    limit: 1,
    columns,
    primaryKey,
    ...overrides,
  } as unknown as Parameters<typeof buildDeleteStatement>[0];
}

function errorOf(action: () => unknown): DmlInputValidationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof DmlInputValidationError);
    return error;
  }
  assert.fail('Expected a DML validation error.');
}

test('builds deterministic UPDATE SQL with escaped identifiers and SET values before filters', () => {
  const statement = buildUpdateStatement(
    update({
      values: { role: 'member', name: 'Ada' },
      filters: [
        { column: 'id', operator: 'gte', value: 7 },
        { column: 'active', operator: 'eq', value: true },
      ],
      limit: 10,
    }),
  );

  assert.equal(
    statement.sql,
    'UPDATE `app``schema`.`user``profiles` SET `name` = ?, `role` = ? WHERE `id` >= ? AND `active` = ? ORDER BY `tenant_id` ASC, `id` ASC LIMIT 10',
  );
  assert.deepEqual(statement.values, ['Ada', 'member', 7, true]);
  assert.ok(Object.isFrozen(statement));
  assert.ok(Object.isFrozen(statement.values));
});

test('builds DELETE SQL using every primary-key column in received order', () => {
  const statement = buildDeleteStatement(
    deletion({ filters: [{ column: 'tenant_id', operator: 'eq', value: 'acme' }], primaryKey: ['id', 'tenant_id'], limit: MAX_DML_LIMIT }),
  );

  assert.equal(
    statement.sql,
    `DELETE FROM \`app\`\`schema\`.\`user\`\`profiles\` WHERE \`tenant_id\` = ? ORDER BY \`id\` ASC, \`tenant_id\` ASC LIMIT ${MAX_DML_LIMIT}`,
  );
  assert.deepEqual(statement.values, ['acme']);
});

test('compiles each supported predicate with AND while keeping values parameterized', () => {
  const operators = [
    { column: 'id', operator: 'eq', value: 1 },
    { column: 'id', operator: 'neq', value: 2 },
    { column: 'score', operator: 'gt', value: 3 },
    { column: 'score', operator: 'gte', value: 4 },
    { column: 'score', operator: 'lt', value: 5 },
    { column: 'score', operator: 'lte', value: 6 },
    { column: 'role', operator: 'in', values: ['member', 'admin'] },
    { column: 'deleted_at', operator: 'is_null' },
    { column: 'name', operator: 'is_not_null' },
  ];
  const statement = buildDeleteStatement(deletion({ filters: operators }));

  assert.equal(
    statement.sql,
    'DELETE FROM `app``schema`.`user``profiles` WHERE `id` = ? AND `id` <> ? AND `score` > ? AND `score` >= ? AND `score` < ? AND `score` <= ? AND `role` IN (?, ?) AND `deleted_at` IS NULL AND `name` IS NOT NULL ORDER BY `tenant_id` ASC, `id` ASC LIMIT 1',
  );
  assert.deepEqual(statement.values, [1, 2, 3, 4, 5, 6, 'member', 'admin']);
});

test('keeps malicious values out of SQL text', () => {
  const malicious = "x' OR 1=1; DELETE FROM users --";
  const statement = buildUpdateStatement(update({ values: { name: malicious }, filters: [{ column: 'role', operator: 'in', values: [malicious] }] }));

  assert.doesNotMatch(statement.sql, /DELETE FROM users|1=1|x'/);
  assert.deepEqual(statement.values, [malicious, malicious]);
});

test('rejects unsafe or ambiguous filter shapes and invalid limits', () => {
  const invalidFilters = [
    [],
    [{ column: 'unknown', operator: 'eq', value: 1 }],
    [{ column: 'id', operator: 'eq', value: null }],
    [{ column: 'id', operator: 'in', values: [] }],
    [{ column: 'id', operator: 'in', values: new Array(MAX_DML_FILTER_IN_VALUES + 1) }],
    [{ column: 'id', operator: 'like', value: '1%' }],
    [{ column: 'id', operator: 'toString', value: 1 }],
  ];

  for (const filters of invalidFilters) {
    assert.equal(errorOf(() => buildDeleteStatement(deletion({ filters }))).code, 'invalid_value');
  }
  for (const limit of [0, MAX_DML_LIMIT + 1, 1.5, Number.NaN]) {
    assert.equal(errorOf(() => buildDeleteStatement(deletion({ limit }))).code, 'invalid_value');
  }
  assert.equal(
    errorOf(() => buildDeleteStatement(deletion({ filters: [{ column: 'id', operator: 'is_null', value: 1 }] }))).code,
    'additional_property',
  );
  assert.equal(
    errorOf(() => buildDeleteStatement(deletion({ filters: [{ column: 'id', operator: 'eq', value: 1, extra: 'no' }] }))).code,
    'additional_property',
  );
});

test('rejects unknown SET columns, incomplete primary keys, and additional request fields', () => {
  assert.equal(errorOf(() => buildUpdateStatement(update({ values: { unknown: 'no' } }))).code, 'invalid_value');
  assert.equal(errorOf(() => buildDeleteStatement(deletion({ primaryKey: [] }))).code, 'invalid_value');
  assert.equal(
    errorOf(() => buildDeleteStatement({ ...deletion(), extra: 'no' } as unknown as Parameters<typeof buildDeleteStatement>[0])).code,
    'additional_property',
  );
});

test('rejects structural filter and IN limits before producing a statement', () => {
  const nullFilters = Array.from({ length: MAX_DML_FILTERS + 1 }, () => ({ column: 'deleted_at', operator: 'is_null' }));
  assert.equal(errorOf(() => buildDeleteStatement(deletion({ filters: nullFilters }))).code, 'invalid_value');

  const oversizedIn = new Array(MAX_DML_FILTER_IN_VALUES + 1);
  assert.equal(
    errorOf(() => buildDeleteStatement(deletion({ filters: [{ column: 'id', operator: 'in', values: oversizedIn }] }))).code,
    'invalid_value',
  );
});

test('rejects oversized sparse catalog and primary-key arrays before enumerating their keys', () => {
  const oversizedSparseArray = new Proxy(new Array(MAX_DML_COLUMNS + 1), {
    ownKeys() {
      throw new Error('must not enumerate an oversized array');
    },
  });

  assert.equal(errorOf(() => buildDeleteStatement(deletion({ columns: oversizedSparseArray }))).code, 'invalid_value');
  assert.equal(errorOf(() => buildDeleteStatement(deletion({ primaryKey: oversizedSparseArray }))).code, 'invalid_value');
});

test('rejects parameter totals during normalization before producing a statement', () => {
  const filterCount = Math.floor(MAX_DML_PARAMETERS / MAX_DML_FILTER_IN_VALUES) + 1;
  const parameterFilters = Array.from({ length: filterCount }, () => ({
    column: 'id',
    operator: 'in',
    values: Array.from({ length: MAX_DML_FILTER_IN_VALUES }, () => 1),
  }));

  assert.equal(errorOf(() => buildDeleteStatement(deletion({ filters: parameterFilters }))).code, 'parameter_limit_exceeded');
});

test('rejects UPDATE SET and filter values totaling 1,001 parameters before producing a statement', () => {
  const updateColumns = Array.from({ length: MAX_DML_COLUMNS }, (_, index) => `column_${index}`);
  const setValues = Object.fromEntries(updateColumns.map((column, index) => [column, index]));
  const remainingParameters = MAX_DML_PARAMETERS - MAX_DML_COLUMNS + 1;
  const completeInFilters = Math.floor(remainingParameters / MAX_DML_FILTER_IN_VALUES);
  const finalInLength = remainingParameters % MAX_DML_FILTER_IN_VALUES;
  const filters = Array.from({ length: completeInFilters }, () => ({
    column: 'column_0',
    operator: 'in',
    values: Array.from({ length: MAX_DML_FILTER_IN_VALUES }, () => 1),
  }));
  if (finalInLength > 0) {
    filters.push({ column: 'column_0', operator: 'in', values: Array.from({ length: finalInLength }, () => 1) });
  }

  assert.equal(
    errorOf(() => buildUpdateStatement(update({ columns: updateColumns, primaryKey: ['column_0'], values: setValues, filters }))).code,
    'parameter_limit_exceeded',
  );
});
