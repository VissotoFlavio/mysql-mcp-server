import assert from 'node:assert/strict';
import test from 'node:test';

import { createDdlAuditAttempt, createDdlRequestHash, toSafeDdlOutcome } from '../../src/db/ddl-audit.js';
import { classifyDdlDriverCode, sanitizeDdlDriverCode } from '../../src/db/ddl-error-codes.js';
import {
  AlterTableDropColumnMetadataError,
  AlterTableDropColumnVerificationError,
  AlterTableModifyColumnMetadataError,
  AlterTableModifyColumnVerificationError,
} from '../../src/db/metadata.js';
import { ConnectionError, createConnectionLayer, DdlDisabledError, DdlDriverError, DdlResultError, QueryTimeoutError } from '../../src/db/pool.js';
import { DdlPolicyError } from '../../src/db/sql-policy.js';

import { validEnvironment } from './fixtures.js';

function request() {
  return {
    schema: 'app',
    table: 'audit_accounts',
    reason: ' Create the account table ',
    columns: [
      { name: 'id', type: { kind: 'integer' as const, integerType: 'bigint' as const, unsigned: true }, nullable: false, autoIncrement: true },
      { name: 'name', type: { kind: 'varchar' as const, length: 255 }, nullable: false },
    ],
    primaryKey: ['id'],
  };
}

test('audits CREATE INDEX requests with their own operation and sanitized target', () => {
  const lines: string[] = [];
  const attempt = createDdlAuditAttempt(
    { schema: 'app', table: 'orders', index: 'orders_created_idx', columns: ['created_at'], reason: 'Support recent lookups.' },
    { writer: (line) => lines.push(line), operationId: () => 'index-op', now: () => 1_000 },
  );
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'create_index');
  assert.equal(completed.target.index, 'orders_created_idx');
  assert.equal(completed.reason, 'Support recent lookups.');
  assert.equal(completed.primaryKeyColumnCount, null);
  assert.doesNotMatch(lines.join('\n'), /CREATE INDEX/i);
});

test('hashes DROP INDEX requests with one canonical index field', () => {
  const request = { schema: 'app', table: 'orders', index: 'orders_created_idx', reason: 'Remove redundant lookups.' };
  const lines: string[] = [];
  const attempt = createDdlAuditAttempt(request, { writer: (line) => lines.push(line), operationId: () => 'drop-index-op', now: () => 1_000 });
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'drop_index');
  assert.deepEqual(completed.target, { schema: 'app', table: 'orders', index: 'orders_created_idx' });
  assert.equal(completed.columnCount, null);
  assert.equal(completed.requestHash, createDdlRequestHash(request));
  assert.doesNotMatch(lines.join('\n'), /DROP INDEX/iu);
});

test('audits ALTER TABLE ADD COLUMN as one bounded operation without SQL', () => {
  const lines: string[] = [];
  const request = {
    schema: 'app',
    table: 'accounts',
    column: { name: 'nickname', type: { kind: 'varchar' as const, length: 100 }, nullable: true },
    reason: 'Add an optional account nickname.',
  };
  const attempt = createDdlAuditAttempt(request, { writer: (line) => lines.push(line), operationId: () => 'alter-op', now: () => 1_000 });
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'alter_table_add_column');
  assert.deepEqual(completed.target, { schema: 'app', table: 'accounts' });
  assert.equal(completed.columnCount, 1);
  assert.equal(completed.primaryKeyColumnCount, null);
  assert.doesNotMatch(lines.join('\n'), /ALTER TABLE|VARCHAR\(100\)/i);
});

test('audits an ALTER TABLE ADD FOREIGN KEY request without recording referenced names or SQL', () => {
  const lines: string[] = [];
  const attempt = createDdlAuditAttempt(
    {
      schema: 'app',
      table: 'orders',
      constraint: 'orders_customer_fk',
      columns: ['customer_id'],
      referencedTable: 'customers',
      referencedColumns: ['id'],
      onDelete: 'RESTRICT',
      onUpdate: 'NO ACTION',
      reason: 'Keep orders valid.',
    },
    { writer: (line) => lines.push(line), operationId: () => 'foreign-key-op', now: () => 1_000 },
  );
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'alter_table_add_foreign_key');
  assert.deepEqual(completed.target, { schema: 'app', table: 'orders' });
  assert.equal(completed.columnCount, 1);
  assert.doesNotMatch(lines.join('\n'), /ALTER TABLE|FOREIGN KEY|customers|customer_id|orders_customer_fk/iu);
});

test('audits DROP FOREIGN KEY with only the named target and no SQL', () => {
  const lines: string[] = [];
  const request = { schema: 'app', table: 'orders', constraint: 'orders_customer_fk', reason: 'Remove obsolete relationship.' };
  const attempt = createDdlAuditAttempt(request, { writer: (line) => lines.push(line), operationId: () => 'drop-foreign-key-op', now: () => 1_000 });
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'alter_table_drop_foreign_key');
  assert.deepEqual(completed.target, { schema: 'app', table: 'orders', constraint: 'orders_customer_fk' });
  assert.equal(completed.columnCount, null);
  assert.equal(completed.primaryKeyColumnCount, null);
  assert.doesNotMatch(lines.join('\\n'), /ALTER TABLE|DROP FOREIGN KEY/iu);
});

