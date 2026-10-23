import assert from 'node:assert/strict';
import test from 'node:test';

import { createDmlAuditAttempt, createDmlRequestHash, toSafeDmlOutcome } from '../../src/db/dml-audit.js';
import { buildDeleteStatement, buildUpdateStatement, MAX_DML_LIMIT } from '../../src/db/dml-builder.js';
import { DmlDriverError, ConnectionError, QueryTimeoutError, createAuditedDmlStatement, createConnectionLayer } from '../../src/db/pool.js';

const request = {
  operation: 'update' as const,
  target: { schema: 'app', table: 'accounts' },
  reason: 'Correct account status',
  limit: 10,
  suppliedCount: 2,
  columns: ['status', 'id'],
  filters: [{ column: 'id', operator: 'eq', value: 'not-logged' }],
  values: ['not-logged', 1],
};
const insertRequest = {
  operation: 'insert' as const,
  target: { schema: 'app', table: 'accounts' },
  reason: 'Insert accounts',
  rowCount: 2,
  columns: ['id', 'status'],
  values: [1, 'active', 2, 'pending'],
};
const deleteRequest = {
  operation: 'delete' as const,
  target: { schema: 'app', table: 'accounts' },
  reason: 'Delete account',
  limit: 1,
  suppliedCount: 0,
  columns: ['id'],
  filters: [{ column: 'id', operator: 'eq', value: 1 }],
};
const auditedDeleteInput = {
  target: { schema: 'app', table: 'accounts', reason: 'Delete account' },
  filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
  limit: 1,
  columns: ['id', 'status'],
  primaryKey: ['id'],
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

test('writes correlated started and completed JSON lines before and after submission', () => {
  const lines: string[] = [];
  const clocks = [1_000, 1_037];
  const attempt = createDmlAuditAttempt(request, {
    writer: (line) => lines.push(line),
    operationId: () => 'op-1',
    now: () => clocks.shift() ?? 1_037,
  });
  attempt.markSubmitted();
  const event = attempt.emit({ affectedCount: 2 });
  const [started, completed] = lines.map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(started.phase, 'started');
  assert.equal(completed.phase, 'completed');
  assert.equal(started.operationId, event.operationId);
  assert.equal(started.requestHash, event.requestHash);
  assert.equal(completed.requestHash, event.requestHash);
  assert.equal(started.timestamp, '1970-01-01T00:00:01.000Z');
  assert.equal(event.durationMs, 37);
  assert.deepEqual(
    Object.keys(completed).sort(),
    [
      'affectedCount',
      'code',
      'columnCount',
      'durationMs',
      'event',
      'filterCount',
      'operation',
      'operationId',
      'parameterCount',
      'phase',
      'reason',
      'requestHash',
      'requestedLimit',
      'result',
      'retryAdvice',
      'rowCount',
      'target',
      'timestamp',
    ].sort(),
  );
  assert.equal(completed.columnCount, 2);
  assert.equal(completed.filterCount, 1);
  assert.equal(completed.parameterCount, 3);
  assert.equal(completed.affectedCount, 2);
  assert.doesNotMatch(JSON.stringify(lines), /not-logged/);
  assert.throws(() => attempt.emit(), /audit metadata/i);
});

test('fails closed when the started writer throws and retains terminal outcome if final writer throws', () => {
  assert.throws(
    () =>
      createDmlAuditAttempt(request, {
        writer: () => {
          throw new Error('writer failed');
        },
      }),
    /writer failed/,
  );
  let calls = 0;
  const attempt = createDmlAuditAttempt(request, {
    writer: () => {
      calls += 1;
      if (calls === 2) throw new Error('terminal writer failed');
    },
  });
  attempt.markSubmitted();
  const event = attempt.emit({ error: new QueryTimeoutError() });
  assert.equal(event.code, 'MYSQL_DML_OUTCOME_UNKNOWN');
  assert.equal(event.result, 'indeterminate');
  assert.equal(event.retryAdvice, 'VERIFY_STATE_BEFORE_RETRYING');
});

test('writes the completed event when a post-submission clock is outside the Date range', () => {
  const lines: string[] = [];
  const clocks = [0, Number.MAX_VALUE];
  const attempt = createDmlAuditAttempt(request, { writer: (line) => lines.push(line), now: () => clocks.shift() ?? Number.MAX_VALUE });
  attempt.markSubmitted();
  assert.doesNotThrow(() => attempt.emit({ error: new QueryTimeoutError() }));
  assert.equal(JSON.parse(lines[1] as string).phase, 'completed');
});

test('keeps unknown server failures distinct from pre/post dispatch transport failures', () => {
  for (const submitted of [false, true]) {
    assert.equal(toSafeDmlOutcome(new DmlDriverError(undefined), submitted).code, 'MYSQL_DML_FAILED');
    assert.equal(toSafeDmlOutcome(new ConnectionError('secret'), submitted).code, submitted ? 'MYSQL_DML_OUTCOME_UNKNOWN' : 'MYSQL_DML_FAILED');
    assert.equal(toSafeDmlOutcome(new QueryTimeoutError(), submitted).code, submitted ? 'MYSQL_DML_OUTCOME_UNKNOWN' : 'MYSQL_DML_FAILED');
  }
});

test('preserves post-dispatch transport loss separately from unknown server errors', async () => {
  const layer = createConnectionLayer({
    environment: environment(),
    driver: {
      createPool: () =>
        ({
          async query() {
            return [[]];
          },
          async execute() {
            throw Object.assign(new Error('raw secret'), { code: 'ECONNRESET' });
          },
          async end() {},
        }) as never,
    },
  });
  await assert.rejects(
    () => layer.dml.executeDml(createAuditedDmlStatement('delete', auditedDeleteInput)),
    (failure: unknown) => {
      assert.equal(toSafeDmlOutcome(failure, false).code, 'MYSQL_DML_FAILED');
      assert.equal(toSafeDmlOutcome(failure, true).code, 'MYSQL_DML_OUTCOME_UNKNOWN');
      return true;
    },
  );
});

test('maps own MySQL code and errno permission classifications without messages', async () => {
  for (const error of [
    Object.assign(new Error('raw secret'), { code: 'ER_COLUMNACCESS_DENIED_ERROR' }),
    Object.assign(new Error('raw secret'), { errno: 1143 }),
    Object.create(null, {
      code: {
        get: () => {
          throw new Error('raw getter secret');
        },
      },
      errno: { value: 1143, enumerable: true },
    }),
  ]) {
    const layer = createConnectionLayer({
      environment: environment(),
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[]];
            },
            async execute() {
              throw error;
            },
            async end() {},
          }) as never,
      },
    });
    await assert.rejects(
      () => layer.dml.executeDml(createAuditedDmlStatement('delete', auditedDeleteInput)),
      (failure: unknown) => {
        const outcome = toSafeDmlOutcome(failure, true);
        assert.equal(outcome.code, 'MYSQL_PERMISSION_DENIED');
        assert.doesNotMatch(JSON.stringify(outcome), /secret/);
        return true;
      },
    );
  }
});

