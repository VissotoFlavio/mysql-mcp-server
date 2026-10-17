import assert from 'node:assert/strict';
import test from 'node:test';

import { listAccessibleSchemas, listAccessibleTables } from '../../src/db/metadata.js';
import { createConnectionLayer, verifyConnection } from '../../src/db/pool.js';

test(
  'connects using externally supplied MySQL configuration',
  {
    skip: process.env.MYSQL_INTEGRATION_TEST !== 'true',
  },
  async () => {
    const layer = createConnectionLayer();
    const schema = process.env.MYSQL_DATABASE;

    try {
      await verifyConnection(layer.pool);
      assert.ok(layer.pool);

      assert.ok(schema);
      const schemas = await listAccessibleSchemas(layer);
      const tables = await listAccessibleTables(layer, schema);

      assert.ok(schemas.some(({ schemaName }) => schemaName === schema));
      assert.ok(tables.every(({ schemaName, tableName, tableType }) => schemaName === schema && tableName.length > 0 && tableType.length > 0));
    } finally {
      await layer.close();
    }
  },
);
