import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

test('creates an MCP stdio server and retains ownership of the database pool lifecycle', async () => {
  let poolClosed = false;
  const pool = {
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
  assert.equal(application.mysql.pool, pool);

  await application.close();
  assert.equal(poolClosed, true);
});
