import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAlterTableDropColumnStatement } from '../../src/db/ddl-builder.js';
import { assertAlterTableDropColumnSql, DdlPolicyError } from '../../src/db/sql-policy.js';

test('renders only canonical one-column DROP COLUMN SQL', () => {
  const statement = buildAlterTableDropColumnStatement({
    schema: 'app',
    table: 'orders',
    column: 'obsolete_label',
    reason: 'Remove it.',
    confirmation: 'DROP_COLUMN',
  });
  assert.equal(statement.sql, 'ALTER TABLE `app`.`orders` DROP COLUMN `obsolete_label`');
  assert.doesNotThrow(() => assertAlterTableDropColumnSql(statement.sql));
  for (const sql of [
    'ALTER TABLE `app`.`orders` DROP COLUMN `obsolete_label`; DROP TABLE `app`.`orders`',
    'ALTER TABLE `app`.`orders` DROP COLUMN `obsolete_label`, DROP COLUMN `other`',
    'ALTER TABLE `app`.`orders` DROP COLUMN obsolete_label',
    'ALTER TABLE `app`.`orders` DROP COLUMN `obsolete_label` CASCADE',
  ])
    assert.throws(() => assertAlterTableDropColumnSql(sql), DdlPolicyError);
});
