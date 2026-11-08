import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATE_SCHEMA_INPUT_JSON_SCHEMA,
  CreateSchemaInputValidationError,
  normalizeCreateSchemaInput,
} from '../../src/tools/create-schema-input.js';
import { MAX_CREATE_TABLE_NESTING_DEPTH } from '../../src/tools/create-table-input.js';

function input() {
  return { schema: 'mcp_ddl_test_catalog', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', reason: ' Create an isolated catalog ' };
}

function errorOf(action: () => unknown): CreateSchemaInputValidationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CreateSchemaInputValidationError);
    return error;
  }
  assert.fail('Expected CREATE SCHEMA validation to fail.');
}

test('normalizes the strict schema payload and accepts only matching allowlisted options', () => {
  const normalized = normalizeCreateSchemaInput(input());
  assert.deepEqual(normalized, { ...input(), reason: 'Create an isolated catalog' });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalizeCreateSchemaInput({ schema: 'catalog', reason: 'Use server defaults.' }).charset, undefined);
  assert.equal(normalizeCreateSchemaInput({ schema: 'catalog', charset: 'utf8mb4', reason: 'Use UTF-8.' }).charset, 'utf8mb4');
});

test('rejects SQL, quoted identifiers, unknown fields, control characters, and malformed options', () => {
  for (const value of [
    'CREATE SCHEMA catalog',
    { ...input(), sql: 'CREATE SCHEMA anything' },
    { ...input(), schema: '`catalog`' },
    { ...input(), schema: 'catalog\u0000hidden' },
    { ...input(), collation: 'utf8mb4_0900_ai_ci', charset: undefined },
    { ...input(), charset: 'utf16' },
    { ...input(), charset: 'latin1', collation: 'utf8mb4_bin' },
    { ...input(), reason: 'line\nfeed' },
  ]) {
    assert.throws(() => normalizeCreateSchemaInput(value), CreateSchemaInputValidationError);
  }
});

test('rejects oversized and deeply nested payloads before SQL generation', () => {
  let nested: unknown = {};
  for (let index = 0; index <= MAX_CREATE_TABLE_NESTING_DEPTH; index += 1) nested = { nested };
  assert.equal(errorOf(() => normalizeCreateSchemaInput({ ...input(), nested })).code, 'invalid_payload');

  const huge = { ...input(), reason: 'x'.repeat(501) };
  assert.equal(errorOf(() => normalizeCreateSchemaInput(huge)).code, 'string_too_long');
});

test('publishes an exact strict JSON schema', () => {
  const schema = CREATE_SCHEMA_INPUT_JSON_SCHEMA();
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema', 'reason']);
  assert.deepEqual((schema.properties as Record<string, Record<string, unknown>>).charset.enum, ['ascii', 'latin1', 'utf8', 'utf8mb4']);
  assert.deepEqual((schema.allOf as Record<string, unknown>[])[0].then, { required: ['charset'] });
});