test('validates operation-specific limits', () => {
  for (const candidate of [insertRequest, { ...request, limit: 1 }, { ...deleteRequest, limit: MAX_DML_LIMIT }])
    assert.notEqual(createDmlAuditAttempt(candidate, { writer: () => {} }).emit().operation, 'invalid');
  for (const candidate of [
    { ...insertRequest, limit: 1 },
    { ...insertRequest, rowCount: 0 },
    { ...insertRequest, rowCount: 101, values: new Array(202).fill(1) },
    { ...request, limit: 0 },
    { ...deleteRequest, limit: MAX_DML_LIMIT + 1 },
  ])
    assert.equal(createDmlAuditAttempt(candidate, { writer: () => {} }).emit().code, 'MYSQL_DML_INVALID_ARGUMENT');
});

test('enforces DML audit row, parameter, and filter cardinality boundaries', () => {
  for (const count of [1_000, 1_001]) {
    const event = createDmlAuditAttempt({ ...request, suppliedCount: count - 1, values: new Array(count - 1).fill(1) }, { writer: () => {} }).emit();
    assert.equal(event.operation, count === 1_000 ? 'update' : 'invalid');
  }
  for (const filter of [
    { column: 'id', operator: 'eq', value: 'safe' },
    { column: 'id', operator: 'in', values: new Array(100).fill('safe') },
    { column: 'id', operator: 'is_null' },
  ])
    assert.notEqual(createDmlAuditAttempt({ ...request, filters: [filter] }, { writer: () => {} }).emit().operation, 'invalid');
  for (const filter of [
    { column: 'id', operator: 'eq' },
    { column: 'id', operator: 'in', values: [] },
    { column: 'id', operator: 'in', values: new Array(101).fill('safe') },
    { column: 'deleted_at', operator: 'is_null', values: [] },
    { column: 'id', operator: 'eq', values: ['safe', 'other'] },
  ])
    assert.equal(createDmlAuditAttempt({ ...request, filters: [filter] }, { writer: () => {} }).emit().operation, 'invalid');
  assert.equal(createDmlAuditAttempt({ ...request, suppliedCount: 1, values: ['one', 'two'] }, { writer: () => {} }).emit().operation, 'invalid');
});

