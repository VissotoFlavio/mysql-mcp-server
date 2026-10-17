import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_METADATA_RESULTS, describeAccessibleTable, listAccessibleSchemas, listAccessibleTables } from '../../src/db/metadata.js';
import { createConnectionLayer } from '../../src/db/pool.js';

test(
  'connects using externally supplied MySQL configuration',
  {
    skip: process.env.MYSQL_INTEGRATION_TEST !== 'true',
  },
  async () => {
    const layer = createConnectionLayer();
    const schema = process.env.MYSQL_DATABASE;

    try {
      await layer.verifyConnection();

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

test(
  'describes an explicitly configured accessible table or view without reading rows',
  {
    skip: process.env.MYSQL_INTEGRATION_TEST !== 'true',
  },
  async () => {
    const layer = createConnectionLayer();
    const schema = process.env.MYSQL_INTEGRATION_SCHEMA ?? process.env.MYSQL_DATABASE;
    const table = process.env.MYSQL_INTEGRATION_TABLE;

    try {
      assert.ok(schema, 'Set MYSQL_INTEGRATION_SCHEMA or MYSQL_DATABASE for metadata integration testing.');
      assert.ok(table, 'Set MYSQL_INTEGRATION_TABLE to an accessible table or view for metadata integration testing.');

      const description = await describeAccessibleTable(layer, schema, table);

      assert.ok(description, 'The configured table or view must be visible to the configured MySQL account.');
      assert.equal(description.table.schemaName, schema);
      assert.equal(description.table.tableName, table);
      assert.ok(['BASE TABLE', 'VIEW'].includes(description.table.tableType));
      assert.ok(description.columns.length > 0 && description.columns.length <= MAX_METADATA_RESULTS);
      assert.ok(
        description.columns.every(
          ({ columnName, dataType, isNullable, columnKey }) =>
            columnName.length > 0 && dataType.length > 0 && typeof isNullable === 'boolean' && typeof columnKey === 'string',
        ),
      );
    } finally {
      await layer.close();
    }
  },
);
