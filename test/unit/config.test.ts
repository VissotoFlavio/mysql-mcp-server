import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ConfigurationError, DEFAULTS, loadConnectionConfig } from '../../src/config.js';

import { validEnvironment } from './fixtures.js';

test('loads a bounded configuration with conservative defaults', () => {
  const config = loadConnectionConfig(validEnvironment());

  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.poolLimit, 2);
  assert.equal(config.queueLimit, DEFAULTS.queueLimit);
  assert.equal(config.connectTimeoutMs, DEFAULTS.connectTimeoutMs);
  assert.equal(config.queryTimeoutMs, 30_000);
  assert.equal(config.dmlEnabled, false);
  assert.equal(config.ddlEnabled, false);
  assert.equal(config.createSchemaEnabled, false);
  assert.equal(config.dropSchemaEnabled, false);
  assert.deepEqual(config.dropSchemaAllowlist, []);
  assert.equal(config.dropViewMetadataComplete, false);
  assert.equal(config.dropColumnEnabled, false);
  assert.equal(config.dropColumnMetadataComplete, false);
  assert.equal(config.dropTableEnabled, false);
  assert.equal(config.dropTableMetadataComplete, false);
  assert.equal(config.tls, undefined);
});

test('distinguishes absent optional values from present empty values', () => {
  const minimal = validEnvironment();

  assert.equal(loadConnectionConfig(minimal).port, DEFAULTS.port);
  assert.throws(() => loadConnectionConfig({ ...minimal, MYSQL_PORT: '' }), /MYSQL_PORT must not be empty when provided/);
  assert.throws(() => loadConnectionConfig({ ...minimal, MYSQL_TLS: '' }), /MYSQL_TLS must not be empty when provided/);
  assert.throws(
    () => loadConnectionConfig({ ...minimal, MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: '' }),
    /MYSQL_DDL_DROP_SCHEMA_ALLOWLIST must be a comma-separated list/,
  );
});

test('published .env.example is valid after filling only required connection values', () => {
  const template = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const environment: Record<string, string> = {};

  for (const line of template.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    assert.notEqual(separator, -1, `expected an environment assignment: ${line}`);
    environment[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }

  assert.deepEqual(
    Object.entries(environment)
      .filter(([, value]) => value.length === 0)
      .map(([name]) => name),
    ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'],
  );

  const config = loadConnectionConfig({
    ...environment,
    MYSQL_HOST: 'mysql.example.test',
    MYSQL_DATABASE: 'demo_catalog',
    MYSQL_USER: 'mcp_reader',
    MYSQL_PASSWORD: 'synthetic-password',
  });

  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.dmlEnabled, false);
  assert.equal(config.ddlEnabled, false);
  assert.equal(config.tls, undefined);
});

test('loads the DML opt-in flag only for explicit boolean values', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DML_ENABLED: 'false' })).dmlEnabled, false);
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DML_ENABLED: 'true' })).dmlEnabled, true);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_DML_ENABLED: 'TRUE' })), /MYSQL_DML_ENABLED must be true or false/);
});

test('loads the DDL opt-in flag only for explicit boolean values', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'false' })).ddlEnabled, false);
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true' })).ddlEnabled, true);

  for (const invalid of ['TRUE', ' true ', '\ttrue\n', '']) {
    assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: invalid })), /MYSQL_DDL_ENABLED must be true or false/);
  }
});

test('loads the strict CREATE SCHEMA opt-in only for explicit boolean values', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'false' })).createSchemaEnabled, false);
  assert.equal(
    loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'false', MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'true' })).createSchemaEnabled,
    false,
  );
  assert.equal(
    loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'true' })).createSchemaEnabled,
    true,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'TRUE' })),
    /MYSQL_DDL_CREATE_SCHEMA_ENABLED must be true or false/,
  );
});

test('loads the DROP SCHEMA opt-in and exact allowlist without permitting MYSQL_DATABASE', () => {
  assert.equal(
    loadConnectionConfig(
      validEnvironment({
        MYSQL_DDL_ENABLED: 'true',
        MYSQL_DDL_DROP_SCHEMA_ENABLED: 'true',
        MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated_a,isolated_b',
      }),
    ).dropSchemaEnabled,
    true,
  );
  assert.deepEqual(
    loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated_a,isolated_b' }))
      .dropSchemaAllowlist,
    ['isolated_a', 'isolated_b'],
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_SCHEMA_ENABLED: 'TRUE' })),
    /MYSQL_DDL_DROP_SCHEMA_ENABLED must be true or false/,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'isolated_a, isolated_b' })),
    /MYSQL_DDL_DROP_SCHEMA_ALLOWLIST must be a comma-separated list/,
  );
  const environment = validEnvironment();
  assert.throws(
    () => loadConnectionConfig({ ...environment, MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: environment.MYSQL_DATABASE }),
    /must not contain MYSQL_DATABASE/,
  );
  for (const invalid of [
    'Isolated',
    'isolated',
    'information_schema',
    'MYSQL',
    'performance_schema',
    'sys',
    'isolated`name',
    'isolated"name',
    `isolated\u200Bname`,
  ]) {
    assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: `isolated,${invalid}` })), /DROP_SCHEMA_ALLOWLIST/);
  }
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DATABASE: 'App', MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: 'app' })),
    /must not contain MYSQL_DATABASE/,
  );
  for (const systemSchema of ['INFORMATION_SCHEMA', 'mysql', 'NDBINFO', 'Performance_Schema', 'SYS']) {
    assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_SCHEMA_ALLOWLIST: systemSchema })), /protected system schema/);
  }
});

