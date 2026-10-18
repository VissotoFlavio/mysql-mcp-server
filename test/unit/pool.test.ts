import assert from 'node:assert/strict';
import test from 'node:test';

import type { RowDataPacket } from 'mysql2';

import { ConnectionError, createConnectionLayer, verifyConnection } from '../../src/db/pool.js';
import { SqlPolicyError } from '../../src/db/sql-policy.js';

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
  assert.equal(suppliedOptions?.ssl, undefined);

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
