import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  CreateIndexInputValidationError,
  MAX_CREATE_INDEX_COLUMNS,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_REASON_LENGTH,
  createIndexInputJsonSchema,
  normalizeCreateIndexInput,
} from '../../src/tools/create-index-input.js';

function input(override: Record<string, unknown> = {}) {
  return {
    schema: 'app',
    table: 'orders',
    index: 'orders_created_at_idx',
    columns: ['created_at'],
    reason: 'Support recent-order lookups.',
    ...override,
  };
}

function errorOf(callback: () => unknown): CreateIndexInputValidationError {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof CreateIndexInputValidationError);
    return error as CreateIndexInputValidationError;
  }
  throw new Error('Expected an input validation error.');
}

test('normalizes the exact CREATE INDEX request shape deterministically', () => {
  const normalized = normalizeCreateIndexInput(input({ columns: ['tenant_id', 'created_at'], reason: '  Support tenant history.  ' }));
  assert.deepEqual(normalized, {
    schema: 'app',
    table: 'orders',
    index: 'orders_created_at_idx',
    columns: ['tenant_id', 'created_at'],
    reason: 'Support tenant history.',
  });
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.columns));
});

test('enforces identifiers, columns, and audit-reason bounds before database access', () => {
  const identifier = 'x'.repeat(MAX_CREATE_INDEX_IDENTIFIER_LENGTH);
  assert.equal(
    normalizeCreateIndexInput(input({ schema: identifier, table: identifier, index: identifier, columns: [identifier] })).index,
    identifier,
  );
  const reason = 'x'.repeat(MAX_CREATE_INDEX_REASON_LENGTH);
  assert.equal(normalizeCreateIndexInput(input({ reason })).reason, reason);
  assert.equal(
    normalizeCreateIndexInput(input({ columns: Array.from({ length: MAX_CREATE_INDEX_COLUMNS }, (_, index) => `c${index}`) })).columns.length,
    MAX_CREATE_INDEX_COLUMNS,
  );

  for (const [candidate, code] of [
    [input({ schema: '' }), 'invalid_value'],
    [input({ table: '`orders`' }), 'invalid_identifier'],
    [input({ index: 'bad\nname' }), 'control_character'],
    [input({ columns: [] }), 'invalid_value'],
    [input({ columns: ['created_at', 'created_at'] }), 'duplicate_column'],
    [input({ columns: Array.from({ length: MAX_CREATE_INDEX_COLUMNS + 1 }, (_, index) => `c${index}`) }), 'column_limit_exceeded'],
    [input({ reason: '   ' }), 'invalid_value'],
  ] as const) {
    assert.equal(errorOf(() => normalizeCreateIndexInput(candidate)).code, code);
  }
});

test('rejects SQL, extension points, malformed payloads, and unsafe object access', () => {
  for (const candidate of [
    input({ unique: true }),
    input({ columns: [{ name: 'created_at', length: 10 }] }),
    input({ columns: ['`created_at`'] }),
    input({ index: '`orders_idx`' }),
    'CREATE INDEX orders_idx ON app.orders (created_at)',
    { ...input(), columns: new Array(1) },
  ]) {
    assert.throws(() => normalizeCreateIndexInput(candidate));
  }

  const getter = Object.create(null, {
    schema: { enumerable: true, get: () => 'app' },
    table: { enumerable: true, value: 'orders' },
    index: { enumerable: true, value: 'orders_idx' },
    columns: { enumerable: true, value: ['created_at'] },
    reason: { enumerable: true, value: 'test' },
  });
  assert.equal(errorOf(() => normalizeCreateIndexInput(getter)).code, 'invalid_payload');
});

test('publishes an exact JSON-schema-compatible public contract', () => {
  const schema = createIndexInputJsonSchema() as unknown as {
    $schema: unknown;
    required: unknown;
    additionalProperties: unknown;
    properties: {
      columns: { maxItems: unknown; items: { maxLength: unknown } };
      reason: { maxLength: unknown; pattern: string };
      index: { pattern: unknown };
    };
  };
  assert.deepEqual(schema.required, ['schema', 'table', 'index', 'columns', 'reason']);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.columns.maxItems, MAX_CREATE_INDEX_COLUMNS);
  assert.equal(schema.properties.columns.items.maxLength, MAX_CREATE_INDEX_IDENTIFIER_LENGTH);
  assert.equal(schema.properties.reason.maxLength, MAX_CREATE_INDEX_REASON_LENGTH);
  assert.equal(schema.properties.index.pattern, CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN);
  assert.match(schema.properties.reason.pattern, /\\S/);
});