test('audits DROP COLUMN with one sanitized target and no SQL or confirmation text', () => {
  const lines: string[] = [];
  const reason = 'Remove the obsolete label because it is no longer used.';
  const request = { schema: 'app', table: 'orders', column: 'obsolete_label', reason, confirmation: 'DROP_COLUMN' };
  const attempt = createDdlAuditAttempt(request, { writer: (line) => lines.push(line), operationId: () => 'drop-column-op', now: () => 1_000 });
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'alter_table_drop_column');
  assert.deepEqual(completed.target, { schema: 'app', table: 'orders', column: 'obsolete_label' });
  assert.equal(completed.columnCount, 1);
  assert.equal(completed.requestHash, createDdlRequestHash(request));
  assert.doesNotMatch(lines.join('\n'), /ALTER TABLE|DROP COLUMN/iu);
});

test('audits RENAME TABLE with sanitized source and destination metadata', () => {
  const lines: string[] = [];
  const attempt = createDdlAuditAttempt(
    { schema: 'app', table: 'accounts', newTable: 'customers', reason: 'Rename the account table.' },
    { writer: (line) => lines.push(line), operationId: () => 'rename-table-op', now: () => 1_000 },
  );
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'rename_table');
  assert.deepEqual(completed.target, { schema: 'app', table: 'accounts', newTable: 'customers' });
  assert.equal(completed.columnCount, null);
  assert.equal(completed.primaryKeyColumnCount, null);
  assert.doesNotMatch(lines.join('\n'), /RENAME TABLE/iu);
});

test('hashes normalized CREATE TABLE requests and emits only sanitized structural audit data', () => {
  const first = request();
  const equivalent = {
    ...request(),
    reason: 'Create the account table',
    columns: [{ ...request().columns[0], type: { ...request().columns[0].type, unsigned: true } }, request().columns[1]],
  };
  assert.equal(createDdlRequestHash(first), createDdlRequestHash(equivalent));

  const lines: string[] = [];
  const attempt = createDdlAuditAttempt(first, { writer: (line) => lines.push(line), operationId: () => 'ddl-op', now: () => 1_000 });
  attempt.markSubmitted();
  const completed = attempt.emit();
  const [started] = lines.map((line) => JSON.parse(line));
  assert.equal(started.event, 'ddl_attempt');
  assert.equal(started.phase, 'started');
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.operationId, 'ddl-op');
  assert.equal(completed.target.table, 'audit_accounts');
  assert.equal(completed.reason, 'Create the account table');
  assert.equal(completed.columnCount, 2);
  assert.equal(completed.primaryKeyColumnCount, 1);
  assert.equal(completed.result, 'succeeded');
  assert.equal(completed.requestHash, createDdlRequestHash(first));
  assert.doesNotMatch(lines.join('\n'), /CREATE TABLE|BIGINT|VARCHAR|AUTO_INCREMENT/);
});