test('enforces exact insert, update, and delete audit shapes without recording values', () => {
  for (const candidate of [insertRequest, request, deleteRequest])
    assert.notEqual(createDmlAuditAttempt(candidate, { writer: () => {} }).emit().operation, 'invalid');
  for (const candidate of [
    { ...insertRequest, values: insertRequest.values.slice(1) },
    { ...insertRequest, filters: [] },
    { ...request, filters: [] },
    { ...deleteRequest, suppliedCount: 1 },
    { ...deleteRequest, values: [] },
  ])
    assert.equal(createDmlAuditAttempt(candidate, { writer: () => {} }).emit().operation, 'invalid');
});

test('emits redacted insert audit events with null limit and structural counts', () => {
  const lines: string[] = [];
  const attempt = createDmlAuditAttempt(insertRequest, { writer: (line) => lines.push(line), operationId: () => 'insert-op' });
  attempt.markSubmitted();
  const completed = attempt.emit({ affectedCount: 2 });
  const [started] = lines.map((line) => JSON.parse(line));
  assert.equal(started.operation, 'insert');
  assert.equal(started.requestedLimit, null);
  assert.equal(started.rowCount, 2);
  assert.equal(started.columnCount, 2);
  assert.equal(started.parameterCount, 4);
  assert.equal(completed.operationId, 'insert-op');
  assert.doesNotMatch(JSON.stringify(lines), /active|pending/);
  assert.notEqual(createDmlRequestHash(insertRequest), createDmlRequestHash({ ...insertRequest, values: [true, 3, false, 4] }));
});

test('accepts the actual update/delete builder inputs and rejects malformed builder metadata', () => {
  const updateInput = {
    target: { schema: 'app', table: 'accounts', reason: 'Correct account status' },
    values: { status: 'active' },
    filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
    limit: 1,
    columns: ['id', 'status'],
    primaryKey: ['id'],
  };
  const deleteInput = {
    target: { schema: 'app', table: 'accounts', reason: 'Delete account' },
    filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
    limit: 1,
    columns: ['id', 'status'],
    primaryKey: ['id'],
  };
  buildUpdateStatement(updateInput);
  buildDeleteStatement(deleteInput);
  for (const candidate of [
    { operation: 'update' as const, input: updateInput },
    { operation: 'delete' as const, input: deleteInput },
  ])
    assert.notEqual(createDmlAuditAttempt(candidate, { writer: () => {} }).emit().operation, 'invalid');
  for (const candidate of [
    { operation: 'update' as const, input: { ...updateInput, primaryKey: [] } },
    { operation: 'update' as const, input: { ...updateInput, values: { unknown: 'secret' } } },
    { operation: 'delete' as const, input: { ...deleteInput, columns: ['status'], primaryKey: ['id'] } },
  ])
    assert.equal(createDmlAuditAttempt(candidate, { writer: () => {} }).emit().operation, 'invalid');
});

