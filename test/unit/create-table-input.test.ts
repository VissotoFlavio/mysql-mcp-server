import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATE_TABLE_INPUT_JSON_SCHEMA,
  type CreateTableInput,
  CreateTableInputValidationError,
  MAX_CREATE_TABLE_COLUMNS,
  MAX_CREATE_TABLE_NESTING_DEPTH,
  normalizeCreateTableInput,
} from '../../src/tools/create-table-input.js';

function input(): CreateTableInput {
  return {
    schema: 'app',
    table: 'accounts',
    reason: ' create accounts ',
    columns: [
      { name: 'tenant_id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false },
      { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
      { name: 'label', type: { kind: 'varchar', length: 128 }, nullable: true },
    ],
    primaryKey: ['id'],
  };
}
function errorOf(action: () => unknown): CreateTableInputValidationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CreateTableInputValidationError);
    return error;
  }
  assert.fail('Expected CREATE TABLE validation to fail.');
}

test('normalizes all supported structured MySQL 8.4 types without accepting SQL declarations', () => {
  const value = {
    ...input(),
    columns: [
      { name: 'tiny', type: { kind: 'integer', integerType: 'tinyint' }, nullable: false },
      { name: 'small', type: { kind: 'integer', integerType: 'smallint', unsigned: true }, nullable: false },
      { name: 'medium', type: { kind: 'integer', integerType: 'mediumint' }, nullable: false },
      { name: 'plain', type: { kind: 'integer', integerType: 'int' }, nullable: false },
      { name: 'big', type: { kind: 'integer', integerType: 'bigint' }, nullable: false },
      { name: 'amount', type: { kind: 'decimal', precision: 65, scale: 30 }, nullable: false },
      { name: 'fixed', type: { kind: 'char', length: 1 }, nullable: false },
      { name: 'label', type: { kind: 'varchar', length: 255 }, nullable: true },
      { name: 'body', type: { kind: 'text' }, nullable: true },
      { name: 'day', type: { kind: 'date' }, nullable: false },
      { name: 'at_time', type: { kind: 'time', fractionalSecondsPrecision: 0 }, nullable: false },
      { name: 'at', type: { kind: 'datetime', fractionalSecondsPrecision: 6 }, nullable: false },
      { name: 'recorded', type: { kind: 'timestamp' }, nullable: false },
      { name: 'enabled', type: { kind: 'boolean' }, nullable: false },
      { name: 'metadata', type: { kind: 'json' }, nullable: true },
    ],
    primaryKey: ['tiny'],
  };
  const normalized = normalizeCreateTableInput(value);
  assert.equal(normalized.reason, 'create accounts');
  assert.deepEqual(normalized.primaryKey, ['tiny']);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.columns), true);
  assert.equal(Object.isFrozen(normalized.columns[0].type), true);
  assert.equal(
    normalizeCreateTableInput({
      ...input(),
      columns: [{ name: 'id', type: { kind: 'integer', integerType: 'int', unsigned: false }, nullable: false, autoIncrement: false }],
      primaryKey: ['id'],
    }).columns[0].autoIncrement,
    undefined,
  );
  const zero = normalizeCreateTableInput({
    ...input(),
    columns: [{ name: 'amount', type: { kind: 'decimal', precision: 1, scale: -0 }, nullable: false }],
    primaryKey: ['amount'],
  });
  assert.equal(Object.is((zero.columns[0].type as { scale: number }).scale, 0), true);

  assert.equal(errorOf(() => normalizeCreateTableInput('CREATE TABLE accounts (id INT)')).code, 'invalid_type');
  assert.equal(
    errorOf(() => normalizeCreateTableInput({ ...input(), columns: [{ name: 'id', type: 'INT UNSIGNED', nullable: false }], primaryKey: ['id'] }))
      .code,
    'invalid_type',
  );
});

test('rejects unsupported options and enforces precise per-type limits', () => {
  const invalidTypes = [
    { kind: 'integer', integerType: 'integer' },
    { kind: 'integer', integerType: 'int', unsigned: 'true' },
    { kind: 'decimal', precision: 0, scale: 0 },
    { kind: 'decimal', precision: 31, scale: 31 },
    { kind: 'decimal', precision: 3, scale: 2, unsigned: true },
    { kind: 'char', length: 0 },
    { kind: 'varchar', length: 256 },
    { kind: 'date', fractionalSecondsPrecision: 3 },
    { kind: 'time', fractionalSecondsPrecision: 7 },
    { kind: 'boolean', length: 1 },
    { kind: 'json', unsigned: true },
  ];
  for (const type of invalidTypes) {
    const error = errorOf(() => normalizeCreateTableInput({ ...input(), columns: [{ name: 'id', type, nullable: false }], primaryKey: ['id'] }));
    assert.ok(['additional_property', 'invalid_type', 'invalid_value'].includes(error.code));
  }
});

test('requires distinct declared primary-key columns in the received order', () => {
  const value = {
    ...input(),
    primaryKey: ['tenant_id', 'id'],
    columns: input().columns.map((item, index) => ({ ...item, autoIncrement: index === 0 })),
  };
  assert.deepEqual(normalizeCreateTableInput(value).primaryKey, ['tenant_id', 'id']);
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), primaryKey: [] })).code, 'invalid_value');
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), primaryKey: ['id', 'id'] })).code, 'duplicate_primary_key');
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), primaryKey: ['missing'] })).code, 'primary_key_invalid');
  const duplicate = {
    ...input(),
    columns: input().columns.map((item, index) => (index === 2 ? { ...item, name: 'id' } : item)),
  };
  assert.equal(errorOf(() => normalizeCreateTableInput(duplicate)).code, 'duplicate_column');
});

