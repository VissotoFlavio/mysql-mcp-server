import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectionError,
  createConnectionLayer,
  createCreateIndexStatement,
  createCreateTableStatement,
  DdlDisabledError,
  type ConnectionLayer,
} from '../../src/db/pool.js';
import { DdlPolicyError, assertCreateTableSql } from '../../src/db/sql-policy.js';

import { validEnvironment } from './fixtures.js';

const createAccountsStatement = () =>
  createCreateTableStatement({
    schema: 'app',
    table: 'accounts',
    reason: 'Store application accounts.',
    columns: [
      { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
      { name: 'name', type: { kind: 'varchar', length: 255 }, nullable: false },
    ],
    primaryKey: ['id'],
  });

const createAccountsIndexStatement = () =>
  createCreateIndexStatement({
    schema: 'app',
    table: 'accounts',
    index: 'accounts_name_idx',
    columns: ['name'],
    reason: 'Support account-name lookups.',
  });

test('executes CREATE INDEX only through its matching capability and audits the index target', async () => {
  let executeCalls = 0;
  const auditLines: string[] = [];
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    ddlAuditWriter: (line) => auditLines.push(line),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'CREATE INDEX `accounts_name_idx` ON `app`.`accounts` (`name`)');
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const indexStatement = createAccountsIndexStatement();
  const tableStatement = createAccountsStatement();
  assert.deepEqual(await layer.ddl.executeCreateIndex(indexStatement), { warningStatus: 0 });
  await assert.rejects(() => layer.ddl.executeCreateTable(indexStatement as never), DdlPolicyError);
  await assert.rejects(() => layer.ddl.executeCreateIndex(tableStatement as never), DdlPolicyError);
  assert.equal(executeCalls, 1);
  const [started, completed] = auditLines.map((line) => JSON.parse(line));
  assert.equal(started.operation, 'create_index');
  assert.equal(completed.target.index, 'accounts_name_idx');
  assert.equal(completed.result, 'succeeded');
  await layer.close();
});

test('executes only a capability-minted canonical CREATE TABLE and returns narrow metadata', async () => {
  let executeCalls = 0;
  let options: unknown;
  const layer = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute(receivedOptions: unknown) {
            executeCalls += 1;
            options = receivedOptions;
            return [{ affectedRows: 0, warningStatus: 0, secret: 'must not escape' }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const readOnlyLayer: ConnectionLayer = layer;
  const statement = createAccountsStatement();

  assert.equal('executeCreateTable' in readOnlyLayer, false);
  assert.deepEqual(Object.keys(statement), []);
  assert.deepEqual(await layer.ddl.executeCreateTable(statement), { warningStatus: 0 });
  assert.equal(executeCalls, 1);
  assert.deepEqual(options, {
    sql: 'CREATE TABLE `app`.`accounts` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `name` VARCHAR(255) NOT NULL, PRIMARY KEY (`id`))',
    timeout: 30_000,
  });
  await layer.close();
});

test('rejects disabled, forged, and malformed DDL capabilities before the driver', async () => {
  let executeCalls = 0;
  const disabled = createConnectionLayer({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });

  await assert.rejects(() => disabled.ddl.executeCreateTable(createAccountsStatement()), DdlDisabledError);
  assert.equal(executeCalls, 0);
  await disabled.close();

  const enabled = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });

  for (const statement of [
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL, PRIMARY KEY (`id`))',
    { sql: 'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL, PRIMARY KEY (`id`))' },
    Object.freeze({}),
  ]) {
    await assert.rejects(() => enabled.ddl.executeCreateTable(statement as never), DdlPolicyError);
  }
  assert.equal(executeCalls, 0);
  await enabled.close();
});

test('strict DDL policy allows just one canonical CREATE TABLE form', () => {
  assert.doesNotThrow(() => assertCreateTableSql('CREATE TABLE `app`.`accounts` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`))'));

  for (const sql of [
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL, PRIMARY KEY (`id`)); DROP TABLE `app`.`accounts`',
    'CREATE TABLE `app`.`accounts` AS SELECT 1',
    'ALTER TABLE `app`.`accounts` ADD COLUMN `role` INT',
    'CREATE TABLE `app`.`accounts` (`id` DECIMAL(2,3) NOT NULL, PRIMARY KEY (`id`))',
    'CREATE TABLE `app``shadow`.`accounts` (`id` INT NOT NULL, PRIMARY KEY (`id`))',
    'CREATE TABLE `app`.`accounts` (`id` TINYINT(1) NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`))',
    'CREATE TABLE `app`.`accounts` (`id` TEXT NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`))',
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL AUTO_INCREMENT, `sequence` INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`, `sequence`))',
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL AUTO_INCREMENT, `other` INT NOT NULL, PRIMARY KEY (`other`))',
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL, `sequence` INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`, `sequence`))',
    'CREATE TABLE `app`.`accounts` (`id` INT NULL AUTO_INCREMENT, PRIMARY KEY (`id`))',
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL, PRIMARY KEY (`missing`))',
    'CREATE TABLE `app`.`accounts` (`id` INT NOT NULL, PRIMARY KEY (`id`, `id`))',
  ]) {
    assert.throws(() => assertCreateTableSql(sql), DdlPolicyError);
  }
});

test('redacts CREATE TABLE driver failures and rejects malformed result metadata', async () => {
  const failed = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            throw new Error('mysql://user:secret@host/raw driver details');
          },
          async end() {},
        } as never;
      },
    },
  });

  await assert.rejects(
    () => failed.ddl.executeCreateTable(createAccountsStatement()),
    (error: unknown) => {
      assert(error instanceof ConnectionError);
      assert.equal(error.message, 'Unable to execute the CREATE TABLE statement.');
      assert.doesNotMatch(error.message, /secret|raw driver details/);
      return true;
    },
  );
  await failed.close();

  const malformed = createConnectionLayer({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[]];
          },
          async execute() {
            return [{ affectedRows: 1, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  await assert.rejects(() => malformed.ddl.executeCreateTable(createAccountsStatement()), /CREATE TABLE result was invalid/);
  await malformed.close();
});
