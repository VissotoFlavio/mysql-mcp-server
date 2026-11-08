import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCreateSchemaStatement } from '../../src/db/ddl-builder.js';
import { assertCreateSchemaSql, DdlPolicyError } from '../../src/db/sql-policy.js';
import { normalizeCreateSchemaInput } from '../../src/tools/create-schema-input.js';
import { createSchemaOutputJsonSchema } from '../../src/tools/create-schema.js';

test('builds only the canonical CREATE SCHEMA forms', () => {
  assert.equal(
    buildCreateSchemaStatement(normalizeCreateSchemaInput({ schema: 'catalog', reason: 'Create catalog.' })).sql,
    'CREATE SCHEMA `catalog`',
  );
  const statement = buildCreateSchemaStatement(
    normalizeCreateSchemaInput({ schema: 'catalog', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', reason: 'Set defaults.' }),
  );
  assert.equal(statement.sql, 'CREATE SCHEMA `catalog` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  assert.doesNotThrow(() => assertCreateSchemaSql(statement.sql));
});

test('rejects arbitrary or overbroad CREATE SCHEMA SQL at the policy boundary', () => {
  for (const sql of [
    'CREATE SCHEMA `catalog`; DROP SCHEMA `other`',
    'CREATE SCHEMA IF NOT EXISTS `catalog`',
    'CREATE DATABASE `catalog`',
    'CREATE SCHEMA `catalog` DEFAULT CHARACTER SET utf16',
    'CREATE SCHEMA `catalog` COLLATE utf8mb4_bin',
    'CREATE SCHEMA `catalog` DEFAULT CHARACTER SET latin1 COLLATE utf8mb4_bin',
    'CREATE SCHEMA `catalog` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin TABLESPACE ts',
  ]) {
    assert.throws(() => assertCreateSchemaSql(sql), DdlPolicyError);
  }
});

test('publishes a sanitized create_schema result-or-safe-error schema', () => {
  const schema = createSchemaOutputJsonSchema() as { anyOf: readonly Record<string, unknown>[] };
  assert.equal(schema.anyOf.length, 2);
  assert.deepEqual((schema.anyOf[0].properties as Record<string, unknown>).operation, { const: 'create_schema' });
  assert.deepEqual((schema.anyOf[1].properties as Record<string, Record<string, unknown>>).code.enum, [
    'MYSQL_DDL_INVALID_ARGUMENT',
    'MYSQL_DDL_DISABLED',
    'MYSQL_DDL_FAILED',
    'MYSQL_DDL_OUTCOME_UNKNOWN',
    'MYSQL_DDL_PERMISSION_DENIED',
    'MYSQL_DDL_SCHEMA_EXISTS',
    'MYSQL_DDL_LOCK_TIMEOUT',
    'MYSQL_DDL_DEADLOCK',
    'MYSQL_DDL_STRUCTURE_INVALID',
    'MYSQL_DDL_METADATA_INVALID',
  ]);
});
