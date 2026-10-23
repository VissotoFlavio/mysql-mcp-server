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

test('exposes the DML opt-in state through application composition', async () => {
  for (const [override, expected] of [
    [{}, false],
    [{ MYSQL_DML_ENABLED: 'false' }, false],
    [{ MYSQL_DML_ENABLED: 'true' }, true],
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

    assert.equal(application.mysql.dmlEnabled, expected);
    await application.close();
  }
});
