import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConfigurationError, DEFAULTS, loadConnectionConfig } from '../../src/config.js';
import { validEnvironment } from './fixtures.js';

test('loads a bounded configuration with conservative defaults', () => {
  const config = loadConnectionConfig(validEnvironment());

  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.poolLimit, DEFAULTS.poolLimit);
  assert.equal(config.connectTimeoutMs, DEFAULTS.connectTimeoutMs);
  assert.equal(config.queryTimeoutMs, DEFAULTS.queryTimeoutMs);
  assert.equal(config.tls, undefined);
});

test('rejects each required connection setting when missing', () => {
  for (const name of ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
    const environment = { ...validEnvironment() };
    delete environment[name];

    assert.throws(() => loadConnectionConfig(environment), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, new RegExp(name));
      return true;
    });
  }
});

test('rejects malformed and unsafe connection configuration', () => {
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_HOST: 'not a host' })),
    /MYSQL_HOST must be a hostname or IPv4 address/,
  );
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_PORT: '0' })), /MYSQL_PORT must be between/);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_POOL_LIMIT: '21' })), /MYSQL_POOL_LIMIT must be between/);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_TLS: 'sometimes' })), /MYSQL_TLS must be true or false/);
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_TLS_CA_FILE: randomUUID() })),
    /MYSQL_TLS must be true/,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_TLS: 'true', MYSQL_TLS_REJECT_UNAUTHORIZED: 'false' })),
    /MYSQL_TLS_REJECT_UNAUTHORIZED must be true/,
  );
});

test('loads optional TLS material only from externally supplied paths', () => {
  const readRequests: Array<[string, string]> = [];
  const certificatePath = randomUUID();
  const certificate = randomUUID();
  const config = loadConnectionConfig(
    validEnvironment({
      MYSQL_TLS: 'true',
      MYSQL_TLS_CA_FILE: certificatePath,
    }),
    {
      readFile(path, encoding) {
        readRequests.push([path, encoding]);
        return certificate;
      },
    },
  );

  assert.deepEqual(readRequests, [[certificatePath, 'utf8']]);
  assert.deepEqual(config.tls, {
    ca: certificate,
    rejectUnauthorized: true,
  });
});

test('does not reveal TLS file paths when TLS material cannot be read', () => {
  const keyPath = randomUUID();

  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_TLS: 'true', MYSQL_TLS_KEY_FILE: keyPath }), {
      readFile() {
        throw new Error('missing');
      },
    }),
    (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /MYSQL_TLS_KEY_FILE/);
      assert.doesNotMatch(error.message, new RegExp(keyPath));
      return true;
    },
  );
});