test('allows at most one valid AUTO_INCREMENT column', () => {
  const composite = { ...input(), primaryKey: ['tenant_id', 'id'] };
  assert.equal(errorOf(() => normalizeCreateTableInput(composite)).code, 'auto_increment_invalid');
  assert.equal(
    errorOf(() =>
      normalizeCreateTableInput({
        ...input(),
        columns: [{ name: 'id', type: { kind: 'decimal', precision: 10, scale: 0 }, nullable: false, autoIncrement: true }],
        primaryKey: ['id'],
      }),
    ).code,
    'auto_increment_invalid',
  );
  assert.equal(
    errorOf(() =>
      normalizeCreateTableInput({
        ...input(),
        columns: [{ name: 'id', type: { kind: 'integer', integerType: 'int' }, nullable: true, autoIncrement: true }],
        primaryKey: ['id'],
      }),
    ).code,
    'auto_increment_invalid',
  );
  const multiple = { ...input(), columns: input().columns.map((item, index) => ({ ...item, autoIncrement: index < 2 })) };
  assert.equal(errorOf(() => normalizeCreateTableInput(multiple)).code, 'auto_increment_invalid');
});

test('uses only safe own data with strict root and identifier validation', () => {
  const tooMany = Array.from({ length: MAX_CREATE_TABLE_COLUMNS + 1 }, (_, index) => ({
    name: `c${index}`,
    type: { kind: 'boolean' },
    nullable: false,
  }));
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), columns: tooMany, primaryKey: ['c0'] })).code, 'column_limit_exceeded');
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), table: '`accounts`' })).code, 'invalid_identifier');
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), table: 'accounts\u0000hidden' })).code, 'control_character');
  assert.equal(errorOf(() => normalizeCreateTableInput({ ...input(), extra: true })).code, 'additional_property');
  const accessor = input() as Record<string, unknown>;
  Object.defineProperty(accessor, 'schema', { enumerable: true, get: () => 'app' });
  assert.equal(errorOf(() => normalizeCreateTableInput(accessor)).code, 'invalid_payload');
  const sparseColumns = [] as unknown[];
  sparseColumns.length = 1;
  const sparse = { ...input(), columns: sparseColumns };
  assert.equal(errorOf(() => normalizeCreateTableInput(sparse)).code, 'invalid_payload');

  let deeplyNested: unknown = {};
  for (let index = 0; index <= MAX_CREATE_TABLE_NESTING_DEPTH; index += 1) deeplyNested = { nested: deeplyNested };
  assert.equal(
    errorOf(() =>
      normalizeCreateTableInput({
        ...input(),
        columns: [{ name: 'id', type: { kind: 'integer', integerType: 'int', nested: deeplyNested }, nullable: false }],
        primaryKey: ['id'],
      }),
    ).code,
    'invalid_payload',
  );

  let deeplyNestedArray: unknown = [];
  for (let index = 0; index <= MAX_CREATE_TABLE_NESTING_DEPTH; index += 1) deeplyNestedArray = [deeplyNestedArray];
  assert.equal(
    errorOf(() =>
      normalizeCreateTableInput({
        ...input(),
        columns: [{ name: 'id', type: { kind: 'integer', integerType: 'int', nested: deeplyNestedArray }, nullable: false }],
        primaryKey: ['id'],
      }),
    ).code,
    'invalid_payload',
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(
    errorOf(() =>
      normalizeCreateTableInput({
        ...input(),
        columns: [{ name: 'id', type: { kind: 'integer', integerType: 'int', nested: cyclic }, nullable: false }],
        primaryKey: ['id'],
      }),
    ).code,
    'invalid_payload',
  );
});

test('publishes an exact JSON-schema-compatible contract', () => {
  const schema = CREATE_TABLE_INPUT_JSON_SCHEMA();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema', 'table', 'columns', 'primaryKey', 'reason']);
  const columns = (schema.properties as Record<string, Record<string, unknown>>).columns;
  assert.equal(columns.maxItems, MAX_CREATE_TABLE_COLUMNS);
  assert.equal((columns.items as Record<string, unknown>).additionalProperties, false);
  assert.equal(columns.minContains, 0);
  assert.equal(columns.maxContains, 1);
  const itemSchema = columns.items as Record<string, unknown>;
  const autoIncrementRule = ((itemSchema.allOf as Record<string, unknown>[])[0].then as Record<string, Record<string, unknown>>).properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(autoIncrementRule.nullable.const, false);
  assert.equal((autoIncrementRule.type.properties as Record<string, Record<string, unknown>>).kind.const, 'integer');
  const type = (itemSchema.properties as Record<string, Record<string, unknown>>).type;
  const decimal = (type.oneOf as Record<string, unknown>[])[1];
  const decimalScale = ((decimal.allOf as unknown[])[0] as Record<string, unknown>).oneOf as Record<string, unknown>[];
  const firstScale = decimalScale[0].properties as Record<string, Record<string, unknown>>;
  const lastScale = decimalScale[64].properties as Record<string, Record<string, unknown>>;
  assert.equal(firstScale.precision.const, 1);
  assert.equal(firstScale.scale.maximum, 1);
  assert.equal(lastScale.precision.const, 65);
  assert.equal(lastScale.scale.maximum, 30);
  assert.equal((schema.properties as Record<string, Record<string, unknown>>).primaryKey.uniqueItems, true);
});
