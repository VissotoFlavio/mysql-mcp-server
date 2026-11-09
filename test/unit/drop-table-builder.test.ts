import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDropTableStatement } from '../../src/db/ddl-builder.js';
import { assertDropTableSql } from '../../src/db/sql-policy.js';
import { normalizeDropTableInput } from '../../src/tools/drop-table-input.js';

test('renders only the canonical single-target DROP TABLE statement', () => {
  const statement = buildDropTableStatement(
    normalizeDropTableInput({ schema: 'app', table: 'orders', reason: 'Remove it.', confirmation: `DROP_TABLE:${'a'.repeat(64)}` }),
  );
  assert.equal(statement.sql, 'DROP TABLE `app`.`orders`');
  assert.doesNotThrow(() => assertDropTableSql(statement.sql));
  for (const sql of [
    'DROP TABLE IF EXISTS `app`.`orders`',
    'DROP TABLE `app`.`orders`, `app`.`archive`',
    'DROP TABLE `app`.`orders` CASCADE',
    'DROP VIEW `app`.`orders`',
  ])
    assert.throws(() => assertDropTableSql(sql));
});
