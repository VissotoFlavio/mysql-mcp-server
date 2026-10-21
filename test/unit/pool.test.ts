import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResultSetHeader, RowDataPacket } from 'mysql2';

import { toSafeDmlOutcome } from '../../src/db/dml-audit.js';
import {
  ConnectionError,
  createAuditedDmlStatement,
  createConnectionLayer,
  DmlDisabledError,
  type ConnectionLayer,
  wasDmlSubmitted,
  verifyConnection,
} from '../../src/db/pool.js';
import { DmlPolicyError, SqlPolicyError } from '../../src/db/sql-policy.js';
import { DmlInputValidationError } from '../../src/tools/dml-input.js';

import { validEnvironment } from './fixtures.js';

const auditedUpdate = () =>
  createAuditedDmlStatement('update', {
    target: { schema: 'app', table: 'accounts', reason: 'controlled update' },
    values: { role: 'admin' },
    filters: [{ column: 'id', operator: 'eq', value: 1 }],
    limit: 1,
    columns: ['id', 'role'],
    primaryKey: ['id'],
  });
const auditedDelete = () =>
  createAuditedDmlStatement('delete', {
    target: { schema: 'app', table: 'accounts', reason: 'controlled delete' },
    filters: [{ column: 'id', operator: 'eq', value: 1 }],
    limit: 1,
    columns: ['id', 'role'],
    primaryKey: ['id'],
  });

test('creates a bounded pool with secure driver options', async () => {
  let suppliedOptions: Record<string, unknown> | undefined;
  const fakePool = {
    async query() {
      return [[]];
    },
    async end() {},
  };
  const driver = {
    createPool(options: Record<string, unknown>) {
      suppliedOptions = options;
      return fakePool;
    },
  };

  const layer = createConnectionLayer({ environment: validEnvironment(), driver: driver as never });

  assert.equal(layer.queryTimeoutMs, 30_000);
  assert.deepEqual(layer.queryOptions(), { timeout: 30_000 });
  assert.equal(suppliedOptions?.waitForConnections, true);
  assert.equal(suppliedOptions?.connectionLimit, 2);
  assert.equal(suppliedOptions?.connectTimeout, 5_000);
  assert.equal(suppliedOptions?.multipleStatements, false);
  assert.equal(suppliedOptions?.supportBigNumbers, true);
  assert.equal(suppliedOptions?.bigNumberStrings, true);
  assert.equal(suppliedOptions?.ssl, undefined);
  assert.equal(layer.dmlEnabled, false);

  await layer.close();
});

test('executes one read-only statement through the encapsulated connection layer', async () => {
  let calls = 0;
  let receivedOptions: unknown;
  let receivedValues: unknown;
  const layer = createConnectionLayer({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return {
          async query(options: unknown, values: unknown) {
            calls += 1;
            receivedOptions = options;
            receivedValues = values;
            return [[{ value: 1 }], []];
          },
          async end() {},
        } as never;
      },
    },
  });

  const [rows] = await layer.query<(RowDataPacket & { readonly value: number })[]>({ sql: 'SELECT ?', timeout: 30_000 }, [1]);

  assert.deepEqual(rows, [{ value: 1 }]);
  assert.equal(calls, 1);
  assert.deepEqual(receivedOptions, { sql: 'SELECT ?', timeout: 30_000 });
  assert.deepEqual(receivedValues, [1]);
});

test('executes DML through the prepared internal path without read-only validation', async () => {
  let queryCalls = 0;
  let executeCalls = 0;
  let receivedOptions: unknown;
  let receivedValues: unknown;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            queryCalls += 1;
            return [[]];
          },
          async execute(options: unknown, values: unknown) {
            executeCalls += 1;
            receivedOptions = options;
            receivedValues = values;
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const readOnlyLayer: ConnectionLayer = layer;

  assert.equal('executeDml' in readOnlyLayer, false);
  assert.equal(typeof layer.dml.executeDml, 'function');

  const [result] = await layer.dml.executeDml(auditedUpdate());

  assert.deepEqual(result, { affectedRows: 1 });
  assert.equal(queryCalls, 0);
  assert.equal(executeCalls, 1);
  assert.deepEqual(receivedOptions, { sql: 'UPDATE `app`.`accounts` SET `role` = ? WHERE `id` = ? ORDER BY `id` ASC LIMIT 1', timeout: 30_000 });
  assert.deepEqual(receivedValues, ['admin', 1]);
});