test('includes primary-key order and update assignment columns in the audit identity', () => {
  const base = {
    target: { schema: 'app', table: 'accounts', reason: 'Correct account status' },
    values: { status: 'active' },
    filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
    limit: 1,
    columns: ['id', 'tenant_id', 'status', 'role'],
    primaryKey: ['id', 'tenant_id'],
  };
  const first = { operation: 'update' as const, input: base };
  const differentPrimaryKey = { operation: 'update' as const, input: { ...base, primaryKey: ['tenant_id', 'id'] } };
  const differentAssignment = { operation: 'update' as const, input: { ...base, values: { role: 'member' } } };
  assert.notEqual(createDmlRequestHash(first), createDmlRequestHash(differentPrimaryKey));
  assert.notEqual(createDmlRequestHash(first), createDmlRequestHash(differentAssignment));
  assert.doesNotMatch(createDmlRequestHash(first), /active|member/);
});

test('preserves builder filter order in the audit identity without recording literals', () => {
  const base = {
    target: { schema: 'app', table: 'accounts', reason: 'Correct account status' },
    values: { status: 'active' },
    limit: 1,
    columns: ['id', 'tenant_id', 'status'],
    primaryKey: ['id'],
  };
  const first = {
    operation: 'update' as const,
    input: {
      ...base,
      filters: [
        { column: 'id', operator: 'eq' as const, value: 1 },
        { column: 'tenant_id', operator: 'eq' as const, value: 'tenant-a' },
      ],
    },
  };
  const reordered = {
    operation: 'update' as const,
    input: {
      ...base,
      filters: [
        { column: 'tenant_id', operator: 'eq' as const, value: 'tenant-b' },
        { column: 'id', operator: 'eq' as const, value: 2 },
      ],
    },
  };
  assert.notEqual(createDmlRequestHash(first), createDmlRequestHash(reordered));
  assert.doesNotMatch(createDmlRequestHash(first), /tenant-a/);
});

