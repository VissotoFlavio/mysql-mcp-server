import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectionLayer, verifyConnection } from '../../src/db/pool.js';

test(
  'connects using externally supplied MySQL configuration',
  {
    skip: process.env.MYSQL_INTEGRATION_TEST !== 'true',
  },
  async () => {
    const layer = createConnectionLayer();

    try {
      await verifyConnection(layer.pool);
      assert.ok(layer.pool);
    } finally {
      await layer.close();
    }
  },
);