test('loads the DROP VIEW metadata completeness attestation only for explicit boolean values', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE: 'true' })).dropViewMetadataComplete, true);
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE: 'false' })).dropViewMetadataComplete, false);
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE: 'TRUE' })),
    /MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE must be true or false/,
  );
});

test('loads the separate DROP COLUMN opt-in only when DDL is enabled', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_COLUMN_ENABLED: 'true' })).dropColumnEnabled, false);
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_ENABLED: 'true' })).dropColumnEnabled, true);
  assert.equal(
    loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_ENABLED: 'false' })).dropColumnEnabled,
    false,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_COLUMN_ENABLED: 'TRUE' })),
    /MYSQL_DDL_DROP_COLUMN_ENABLED must be true or false/,
  );
});

test('loads the DROP COLUMN metadata completeness attestation only with the destructive opt-in', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'true' })).dropColumnMetadataComplete, false);
  assert.equal(
    loadConnectionConfig(
      validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'true' }),
    ).dropColumnMetadataComplete,
    true,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'TRUE' })),
    /MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE must be true or false/,
  );
});

test('loads the separate DROP TABLE opt-in and metadata completeness attestation only with DDL enabled', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_TABLE_ENABLED: 'true' })).dropTableEnabled, false);
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_ENABLED: 'true' })).dropTableEnabled, true);
  assert.equal(
    loadConnectionConfig(
      validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'true' }),
    ).dropTableMetadataComplete,
    true,
  );
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'true' })).dropTableMetadataComplete, false);
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_TABLE_ENABLED: 'TRUE' })),
    /MYSQL_DDL_DROP_TABLE_ENABLED must be true or false/,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'TRUE' })),
    /MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE must be true or false/,
  );
});

test('loads the separate TRUNCATE TABLE opt-in and metadata completeness attestation only with DDL enabled', () => {
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'true' })).truncateTableEnabled, false);
  assert.equal(
    loadConnectionConfig(validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'true' })).truncateTableEnabled,
    true,
  );
  assert.equal(
    loadConnectionConfig(
      validEnvironment({
        MYSQL_DDL_ENABLED: 'true',
        MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'true',
        MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE: 'true',
      }),
    ).truncateTableMetadataComplete,
    true,
  );
  assert.equal(loadConnectionConfig(validEnvironment({ MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE: 'true' })).truncateTableMetadataComplete, false);
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_TRUNCATE_TABLE_ENABLED: 'TRUE' })),
    /MYSQL_DDL_TRUNCATE_TABLE_ENABLED must be true or false/,
  );
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE: 'TRUE' })),
    /MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE must be true or false/,
  );
});

test('rejects each required connection setting when missing', () => {
  for (const name of ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
    const environment = { ...validEnvironment() };
    delete environment[name];

    assert.throws(
      () => loadConnectionConfig(environment),
      (error: unknown) => {
        assert(error instanceof ConfigurationError);
        assert.match(error.message, new RegExp(name));
        return true;
      },
    );
  }
});

test('rejects malformed and unsafe connection configuration', () => {
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_HOST: 'not a host' })), /MYSQL_HOST must be a hostname or IPv4 address/);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_PORT: '0' })), /MYSQL_PORT must be between/);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_POOL_LIMIT: '3' })), /MYSQL_POOL_LIMIT must be between/);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_QUEUE_LIMIT: '0' })), /MYSQL_QUEUE_LIMIT must be between/);
  assert.throws(
    () => loadConnectionConfig(validEnvironment({ MYSQL_DATABASE: 'inventory\0archive' })),
    /MYSQL_DATABASE contains unsupported characters/,
  );
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_TLS: 'sometimes' })), /MYSQL_TLS must be true or false/);
  assert.throws(() => loadConnectionConfig(validEnvironment({ MYSQL_TLS_CA_FILE: randomUUID() })), /MYSQL_TLS must be true/);
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
    () =>
      loadConnectionConfig(validEnvironment({ MYSQL_TLS: 'true', MYSQL_TLS_KEY_FILE: keyPath }), {
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