test('keeps the legacy DML tuple and exposes operation ids through the separate execution method', async () => {
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const statement = auditedUpdate();

  const legacyResult = await layer.dml.executeDml(statement);
  const extendedResult = await layer.dml.executeDmlWithOperationId(statement);
  assert.equal(legacyResult.length, 2);
  assert.equal(extendedResult.length, 3);
  assert.equal(typeof extendedResult[2], 'string');
  await layer.close();
});

test('does not log malformed post-execute INSERT metadata as succeeded', async () => {
  const lines: string[] = [];
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    dmlAuditWriter: (line) => lines.push(line),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            return [{ affectedRows: 'invalid', warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const statement = createAuditedDmlStatement('insert', {
    target: { schema: 'app', table: 'accounts', reason: 'controlled insert' },
    columns: ['name'],
    rows: [{ name: 'not-logged' }],
  });

  await assert.rejects(
    () => layer.dml.executeDmlWithOperationId(statement),
    (error: unknown) => {
      assert.equal(toSafeDmlOutcome(error, true).code, 'MYSQL_DML_OUTCOME_UNKNOWN');
      return true;
    },
  );
  const completed = JSON.parse(lines.at(-1) as string) as { result: string; code: string };
  assert.equal(completed.result, 'indeterminate');
  assert.equal(completed.code, 'MYSQL_DML_OUTCOME_UNKNOWN');
  await layer.close();
});

test('sanitizes hostile proxy errors without leaking raw traps', async () => {
  const lines: string[] = [];
  const hostile = new Proxy(new Error('proxy-secret'), {
    getPrototypeOf() {
      throw new Error('proxy-trap-secret');
    },
  });
  assert.equal(wasDmlSubmitted(hostile), false);

  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    dmlAuditWriter: (line) => lines.push(line),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            throw hostile;
          },
          async end() {},
        } as never;
      },
    },
  });

  await assert.rejects(
    () => layer.dml.executeDmlWithOperationId(auditedUpdate()),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'MYSQL_CONNECTION_FAILED');
      assert.equal((error as { message: string }).message, 'Unable to execute the DML statement.');
      return true;
    },
  );
  const completed = JSON.parse(lines.at(-1) as string) as { result: string; code: string };
  assert.equal(completed.result, 'failed');
  assert.equal(completed.code, 'MYSQL_DML_FAILED');
  assert.doesNotMatch(lines.join('\n'), /proxy-secret|proxy-trap-secret/);
  await layer.close();
});

for (const invalidInsertId of [
  { label: 'secret string', value: 'insert-id-secret' },
  { label: 'malformed string', value: '01' },
  { label: 'negative number', value: -1 },
  { label: 'decimal number', value: 1.5 },
  { label: 'oversized bigint', value: 18446744073709551616n },
  { label: 'object', value: { value: 'insert-id-secret' } },
] as const) {
  test(`classifies ${invalidInsertId.label} INSERT metadata as indeterminate`, async () => {
    const lines: string[] = [];
    const layer = createConnectionLayer({
      environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
      dmlAuditWriter: (line) => lines.push(line),
      driver: {
        createPool() {
          return {
            async query() {
              return [[]];
            },
            async execute() {
              return [{ affectedRows: 1, insertId: invalidInsertId.value, warningStatus: 0 }, []];
            },
            async end() {},
          } as never;
        },
      },
    });
    const statement = createAuditedDmlStatement('insert', {
      target: { schema: 'app', table: 'accounts', reason: 'controlled insert' },
      columns: ['name'],
      rows: [{ name: 'insert-id-row-secret' }],
    });

    await assert.rejects(
      () => layer.dml.executeDmlWithOperationId(statement),
      (error: unknown) => {
        assert.equal(toSafeDmlOutcome(error, true).code, 'MYSQL_DML_OUTCOME_UNKNOWN');
        return true;
      },
    );
    const completed = JSON.parse(lines.at(-1) as string) as { result: string; code: string };
    assert.equal(completed.result, 'indeterminate');
    assert.equal(completed.code, 'MYSQL_DML_OUTCOME_UNKNOWN');
    assert.doesNotMatch(lines.join('\n'), /insert-id-secret|insert-id-row-secret/);
    await layer.close();
  });
}