test('integrates audit lifecycle around the real DML dispatch path', async () => {
  const auditRequest = {
    operation: 'update' as const,
    input: {
      target: { schema: 'app', table: 'accounts', reason: 'Correct account status' },
      values: { status: 'active' },
      filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
      limit: 1,
      columns: ['id', 'status'],
      primaryKey: ['id'],
    },
  };
  const lines: string[] = [];
  let calls = 0;
  const layer = createConnectionLayer({
    environment: environment(),
    dmlAuditWriter: (line) => lines.push(line),
    driver: {
      createPool: () =>
        ({
          async query() {
            return [[]];
          },
          async execute() {
            calls += 1;
            return [{ affectedRows: 1, changedRows: 1, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  await layer.dml.executeDml(createAuditedDmlStatement('update', auditRequest.input));
  assert.equal(calls, 1);
  assert.equal(lines.length, 2);
  const [started, completed] = lines.map((line) => JSON.parse(line));
  assert.equal(started.phase, 'started');
  assert.equal(completed.phase, 'completed');
  assert.equal(started.operationId, completed.operationId);
  assert.equal(started.requestHash, completed.requestHash);
  assert.equal(completed.affectedCount, 1);

  let blockedCalls = 0;
  const blocked = createConnectionLayer({
    environment: environment(),
    dmlAuditWriter: () => {
      throw new Error('audit writer failure');
    },
    driver: {
      createPool: () =>
        ({
          async query() {
            return [[]];
          },
          async execute() {
            blockedCalls += 1;
            return [{ affectedRows: 1, changedRows: 1, warningStatus: 0 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  await assert.rejects(
    () => blocked.dml.executeDml(createAuditedDmlStatement('update', auditRequest.input)),
    (error: unknown) => {
      assert.equal((error as ConnectionError).message, 'The DML audit could not be started.');
      assert.doesNotMatch((error as Error).message, /audit writer failure/);
      return true;
    },
  );
  assert.equal(blockedCalls, 0);
});

test('fails closed for invalid filter scalars, pre-submission completion, and inherited/accessor metadata', () => {
  for (const filter of [
    { column: 'id', operator: 'eq', value: null },
    { column: 'id', operator: 'eq', value: Number.NaN },
    { column: 'id', operator: 'eq', value: Infinity },
    { column: 'id', operator: 'in', values: [null] },
  ])
    assert.equal(createDmlAuditAttempt({ ...request, filters: [filter] }, { writer: () => {} }).emit().operation, 'invalid');
  const attempt = createDmlAuditAttempt(request, { writer: () => {} });
  assert.equal(attempt.emit().code, 'MYSQL_DML_INVALID_ARGUMENT');
  const inherited = Object.create(request);
  const accessor = { ...request };
  Object.defineProperty(accessor, 'reason', {
    get: () => {
      throw new Error('metadata-secret');
    },
  });
  for (const candidate of [inherited, accessor, { ...request, target: Object.create(request.target) }]) {
    const lines: string[] = [];
    const event = createDmlAuditAttempt(candidate, { writer: (line) => lines.push(line) }).emit();
    assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
    assert.doesNotMatch(lines.join('\n'), /metadata-secret/);
  }
});

test('hashes scalar type markers but never supplied literals', () => {
  const same = { ...request, values: ['sentinel-a', 'sentinel-c'], filters: [{ column: 'id', operator: 'eq', value: 'sentinel-b' }] };
  assert.equal(
    createDmlRequestHash(same),
    createDmlRequestHash({
      ...same,
      values: ['different', 'again'],
      filters: [{ column: 'id', operator: 'eq', value: 'also-different' }],
    }),
  );
  assert.notEqual(createDmlRequestHash(same), createDmlRequestHash({ ...same, values: [1, 2] }));
  const lines: string[] = [];
  createDmlAuditAttempt(same, { writer: (line) => lines.push(line) }).emit();
  assert.doesNotMatch(lines.join('\n'), /sentinel/);
});

test('rejects attacker-controlled array keys without logging their values', () => {
  const secret = 'map-secret';
  const values = ['safe', 'also-safe'];
  Object.defineProperty(values, 'map', { value: () => [secret] });
  const lines: string[] = [];
  const event = createDmlAuditAttempt({ ...request, values }, { writer: (line) => lines.push(line) }).emit();
  assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
  assert.doesNotMatch(lines.join('\n'), /map-secret/);
});

test('bounds hostile value-array lengths before indexed iteration', () => {
  const huge = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return Number.MAX_SAFE_INTEGER;
      return Reflect.get(target, property, receiver);
    },
  });
  const event = createDmlAuditAttempt({ ...request, values: huge }, { writer: () => {} }).emit();
  assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
});

test('snapshots array descriptors without invoking an array ownKeys trap', () => {
  let ownKeysCalled = false;
  const values = new Proxy(['safe', 'also-safe'], {
    ownKeys() {
      ownKeysCalled = true;
      throw new Error('own-keys-secret');
    },
  });
  const lines: string[] = [];
  const event = createDmlAuditAttempt({ ...request, values }, { writer: (line) => lines.push(line) }).emit();
  assert.equal(event.operation, 'update');
  assert.equal(ownKeysCalled, false);
  assert.doesNotMatch(lines.join('\n'), /own-keys-secret/);
});

test('normalizes ordinary columns and filters without recording literals', () => {
  const secret = 'array-secret';
  const columns = ['status', 'id'];
  const filters = [{ column: 'id', operator: 'eq', value: secret }];
  const first = { ...request, columns, filters };
  const second = { ...request, columns: ['status', 'id'], filters: [{ column: 'id', operator: 'eq', value: 'other-secret' }] };
  assert.equal(createDmlRequestHash(first), createDmlRequestHash(second));
  const lines: string[] = [];
  createDmlAuditAttempt(first, { writer: (line) => lines.push(line) }).emit();
  assert.doesNotMatch(lines.join('\n'), /array-secret/);
});

test('rejects getter-trapped structural arrays without exposing the trap text', () => {
  const secret = 'array-getter-secret';
  const accessorValues = ['safe', 'also-safe'];
  Object.defineProperty(accessorValues, '0', {
    enumerable: true,
    get: () => {
      throw new Error(secret);
    },
  });
  const descriptorProxy = new Proxy(['safe', 'also-safe'], {
    getOwnPropertyDescriptor: () => {
      throw new Error(secret);
    },
  });
  const accessorFilterValues = ['safe'];
  Object.defineProperty(accessorFilterValues, '0', {
    enumerable: true,
    get: () => {
      throw new Error(secret);
    },
  });
  for (const candidate of [
    { ...request, values: accessorValues },
    { ...request, columns: descriptorProxy },
    { ...request, filters: [{ column: 'id', operator: 'in', values: accessorFilterValues }] },
  ]) {
    const lines: string[] = [];
    const attempt = createDmlAuditAttempt(candidate, { writer: (line) => lines.push(line) });
    attempt.markSubmitted();
    const event = attempt.emit();
    assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
    assert.doesNotMatch(lines.join('\n'), /array-getter-secret/);
  }
});

test('uses only dense indexed array properties, ignoring extra keys and rejecting accessors', () => {
  const secret = 'array-key-secret';
  const normal = ['safe', 'also-safe'];
  const extra = ['safe', 'also-safe'];
  Object.defineProperty(extra, 'unexpected', { value: secret, enumerable: true });
  const symbolic = ['safe', 'also-safe'];
  Object.defineProperty(symbolic, Symbol('unexpected'), { value: secret });
  const accessor = ['safe', 'also-safe'];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => secret });
  assert.notEqual(createDmlAuditAttempt({ ...request, values: normal }, { writer: () => {} }).emit().operation, 'invalid');
  for (const values of [extra, symbolic]) {
    const lines: string[] = [];
    const event = createDmlAuditAttempt({ ...request, values }, { writer: (line) => lines.push(line) }).emit();
    assert.equal(event.operation, 'update');
    assert.doesNotMatch(lines.join('\n'), /array-key-secret/);
  }
  const accessorLines: string[] = [];
  const accessorEvent = createDmlAuditAttempt({ ...request, values: accessor }, { writer: (line) => accessorLines.push(line) }).emit();
  assert.equal(accessorEvent.code, 'MYSQL_DML_INVALID_ARGUMENT');
  assert.doesNotMatch(accessorLines.join('\n'), /array-key-secret/);
});

test('requires filter columns from the normalized column catalog', () => {
  const lines: string[] = [];
  const event = createDmlAuditAttempt(
    { ...request, columns: ['status'], filters: [{ column: 'id', operator: 'eq', value: 'filter-secret' }] },
    { writer: (line) => lines.push(line) },
  ).emit();
  assert.equal(event.code, 'MYSQL_DML_INVALID_ARGUMENT');
  assert.doesNotMatch(lines.join('\n'), /filter-secret/);
});

test('reads only allowlisted own metadata descriptors without invoking ownKeys', () => {
  const secret = 'own-keys-secret';
  let ownKeysCalled = false;
  const hostile = new Proxy(request, {
    ownKeys() {
      ownKeysCalled = true;
      throw new Error(secret);
    },
  });
  const lines: string[] = [];
  const event = createDmlAuditAttempt(hostile, { writer: (line) => lines.push(line) }).emit();
  assert.equal(event.operation, 'update');
  assert.equal(ownKeysCalled, false);
  const withUnknown = { ...request, unknownMetadata: secret };
  assert.equal(createDmlRequestHash(withUnknown), createDmlRequestHash(request));
  assert.doesNotMatch(lines.join('\n'), /own-keys-secret/);

  const descriptorFailure = new Proxy(request, {
    getOwnPropertyDescriptor() {
      throw new Error(secret);
    },
  });
  const failureLines: string[] = [];
  const failure = createDmlAuditAttempt(descriptorFailure, { writer: (line) => failureLines.push(line) }).emit();
  assert.equal(failure.code, 'MYSQL_DML_INVALID_ARGUMENT');
  assert.doesNotMatch(failureLines.join('\n'), /own-keys-secret/);
});

test('requires an own non-throwing timeout code', async () => {
  const inheritedTimeout = Object.create({ code: 'ETIMEDOUT' });
  const throwingTimeout = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => ({
        configurable: true,
        enumerable: true,
        get: () => {
          throw new Error('timeout secret');
        },
      }),
    },
  );
  for (const error of [inheritedTimeout, throwingTimeout]) {
    const layer = createConnectionLayer({
      environment: environment(),
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[]];
            },
            async execute() {
              throw error;
            },
            async end() {},
          }) as never,
      },
    });
    await assert.rejects(
      () => layer.dml.executeDml(createAuditedDmlStatement('delete', auditedDeleteInput)),
      (failure: unknown) => {
        assert.equal(toSafeDmlOutcome(failure, true).code, 'MYSQL_DML_FAILED');
        return true;
      },
    );
  }
});