test('audits CREATE SCHEMA with allowlisted options and a reason hash instead of raw reason text', () => {
  const lines: string[] = [];
  const reason = 'Create a tenant catalog with internal classification.';
  const attempt = createDdlAuditAttempt(
    { schema: 'tenant_catalog', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', reason },
    { writer: (line) => lines.push(line), operationId: () => 'schema-op', now: () => 1_000, operation: 'create_schema' },
  );
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'create_schema');
  assert.deepEqual(completed.target, { schema: 'tenant_catalog', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' });
  assert.equal(completed.reason, '3ff922ebb288508062da7bddf053af553bab3de9e77eded3ab4d287214bc3eed');
  assert.doesNotMatch(lines.join('\n'), /Create a tenant catalog|CREATE SCHEMA/);
});

test('audits DROP TABLE with a reason hash and no confirmation token', () => {
  const lines: string[] = [];
  const reason = 'Remove the retired table with internal classification.';
  const confirmation = `DROP_TABLE:${'a'.repeat(64)}`;
  const attempt = createDdlAuditAttempt(
    { schema: 'app', table: 'orders', reason, confirmation },
    { writer: (line) => lines.push(line), operationId: () => 'drop-table-op', now: () => 1_000, operation: 'drop_table' },
  );
  attempt.markSubmitted();
  const completed = attempt.emit();
  assert.equal(completed.operation, 'drop_table');
  assert.equal(completed.reason, '8f8d201875a9396b7cbc6ee753f26257696395b52ab647647b783045905bcc4c');
  assert.doesNotMatch(lines.join('\n'), /Remove the retired table|DROP_TABLE:|DROP TABLE/iu);
});

test('classifies DDL failures without preserving driver messages', () => {
  const cases: readonly [unknown, boolean, string, string | undefined][] = [
    [new DdlPolicyError(), false, 'MYSQL_DDL_INVALID_ARGUMENT', undefined],
    [new DdlDisabledError(), false, 'MYSQL_DDL_DISABLED', undefined],
    [new DdlDriverError('ER_TABLE_EXISTS_ERROR', true), true, 'MYSQL_DDL_TABLE_EXISTS', undefined],
    [new DdlDriverError('ER_NO_SUCH_TABLE', true), true, 'MYSQL_DDL_TABLE_INVALID', undefined],
    [new DdlDriverError('ER_DUP_KEYNAME', true), true, 'MYSQL_DDL_INDEX_EXISTS', undefined],
    [new DdlDriverError('ER_DUP_FIELDNAME', true), true, 'MYSQL_DDL_COLUMN_EXISTS', undefined],
    [new DdlDriverError('ER_ACCESS_DENIED_ERROR', true), true, 'MYSQL_DDL_PERMISSION_DENIED', undefined],
    [new DdlDriverError('ER_TOO_MANY_FIELDS', true), true, 'MYSQL_DDL_STRUCTURE_INVALID', undefined],
    [new DdlDriverError('ER_FK_DUP_NAME', true), true, 'MYSQL_DDL_STRUCTURE_INVALID', undefined],
    [new DdlDriverError('ER_CANNOT_DROP_FIELD_OR_KEY', true), true, 'MYSQL_DDL_STRUCTURE_INVALID', undefined],
    [new DdlDriverError('ER_LOCK_WAIT_TIMEOUT', true), true, 'MYSQL_DDL_LOCK_TIMEOUT', undefined],
    [new DdlDriverError('ER_LOCK_DEADLOCK', true), true, 'MYSQL_DDL_DEADLOCK', undefined],
    [new DdlDriverError('1049', true), true, 'MYSQL_DDL_FAILED', undefined],
    [new DdlDriverError(undefined, true), true, 'MYSQL_DDL_FAILED', undefined],
    [new DdlResultError(), true, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
    [new QueryTimeoutError(true), true, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
    [new ConnectionError('raw transport secret', true), true, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
    [new ConnectionError('connection failed before submission'), false, 'MYSQL_DDL_FAILED', undefined],
    [new AlterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID', 'internal'), false, 'MYSQL_DDL_METADATA_INVALID', undefined],
    [new AlterTableModifyColumnMetadataError('MYSQL_DDL_TABLE_INVALID', 'internal'), false, 'MYSQL_DDL_TABLE_INVALID', undefined],
    [new AlterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID', 'internal'), false, 'MYSQL_DDL_STRUCTURE_INVALID', undefined],
    [new AlterTableModifyColumnVerificationError(), false, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
    [new AlterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID', 'internal'), false, 'MYSQL_DDL_STRUCTURE_INVALID', undefined],
    [new AlterTableDropColumnVerificationError(), true, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
  ];
  for (const [error, submitted, code, retryAdvice] of cases) {
    const outcome = toSafeDdlOutcome(error, submitted);
    assert.equal(outcome.code, code);
    assert.equal(outcome.retryAdvice, retryAdvice);
    assert.doesNotMatch(JSON.stringify(outcome), /secret|raw transport/);
  }
});

test('keeps unknown-database driver codes as generic DDL failures', () => {
  for (const code of ['ER_BAD_DB_ERROR', '1049', 1049]) {
    assert.equal(classifyDdlDriverCode(code), undefined);
    assert.equal(sanitizeDdlDriverCode(code), undefined);
  }
  assert.equal(toSafeDdlOutcome(new DdlDriverError('1049', true), true).code, 'MYSQL_DDL_FAILED');
});

test('records one DDL audit lifecycle and an indeterminate post-submission transport outcome', async () => {
  const lines: string[] = [];
  let calls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    ddlAuditWriter: (line) => lines.push(line),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            calls += 1;
            throw Object.assign(new Error('mysql://user:secret@host'), { code: 'ECONNRESET' });
          },
          async end() {},
        } as never;
      },
    },
  });
  const { createCreateTableStatement } = await import('../../src/db/pool.js');
  await assert.rejects(
    () => layer.ddl.executeCreateTable(createCreateTableStatement(request())),
    (error: unknown) => {
      const outcome = toSafeDdlOutcome(error, true);
      assert.equal(outcome.code, 'MYSQL_DDL_OUTCOME_UNKNOWN');
      assert.equal(outcome.retryAdvice, 'VERIFY_STATE_BEFORE_RETRYING');
      return true;
    },
  );
  assert.equal(calls, 1);
  const [started, completed] = lines.map((line) => JSON.parse(line));
  assert.equal(started.phase, 'started');
  assert.equal(completed.phase, 'completed');
  assert.equal(started.operationId, completed.operationId);
  assert.equal(completed.code, 'MYSQL_DDL_OUTCOME_UNKNOWN');
  assert.equal(completed.retryAdvice, 'VERIFY_STATE_BEFORE_RETRYING');
  assert.doesNotMatch(lines.join('\n'), /secret|CREATE TABLE/);
  await layer.close();
});