test('preserves large DML result identifiers as strings', async () => {
  const largeInsertId = '9007199254740993';
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            return [{ affectedRows: 1, insertId: largeInsertId, changedRows: 0, warningStatus: 0 } as unknown as ResultSetHeader, []];
          },
          async end() {},
        } as never;
      },
    },
  });

  const [result] = await layer.dml.executeDml<ResultSetHeader>(auditedUpdate());

  assert.equal(result.insertId, largeInsertId);
  await layer.close();
});

test('rejects non-DML and multiple statements before the DML driver path', async () => {
  let executeCalls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });

  for (const _sql of ['SELECT 1', 'CREATE TABLE accounts (id INT)', 'SHOW TABLES', 'UPDATE accounts SET role = ?; DELETE FROM accounts']) {
    await assert.rejects(
      () => layer.dml.executeDml(Object.freeze({}) as never),
      (error: unknown) => {
        assert(error instanceof DmlPolicyError);
        assert.equal(error.code, 'MYSQL_SQL_NOT_DML');
        assert.equal(error.message, 'Only one top-level DML statement is allowed.');
        return true;
      },
    );
  }

  assert.equal(executeCalls, 0);
});

test('rejects unsafe SQL before the driver is called', async () => {
  let calls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return {
          async query() {
            calls += 1;
            return [[]];
          },
          async end() {},
        } as never;
      },
    },
  });

  for (const sql of [
    'SELECT 1; SELECT 2',
    'INSERT INTO accounts VALUES (1)',
    "/* comment */ UPDATE accounts SET role = 'admin'",
    'SELECT * FROM accounts FOR UPDATE',
    "SELECT 1 INTO OUTFILE 'leak.txt'",
    'SELECT 1 /*!50000 FOR UPDATE */',
    "SELECT 1 /*!50000 INTO OUTFILE 'leak.txt' */",
    'EXPLAIN DELETE FROM accounts',
    'WITH changed AS (DELETE FROM accounts RETURNING id) SELECT * FROM changed',
    'SELECT @review_variable := 1',
    "SELECT get_lock('mcp-review', 1)",
    "SELECT RELEASE_LOCK('mcp-review')",
    'SELECT RELEASE_ALL_LOCKS()',
    "WITH locks AS (SELECT GET_LOCK('mcp-review', 1)) SELECT * FROM locks",
    "EXPLAIN SELECT RELEASE_LOCK('mcp-review')",
    'SHOW CREATE TRIGGER audit_trigger',
    'DESCRIBE accounts',
    'this is not SQL',
  ]) {
    await assert.rejects(() => layer.query({ sql, timeout: 30_000 }), SqlPolicyError);
  }

  assert.equal(calls, 0);
});

test('allows only SELECT, safe CTE, and EXPLAIN SELECT statement forms', async () => {
  let calls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return {
          async query() {
            calls += 1;
            return [[]];
          },
          async end() {},
        } as never;
      },
    },
  });

  for (const sql of ['SELECT 1', 'SELECT 1;', 'WITH current_value AS (SELECT 1) SELECT * FROM current_value', 'EXPLAIN SELECT * FROM accounts']) {
    await layer.query({ sql, timeout: 30_000 });
  }

  assert.equal(calls, 4);
});

