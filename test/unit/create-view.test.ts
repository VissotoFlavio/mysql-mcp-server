import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCreateViewStatement } from '../../src/db/ddl-builder.js';
import { assertCreateViewSql, DdlPolicyError } from '../../src/db/sql-policy.js';
import { CreateViewInputValidationError, normalizeCreateViewInput } from '../../src/tools/create-view-input.js';
import { createViewOutputJsonSchema } from '../../src/tools/create-view.js';

const input = () => ({
  schema: 'app',
  view: 'account_labels',
  definition: { table: 'accounts', columns: ['id', 'label'] },
  reason: 'Expose account labels to reporting.',
});

test('normalizes only a strict projection definition and builds canonical invoker SQL', () => {
  const normalized = normalizeCreateViewInput(input());
  assert.deepEqual(normalized, input());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.definition.columns), true);
  const sql = buildCreateViewStatement(normalized).sql;
  assert.equal(sql, 'CREATE SQL SECURITY INVOKER VIEW `app`.`account_labels` AS SELECT `id`, `label` FROM `app`.`accounts`');
  assert.doesNotThrow(() => assertCreateViewSql(sql));
});

test('rejects raw SQL, alternate schemas, duplicate columns, and unexpected definition fields', () => {
  for (const value of [
    { ...input(), definition: 'SELECT id FROM accounts' },
    { ...input(), definition: { table: 'accounts', columns: ['id', 'id'] } },
    { ...input(), definition: { table: 'accounts', columns: ['id'], sql: 'SELECT id FROM accounts' } },
    { ...input(), sql: 'CREATE VIEW anything AS SELECT 1' },
  ]) {
    assert.throws(() => normalizeCreateViewInput(value), CreateViewInputValidationError);
  }
  for (const sql of [
    'CREATE VIEW `app`.`account_labels` AS SELECT `id` FROM `app`.`accounts`',
    'CREATE SQL SECURITY DEFINER VIEW `app`.`account_labels` AS SELECT `id` FROM `app`.`accounts`',
    'CREATE SQL SECURITY INVOKER VIEW `app`.`account_labels` AS SELECT `id` FROM `other`.`accounts`',
    'CREATE SQL SECURITY INVOKER VIEW `app`.`account_labels` AS SELECT `id`, `id` FROM `app`.`accounts`',
    'CREATE SQL SECURITY INVOKER VIEW `app`.`account_labels` AS SELECT `id` FROM `app`.`accounts` WHERE 1 = 1',
  ]) {
    assert.throws(() => assertCreateViewSql(sql), DdlPolicyError);
  }
});

test('publishes an exact create_view result-or-safe-error schema', () => {
  const schema = createViewOutputJsonSchema() as { anyOf: readonly Record<string, unknown>[] };
  assert.equal(schema.anyOf.length, 2);
  const result = schema.anyOf[0] as { additionalProperties: boolean; required: readonly string[]; properties: Record<string, unknown> };
  assert.equal(result.additionalProperties, false);
  assert.deepEqual(result.required, ['operation', 'operationId', 'target', 'source', 'warnings']);
  assert.deepEqual(result.properties.operation, { const: 'create_view' });
  const error = schema.anyOf[1] as { additionalProperties: boolean; required: readonly string[]; properties: Record<string, unknown> };
  assert.equal(error.additionalProperties, false);
  assert.deepEqual(error.required, ['code', 'message']);
  assert.deepEqual((error.properties.retryAdvice as Record<string, unknown>).enum, ['VERIFY_STATE_BEFORE_RETRYING']);
});
