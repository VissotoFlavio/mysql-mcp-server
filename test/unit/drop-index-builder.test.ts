import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDropIndexStatement } from '../../src/db/ddl-builder.js';
import { assertDropIndexSql, DdlPolicyError } from '../../src/db/sql-policy.js';

test('renders only canonical named DROP INDEX SQL', () => {
  const statement = buildDropIndexStatement({ schema: 'app', table: 'orders', index: 'orders_created_idx', reason: 'Remove redundancy.' });
  assert.equal(statement.sql, 'DROP INDEX `orders_created_idx` ON `app`.`orders`');
  assert.doesNotThrow(() => assertDropIndexSql(statement.sql));
  for (const sql of [
    'DROP INDEX `orders_created_idx` ON `app`.`orders`; DROP TABLE `app`.`orders`',
    'DROP INDEX `orders_created_idx` ON `app`.`orders` ALGORITHM=INPLACE',
    'ALTER TABLE `app`.`orders` DROP INDEX `orders_created_idx`',
    'DROP PRIMARY KEY ON `app`.`orders`',
  ]) {
    assert.throws(() => assertDropIndexSql(sql), DdlPolicyError);
  }
});