test('redacts driver query errors', async () => {
  const layer = createConnectionLayer({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return {
          async query() {
            throw new Error('mysql://user:secret@host/internal driver details');
          },
          async end() {},
        } as never;
      },
    },
  });

  await assert.rejects(
    () => layer.query({ sql: 'SELECT 1', timeout: 30_000 }),
    (error: unknown) => {
      assert(error instanceof ConnectionError);
      assert.equal(error.message, 'Unable to execute the read-only query.');
      assert.doesNotMatch(error.message, /secret|driver details/);
      return true;
    },
  );
});

test('rejects DML when the opt-in is unset or explicitly false', async () => {
  for (const environment of [validEnvironment(), validEnvironment({ MYSQL_DML_ENABLED: 'false' })]) {
    let executeCalls = 0;
    const layer = createConnectionLayer({
      environment,
      driver: {
        createPool() {
          return {
            async query() {
              return [[]];
            },
            async execute() {
              executeCalls += 1;
              return [{ affectedRows: 1 }, []];
            },
            async end() {},
          } as never;
        },
      },
    });

    await assert.rejects(
      () =>
        layer.dml.executeDml(
          new Proxy(
            {},
            {
              get() {
                throw new Error('raw statement access');
              },
            },
          ) as never,
        ),
      (error: unknown) => {
        assert(error instanceof DmlDisabledError);
        assert.equal(error.code, 'MYSQL_DML_DISABLED');
        assert.equal(error.message, 'DML execution is disabled.');
        return true;
      },
    );
    assert.equal(executeCalls, 0);
  }
});

test('rejects forged and throwing DML statements before the driver path', async () => {
  let executeCalls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });

  const forgedStatement = { sql: 'UPDATE accounts SET role = ?', values: ['admin'] };
  const throwingStatement = new Proxy(
    {},
    {
      get() {
        throw new Error('raw getter details');
      },
    },
  );
  const proxyAroundTrustedStatement = new Proxy(auditedUpdate(), {});

  for (const statement of [forgedStatement, throwingStatement, proxyAroundTrustedStatement]) {
    await assert.rejects(
      () => layer.dml.executeDml(statement as never),
      (error: unknown) => {
        assert(error instanceof DmlPolicyError);
        assert.equal(error.code, 'MYSQL_SQL_NOT_DML');
        assert.equal(error.message, 'Only one top-level DML statement is allowed.');
        assert.doesNotMatch(error.message, /raw getter details/);
        return true;
      },
    );
  }

  assert.equal(executeCalls, 0);
});

test('redacts DML driver errors and preserves timeout classification', async () => {
  let executeCalls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            executeCalls += 1;
            throw new Error('mysql://user:secret@host/raw driver details');
          },
          async end() {},
        } as never;
      },
    },
  });

  await assert.rejects(
    () => layer.dml.executeDml(auditedDelete()),
    (error: unknown) => {
      assert(error instanceof ConnectionError);
      assert.equal(error.message, 'Unable to execute the DML statement.');
      assert.doesNotMatch(error.message, /secret|raw driver details/);
      return true;
    },
  );
  assert.equal(executeCalls, 1);

  const timeoutLayer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            throw Object.assign(new Error('raw timeout details'), { code: 'ETIMEDOUT' });
          },
          async end() {},
        } as never;
      },
    },
  });

  await assert.rejects(
    () => timeoutLayer.dml.executeDml(auditedUpdate()),
    (error: unknown) => {
      assert.equal((error as ConnectionError).code, 'MYSQL_QUERY_TIMEOUT');
      assert.equal((error as Error).message, 'MySQL query timed out.');
      assert.doesNotMatch((error as Error).message, /raw timeout details/);
      return true;
    },
  );
});

