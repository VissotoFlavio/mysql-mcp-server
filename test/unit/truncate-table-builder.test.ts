import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTruncateTableStatement } from '../../src/db/ddl-builder.js';
import { assertTruncateTableSql } from '../../src/db/sql-policy.js';
import { normalizeTruncateTableInput } from '../../src/tools/truncate-table-input.js';

test('renders only the canonical single-target TRUNCATE TABLE statement', () => {
  const statement = buildTruncateTableStatement(
    normalizeTruncateTableInput({ schema: 'app', table: 'orders', reason: 'Clear it.', confirmation: `TRUNCATE_TABLE:${'a'.repeat(64)}` }),
  );
  assert.equal(statement.sql, 'TRUNCATE TABLE `app`.`orders`');
  assert.doesNotThrow(() => assertTruncateTableSql(statement.sql));
  for (const sql of [
    'TRUNCATE `app`.`orders`',
    'TRUNCATE TABLE IF EXISTS `app`.`orders`',
    'TRUNCATE TABLE `app`.`orders`, `app`.`archive`',
    'TRUNCATE TABLE `app`.`orders` CASCADE',
    'DELETE FROM `app`.`orders`',
  ])
    assert.throws(() => assertTruncateTableSql(sql));
});
