import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAlterTableDropForeignKeyStatement } from '../../src/db/ddl-builder.js';
import { assertAlterTableDropForeignKeySql, DdlPolicyError } from '../../src/db/sql-policy.js';

test('renders only canonical named DROP FOREIGN KEY SQL', () => {
  const statement = buildAlterTableDropForeignKeyStatement({
    schema: 'app',
    table: 'orders',
    constraint: 'orders_customer_fk',
    reason: 'Remove obsolete relationship.',
  });
  assert.equal(statement.sql, 'ALTER TABLE `app`.`orders` DROP FOREIGN KEY `orders_customer_fk`');
  assert.doesNotThrow(() => assertAlterTableDropForeignKeySql(statement.sql));
  for (const sql of [
    'ALTER TABLE `app`.`orders` DROP FOREIGN KEY `orders_customer_fk`; DROP TABLE `app`.`orders`',
    'ALTER TABLE `app`.`orders` DROP CONSTRAINT `orders_customer_fk`',
    'ALTER TABLE `app`.`orders` DROP FOREIGN KEY `orders_customer_fk`, DROP COLUMN `customer_id`',
  ])
    assert.throws(() => assertAlterTableDropForeignKeySql(sql), DdlPolicyError);
});
