import assert from 'node:assert/strict';
import test from 'node:test';

import { createDdlAuditAttempt, createDdlRequestHash, toSafeDdlOutcome } from '../../src/db/ddl-audit.js';
import { classifyDdlDriverCode, sanitizeDdlDriverCode } from '../../src/db/ddl-error-codes.js';
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

test('classifies DDL failures without preserving driver messages', () => {
  const cases: readonly [unknown, boolean, string, string | undefined][] = [
    [new DdlPolicyError(), false, 'MYSQL_DDL_INVALID_ARGUMENT', undefined],
    [new DdlDisabledError(), false, 'MYSQL_DDL_DISABLED', undefined],
    [new DdlDriverError('ER_TABLE_EXISTS_ERROR', true), true, 'MYSQL_DDL_TABLE_EXISTS', undefined],
    [new DdlDriverError('ER_DUP_KEYNAME', true), true, 'MYSQL_DDL_INDEX_EXISTS', undefined],
    [new DdlDriverError('ER_DUP_FIELDNAME', true), true, 'MYSQL_DDL_COLUMN_EXISTS', undefined],
    [new DdlDriverError('ER_ACCESS_DENIED_ERROR', true), true, 'MYSQL_DDL_PERMISSION_DENIED', undefined],
    [new DdlDriverError('ER_TOO_MANY_FIELDS', true), true, 'MYSQL_DDL_STRUCTURE_INVALID', undefined],
    [new DdlDriverError('ER_LOCK_WAIT_TIMEOUT', true), true, 'MYSQL_DDL_LOCK_TIMEOUT', undefined],
    [new DdlDriverError('ER_LOCK_DEADLOCK', true), true, 'MYSQL_DDL_DEADLOCK', undefined],
    [new DdlDriverError('1049', true), true, 'MYSQL_DDL_FAILED', undefined],
    [new DdlDriverError(undefined, true), true, 'MYSQL_DDL_FAILED', undefined],
    [new DdlResultError(), true, 'MYSQL_DDL_FAILED', undefined],
    [new QueryTimeoutError(true), true, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
    [new ConnectionError('raw transport secret', true), true, 'MYSQL_DDL_OUTCOME_UNKNOWN', 'VERIFY_STATE_BEFORE_RETRYING'],
    [new ConnectionError('connection failed before submission'), false, 'MYSQL_DDL_FAILED', undefined],
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
