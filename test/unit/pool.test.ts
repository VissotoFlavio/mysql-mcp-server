import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionError, createConnectionLayer, verifyConnection } from '../../src/db/pool.js';

import { validEnvironment } from './fixtures.js';

test('creates a bounded pool with secure driver options', async () => {
  let suppliedOptions: Record<string, unknown> | undefined;
  const fakePool = {
    async end() {},
  };
  const driver = {
    createPool(options: Record<string, unknown>) {
      suppliedOptions = options;
      return fakePool;
    },
  };

  const layer = createConnectionLayer({ environment: validEnvironment(), driver: driver as never });

  assert.equal(layer.pool, fakePool);
  assert.equal(layer.queryTimeoutMs, 10_000);
  assert.deepEqual(layer.queryOptions(), { timeout: 10_000 });
  assert.equal(suppliedOptions?.waitForConnections, true);
  assert.equal(suppliedOptions?.connectionLimit, 5);
  assert.equal(suppliedOptions?.connectTimeout, 5_000);
  assert.equal(suppliedOptions?.multipleStatements, false);
  assert.equal(suppliedOptions?.ssl, undefined);

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
