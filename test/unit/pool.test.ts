import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResultSetHeader, RowDataPacket } from 'mysql2';

import {
  ConnectionError,
  createConnectionLayer,
  createInternalDmlStatement,
  DmlDisabledError,
  type ConnectionLayer,
  verifyConnection,
} from '../../src/db/pool.js';
import { DmlPolicyError, SqlPolicyError } from '../../src/db/sql-policy.js';

import { validEnvironment } from './fixtures.js';

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

  const [result] = await layer.dml.executeDml(createInternalDmlStatement('UPDATE accounts SET role = ? WHERE id = ?', ['admin', 1]));

  assert.deepEqual(result, { affectedRows: 1 });
  assert.equal(queryCalls, 0);
  assert.equal(executeCalls, 1);
  assert.deepEqual(receivedOptions, { sql: 'UPDATE accounts SET role = ? WHERE id = ?', timeout: 30_000 });
  assert.deepEqual(receivedValues, ['admin', 1]);
});

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

  const [result] = await layer.dml.executeDml<ResultSetHeader>(createInternalDmlStatement('INSERT INTO accounts (name) VALUES (?)', ['Ada']));

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

  for (const sql of ['SELECT 1', 'CREATE TABLE accounts (id INT)', 'SHOW TABLES', 'UPDATE accounts SET role = ?; DELETE FROM accounts']) {
    await assert.rejects(
      () => layer.dml.executeDml(createInternalDmlStatement(sql)),
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
  const proxyAroundTrustedStatement = new Proxy(createInternalDmlStatement('UPDATE accounts SET role = ?', ['admin']), {});

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
    () => layer.dml.executeDml(createInternalDmlStatement('DELETE FROM accounts WHERE id = ?', [1])),
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
    () => timeoutLayer.dml.executeDml(createInternalDmlStatement('UPDATE accounts SET role = ? WHERE id = ?', ['admin', 1])),
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
  await layer.dml.executeDml(createInternalDmlStatement('UPDATE accounts SET role = ? WHERE id = ?', ['admin', 1]));
  await layer.close();

  assert.equal(createPoolCalls, 1);
  assert.equal(endCalls, 1);
});

test('snapshots prepared values in the internal DML statement factory', async () => {
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
  const sourceValues = {
    role: 'admin',
    nested: ['before'],
    metadata: { source: 'internal' },
  };
  const statement = createInternalDmlStatement('UPDATE accounts SET role = ? WHERE id = ?', sourceValues);
  assert.deepEqual(Object.keys(statement), []);

  sourceValues.role = 'changed';
  sourceValues.nested[0] = 'changed';
  sourceValues.metadata.source = 'changed';

  await layer.dml.executeDml(statement);

  assert.deepEqual(receivedValues, {
    role: 'admin',
    nested: ['before'],
    metadata: { source: 'internal' },
  });
  assert(Object.isFrozen(receivedValues as object));
  assert(Object.isFrozen((receivedValues as { nested: unknown[] }).nested));
  assert(Object.isFrozen((receivedValues as { metadata: object }).metadata));
});

test('rejects cyclic prepared values without invoking the DML driver', async () => {
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
  const cyclicValues = {} as Record<string, import('mysql2').ExecuteValues>;
  cyclicValues.self = cyclicValues;

  assert.throws(
    () => createInternalDmlStatement('UPDATE accounts SET role = ?', cyclicValues),
    (error: unknown) => {
      assert(error instanceof DmlPolicyError);
      assert.equal(error.code, 'MYSQL_SQL_NOT_DML');
      assert.equal(error.message, 'Only one top-level DML statement is allowed.');
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
