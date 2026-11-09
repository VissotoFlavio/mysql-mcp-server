import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

test('creates an MCP stdio server and retains ownership of the database pool lifecycle', async () => {
  let poolClosed = false;
  const pool = {
    async query() {
      return [[]];
    },
    async end() {
      poolClosed = true;
    },
  };
  const application = createMcpApplication({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return pool as never;
      },
    },
  });
  const transport = new StdioServerTransport(new PassThrough(), new PassThrough());

  await application.server.connect(transport);

  await application.close();
  assert.equal(poolClosed, true);
});

test('exposes DML and DDL opt-in state through application composition', async () => {
  for (const [override, expectedDml, expectedDdl, expectedCreateSchema] of [
    [{}, false, false, false],
    [{ MYSQL_DML_ENABLED: 'false', MYSQL_DDL_ENABLED: 'false' }, false, false, false],
    [{ MYSQL_DML_ENABLED: 'true', MYSQL_DDL_ENABLED: 'true' }, true, true, false],
    [{ MYSQL_DDL_ENABLED: 'false', MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'true' }, false, false, false],
    [{ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'true' }, false, true, true],
  ] as const) {
    const application = createMcpApplication({
      environment: validEnvironment(override),
      driver: {
        createPool() {
          return {
            async query() {
              return [[]];
            },
            async end() {},
          } as never;
        },
      },
    });

    assert.equal(application.mysql.dmlEnabled, expectedDml);
    assert.equal(application.mysql.ddlEnabled, expectedDdl);
    assert.equal(application.mysql.createSchemaEnabled, expectedCreateSchema);
    await application.close();
  }
});

test('advertises DROP COLUMN only when all capability flags are enabled', async () => {
  for (const [override, expected] of [
    [{ MYSQL_DDL_ENABLED: 'true' }, false],
    [{ MYSQL_DDL_ENABLED: 'false', MYSQL_DDL_DROP_COLUMN_ENABLED: 'true' }, false],
    [{ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_ENABLED: 'true' }, true],
    [{ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_ENABLED: 'true', MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE: 'true' }, true],
  ] as const) {
    const application = createMcpApplication({
      environment: validEnvironment(override),
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[]];
            },
            async end() {},
          }) as never,
      },
    });
    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
    await application.server.connect(transport);
    assert.equal(application.mysql.dropColumnEnabled, expected);
    await application.close();
  }
});

test('advertises DROP TABLE only when both destructive capability flags are enabled', async () => {
  for (const [override, expected] of [
    [{ MYSQL_DDL_ENABLED: 'true' }, false],
    [{ MYSQL_DDL_ENABLED: 'false', MYSQL_DDL_DROP_TABLE_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'true' }, false],
    [{ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_ENABLED: 'true' }, false],
    [{ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_ENABLED: 'true', MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE: 'true' }, true],
  ] as const) {
    const application = createMcpApplication({
      environment: validEnvironment(override),
      driver: {
        createPool: () =>
          ({
            async query() {
              return [[]];
            },
            async end() {},
          }) as never,
      },
    });
    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
    await application.server.connect(transport);
    assert.equal(application.mysql.dropTableEnabled && application.mysql.dropTableMetadataComplete, expected);
    await application.close();
  }
});
