import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRenameTableStatement } from '../../src/db/ddl-builder.js';
import { assertRenameTableSql, DdlPolicyError } from '../../src/db/sql-policy.js';

test('renders and accepts only one canonical same-schema RENAME TABLE statement', () => {
  const statement = buildRenameTableStatement({ schema: 'app', table: 'accounts', newTable: 'customers', reason: 'Rename the table.' });
  assert.equal(statement.sql, 'RENAME TABLE `app`.`accounts` TO `app`.`customers`');
  assert.doesNotThrow(() => assertRenameTableSql(statement.sql));
  for (const sql of [
    'RENAME TABLE `app`.`accounts` TO `other`.`customers`',
    'RENAME TABLE `app`.`accounts` TO `app`.`accounts`',
    'RENAME TABLE `app`.`accounts` TO `app`.`customers`, `app`.`other` TO `app`.`third`',
    'ALTER TABLE `app`.`accounts` RENAME `customers`',
  ])
    assert.throws(() => assertRenameTableSql(sql), DdlPolicyError);
});
