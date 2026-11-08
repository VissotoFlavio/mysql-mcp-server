import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDropViewStatement } from '../../src/db/ddl-builder.js';
import { assertDropViewSql } from '../../src/db/sql-policy.js';
import { normalizeDropViewInput } from '../../src/tools/drop-view-input.js';

test('renders only the canonical single-target DROP VIEW statement', () => {
  const statement = buildDropViewStatement(
    normalizeDropViewInput({ schema: 'app', view: 'account_labels', reason: 'Remove it.', confirmation: 'DROP_VIEW' }),
  );
  assert.equal(statement.sql, 'DROP VIEW `app`.`account_labels`');
  assert.doesNotThrow(() => assertDropViewSql(statement.sql));
  for (const sql of [
    'DROP VIEW IF EXISTS `app`.`account_labels`',
    'DROP VIEW `app`.`account_labels`, `app`.`account_report`',
    'DROP VIEW `app`.`account_labels` CASCADE',
    'DROP TABLE `app`.`account_labels`',
  ])
    assert.throws(() => assertDropViewSql(sql));
});
