import assert from 'node:assert/strict';
import test from 'node:test';

import { createDmlAuditAttempt, createDmlRequestHash, toSafeDmlOutcome } from '../../src/db/dml-audit.js';
import { DML_DRIVER_CODE_CLASSIFICATIONS } from '../../src/db/dml-error-codes.js';
import { createConnectionLayer, createInternalDmlStatement, QueryTimeoutError } from '../../src/db/pool.js';

const request = {
  operation: 'update' as const,
  target: { schema: 'app', table: 'accounts' },
  reason: 'Correct account status',
  limit: 10,
  suppliedCount: 2,
  columns: ['status', 'id'],
  filters: [{ column: 'id', operator: 'eq', valueCount: 1 }],
};

function environment(): NodeJS.ProcessEnv {
  return {
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: '3306',
    MYSQL_DATABASE: 'app',
    MYSQL_USER: 'user',
    MYSQL_PASSWORD: 'password',
    MYSQL_DML_ENABLED: 'true',
  };
}

test('emits one structured safe DML audit event with a deterministic metadata-only hash', () => {
  const lines: string[] = [];
  const clocks = [1_000, 1_037];
  const attempt = createDmlAuditAttempt(request, {
    writer: (line) => lines.push(line),
    operationId: () => 'op-1',
    now: () => clocks.shift() ?? 1_037,
  });
  const event = attempt.emit({ affectedCount: 2 });

  assert.equal(event.operationId, 'op-1');
  assert.equal(event.durationMs, 37);
  assert.deepEqual(JSON.parse(lines[0] as string), event);
  assert.equal(lines.length, 1);
  assert.throws(() => attempt.emit(), /audit metadata/i);
  assert.equal(createDmlRequestHash(request), attempt.requestHash);
  assert.equal(
    createDmlRequestHash({ ...request, filters: [{ column: 'id', operator: 'eq', valueCount: 1, value: 'secret-value' } as never] }),
    attempt.requestHash,
  );
  assert.notEqual(createDmlRequestHash({ ...request, limit: 9 }), attempt.requestHash);
});

test('uses explicit submission state for timeout and disconnection events', () => {
  const pre = createDmlAuditAttempt(request, { operationId: () => 'pre', writer: () => {} }).emit({ error: new QueryTimeoutError() });
  assert.equal(pre.result, 'failed');
  const lines: string[] = [];
  const postAttempt = createDmlAuditAttempt(request, { operationId: () => 'post', writer: (line) => lines.push(line) });
  postAttempt.markSubmitted();
  const post = postAttempt.emit({ error: new QueryTimeoutError() });
  assert.equal(post.result, 'indeterminate');
  assert.equal(post.code, 'MYSQL_QUERY_TIMEOUT');
  assert.equal(post.retryAdvice, 'VERIFY_STATE_BEFORE_RETRYING');
  assert.equal(JSON.parse(lines[0] as string).result, 'indeterminate');
});

test('allocates an operation id and safe placeholder event for malformed and throwing requests', () => {
  const secret = 'secret-value';
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error(secret);
      },
      getPrototypeOf() {
        throw new Error(secret);
      },
    },
  );
  for (const malformed of [
    { ...request, target: { schema: secret } },
    { ...request, filters: [{ column: 'id', operator: 'eq', valueCount: -1 }] },
    proxy,
  ]) {
    const lines: string[] = [];
    const attempt = createDmlAuditAttempt(malformed, { operationId: () => 'invalid-op', writer: (line) => lines.push(line) });
    const event = attempt.emit();
    assert.equal(event.operationId, 'invalid-op');
    assert.equal(event.operation, 'invalid');
    assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
    assert.doesNotMatch(JSON.stringify(event), /secret-value/);
    assert.equal(lines.length, 1);
  }
});

test('maps sanitized driver classifications preserved through the DML pool boundary', async () => {
  const expectedCodes = {
    permission: 'MYSQL_PERMISSION_DENIED',
    duplicate: 'MYSQL_DUPLICATE_KEY',
    foreignKey: 'MYSQL_FOREIGN_KEY_VIOLATION',
    constraint: 'MYSQL_CONSTRAINT_VIOLATION',
  } as const;
  for (const [driverCode, classification] of Object.entries(DML_DRIVER_CODE_CLASSIFICATIONS)) {
    const layer = createConnectionLayer({
      environment: environment(),
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[]];
            },
            async execute() {
              throw Object.assign(new Error('raw secret mysql message'), { code: driverCode });
            },
            async end() {},
          }) as never,
      },
    });
    let failure: unknown;
    try {
      await layer.dml.executeDml(createInternalDmlStatement('DELETE FROM accounts WHERE id = ?', [1]));
    } catch (error) {
      failure = error;
    }
    const event = createDmlAuditAttempt(request, { writer: () => {} });
    event.markSubmitted();
    const outcome = event.emit({ error: failure });
    assert.equal(outcome.code, expectedCodes[classification]);
    assert.doesNotMatch(JSON.stringify(outcome), /secret/i);
  }
});

test('rejects inherited property names at the controlled DML pool boundary', async () => {
  for (const driverCode of ['toString', 'constructor', '__proto__']) {
    const layer = createConnectionLayer({
      environment: environment(),
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[]];
            },
            async execute() {
              throw Object.assign(new Error(`raw ${driverCode} secret`), { code: driverCode });
            },
            async end() {},
          }) as never,
      },
    });
    let failure: unknown;
    try {
      await layer.dml.executeDml(createInternalDmlStatement('DELETE FROM accounts WHERE id = ?', [1]));
    } catch (error) {
      failure = error;
    }
    const attempt = createDmlAuditAttempt(request, { writer: () => {} });
    attempt.markSubmitted();
    const event = attempt.emit({ error: failure });
    assert.equal(event.code, 'MYSQL_CONNECTION_FAILED');
    assert.equal(event.result, 'indeterminate');
    assert.equal(event.retryAdvice, 'VERIFY_STATE_BEFORE_RETRYING');
    assert.doesNotMatch(JSON.stringify(event), new RegExp(driverCode));
    assert.doesNotMatch(JSON.stringify(event), /secret/);
  }
});

test('emits a safe event when a hostile outcome proxy throws during inspection', () => {
  const secret = 'outcome-proxy-secret';
  const lines: string[] = [];
  const outcome = new Proxy(
    {},
    {
      get() {
        throw new Error(secret);
      },
    },
  );
  const event = createDmlAuditAttempt(request, { writer: (line) => lines.push(line) }).emit(outcome as never);
  assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
  assert.doesNotMatch(JSON.stringify(event), /outcome-proxy-secret/);
  assert.doesNotMatch(lines[0] as string, /outcome-proxy-secret/);
});

test('safe outcome conversion survives adversarial prototypes without exposing secrets', () => {
  const secret = 'proxy-secret';
  const error = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(secret);
      },
      get() {
        throw new Error(secret);
      },
    },
  );
  const outcome = toSafeDmlOutcome(error, true);
  assert.equal(outcome.code, 'MYSQL_CONNECTION_FAILED');
  assert.doesNotMatch(JSON.stringify(outcome), /proxy-secret/);
});