test('closes the shared pool once after read and DML operations', async () => {
  let createPoolCalls = 0;
  let endCalls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        createPoolCalls += 1;
        return {
          async query() {
            return [[]];
          },
          async execute() {
            return [{ affectedRows: 1 }, []];
          },
          async end() {
            endCalls += 1;
          },
        } as never;
      },
    },
  });

  await layer.query({ sql: 'SELECT 1', timeout: 30_000 });
  await layer.dml.executeDml(auditedUpdate());
  await layer.close();

  assert.equal(createPoolCalls, 1);
  assert.equal(endCalls, 1);
});

test('creates opaque executable statements only from builder input', async () => {
  let receivedValues: unknown;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute(_options: unknown, values: unknown) {
            receivedValues = values;
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const statement = auditedUpdate();
  assert.deepEqual(Object.keys(statement), []);

  await layer.dml.executeDml(statement);

  assert.deepEqual(receivedValues, ['admin', 1]);
  assert(Object.isFrozen(receivedValues as object));
});

test('snapshots audit metadata when minting a DML capability', async () => {
  const input = {
    target: { schema: 'app', table: 'accounts', reason: 'original reason' },
    values: { role: 'admin' },
    filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
    limit: 1,
    columns: ['id', 'role'],
    primaryKey: ['id'],
  };
  const statement = createAuditedDmlStatement('update', input);
  input.target.table = 'changed';
  input.target.reason = 'changed reason';
  input.filters[0] = { column: 'role', operator: 'eq', value: 2 };
  const lines: string[] = [];
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    dmlAuditWriter: (line) => lines.push(line),
    driver: {
      createPool: () =>
        ({
          async query() {
            return [[]];
          },
          async execute() {
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        }) as never,
    },
  });
  await layer.dml.executeDml(statement);
  const [started, completed] = lines.map((line) => JSON.parse(line));
  assert.equal(started.target.table, 'accounts');
  assert.equal(started.reason, 'original reason');
  assert.equal(started.requestHash, completed.requestHash);
  assert.doesNotMatch(lines.join('\n'), /changed/);
  assert.throws(() => createAuditedDmlStatement('insert' as never, input as never), DmlPolicyError);
  assert.throws(() => createAuditedDmlStatement('update', new Proxy(input, {}) as never), DmlPolicyError);
});

test('rejects malformed builder inputs without invoking the DML driver', async () => {
  let executeCalls = 0;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 1 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  assert.throws(
    () =>
      createAuditedDmlStatement('update', {
        target: { schema: 'app', table: 'accounts', reason: 'controlled update' },
        values: { unknown: 'admin' },
        filters: [{ column: 'id', operator: 'eq', value: 1 }],
        limit: 1,
        columns: ['id', 'role'],
        primaryKey: ['id'],
      }),
    (error: unknown) => {
      assert(error instanceof DmlInputValidationError);
      return true;
    },
  );
  assert.equal(executeCalls, 0);
  await layer.close();
});

test('redacts driver errors while keeping the connection failure actionable', async () => {
  const pool = {
    async getConnection() {
      throw new Error('untrusted driver error');
    },
  };

  await assert.rejects(
    () => verifyConnection(pool as never),
    (error: unknown) => {
      assert(error instanceof ConnectionError);
      assert.match(error.message, /Unable to connect to MySQL/);
      assert.doesNotMatch(error.message, /untrusted driver error/);
      return true;
    },
  );
});

test('releases a connection after the opt-in connectivity check', async () => {
  let released = false;
  const pool = {
    async getConnection() {
      return {
        release() {
          released = true;
        },
      };
    },
  };

  await verifyConnection(pool as never);
  assert.equal(released, true);
});

test('redacts cleanup failures after the opt-in connectivity check', async () => {
  const pool = {
    async getConnection() {
      return {
        release() {
          throw new Error('untrusted release error');
        },
      };
    },
  };

  await assert.rejects(
    () => verifyConnection(pool as never),
    (error: unknown) => {
      assert(error instanceof ConnectionError);
      assert.match(error.message, /cleanup failed/);
      assert.doesNotMatch(error.message, /untrusted release error/);
      return true;
    },
  );
});
