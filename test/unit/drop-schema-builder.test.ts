import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDropSchemaStatement } from '../../src/db/ddl-builder.js';
import { assertDropSchemaSql } from '../../src/db/sql-policy.js';
import { normalizeDropSchemaInput } from '../../src/tools/drop-schema-input.js';

test('renders only the canonical single-target DROP SCHEMA statement', () => {
  const input = normalizeDropSchemaInput({ schema: 'isolated', reason: 'Retire it.', confirmation: `DROP_SCHEMA:${'a'.repeat(64)}` });
  assert.equal(buildDropSchemaStatement(input).sql, 'DROP SCHEMA `isolated`');
  assert.doesNotThrow(() => assertDropSchemaSql('DROP SCHEMA `isolated`'));
  for (const sql of ['DROP SCHEMA IF EXISTS `isolated`', 'DROP SCHEMA `isolated` CASCADE', 'DROP SCHEMA `a`, `b`', 'DROP DATABASE `isolated`'])
    assert.throws(() => assertDropSchemaSql(sql));
});
