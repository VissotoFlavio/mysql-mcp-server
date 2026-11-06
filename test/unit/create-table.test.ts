import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}

function createApplication(execute?: (...args: unknown[]) => Promise<unknown>, ddlEnabled = true) {
  return createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: ddlEnabled ? 'true' : 'false' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[], []];
          },
          async execute(...args: unknown[]) {
            return execute?.(...args) ?? [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
}

async function connect(application: ReturnType<typeof createMcpApplication>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;
  clientTransport.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      const response = message as JsonRpcResponse;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  };
  await application.server.connect(serverTransport);
  await clientTransport.start();
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'create-table-unit-test', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request, close: () => application.close() };
}

function toolText(response: JsonRpcResponse): string {
  const content = response.result?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
  assert.equal(content[0]?.type, 'text');
  return content[0].text;
}

function input() {
  return {
    schema: 'app',
    table: 'accounts',
    reason: 'Create accounts for this service',
    columns: [
      { name: 'id', type: { kind: 'integer', integerType: 'bigint', unsigned: true }, nullable: false, autoIncrement: true },
      { name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false },
    ],
    primaryKey: ['id'],
  };
}

function uniqueIndexInput() {
  return {
    schema: 'app',
    table: 'accounts',
    index: 'accounts_email_uq',
    columns: ['email'],
    reason: 'Prevent duplicate account emails.',
  };
}

test('registers controlled DDL tools only with the DDL opt-in and preserves the existing tool surface', async () => {
  const disabled = createApplication(undefined, false);
  const enabled = createApplication();
  const disabledClient = await connect(disabled);
  const enabledClient = await connect(enabled);
  try {
    const disabledTools = (await disabledClient.request('tools/list', {})).result?.tools as ReadonlyArray<{ readonly name: string }>;
    const enabledTools = (await enabledClient.request('tools/list', {})).result?.tools as ReadonlyArray<{
      readonly name: string;
      readonly annotations?: Record<string, unknown>;
    }>;
    assert.equal(
      disabledTools.some(
        ({ name }) => name === 'create_table' || name === 'create_index' || name === 'create_unique_index' || name === 'alter_table_add_column',
      ),
      false,
    );
    assert.deepEqual(enabledTools.find(({ name }) => name === 'create_table')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(enabledTools.find(({ name }) => name === 'create_index')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(enabledTools.find(({ name }) => name === 'create_unique_index')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(enabledTools.find(({ name }) => name === 'alter_table_add_column')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(
      enabledTools.some(({ name }) => name === 'insert_rows'),
      false,
    );
    assert.deepEqual(
      enabledTools
        .filter(
          ({ name }) => name !== 'create_table' && name !== 'create_index' && name !== 'create_unique_index' && name !== 'alter_table_add_column',
        )
        .map(({ name }) => name)
        .sort(),
      disabledTools.map(({ name }) => name).sort(),
    );
  } finally {
    await disabledClient.close();
    await enabledClient.close();
  }
});

test('handles create_unique_index only after sanitized metadata and duplicate preflight', async () => {
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query(options: { sql: string }) {
            if (options.sql.includes('information_schema.STATISTICS')) return [[], []];
            if (options.sql.includes('duplicate_groups')) return [[{ duplicateExists: 0 }], []];
            return [
              [
                { schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', columnName: 'id', ordinalPosition: 1, extra: '' },
                { schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', columnName: 'email', ordinalPosition: 2, extra: '' },
              ],
              [],
            ];
          },
          async execute(options: { sql: string }) {
            executeCalls += 1;
            assert.equal(options.sql, 'CREATE UNIQUE INDEX `accounts_email_uq` ON `app`.`accounts` (`email`)');
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'create_unique_index', arguments: uniqueIndexInput() });
    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(JSON.parse(toolText(response)), {
      operation: 'create_unique_index',
      operationId: JSON.parse(toolText(response)).operationId,
      target: { schema: 'app', table: 'accounts', index: 'accounts_email_uq' },
      warnings: 0,
    });
    assert.equal(executeCalls, 1);
  } finally {
    await client.close();
  }
});

test('returns a sanitized create_unique_index duplicate preflight failure without execution', async () => {
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query(options: { sql: string }) {
            if (options.sql.includes('information_schema.STATISTICS')) return [[], []];
            if (options.sql.includes('duplicate_groups')) return [[{ duplicateExists: 1, email: 'must-not-leak' }], []];
            return [[{ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', columnName: 'email', ordinalPosition: 1, extra: '' }], []];
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
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'create_unique_index', arguments: uniqueIndexInput() });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, {
      code: 'MYSQL_DDL_DUPLICATE_DATA',
      message: 'The requested unique index conflicts with existing duplicate data.',
    });
    assert.equal(executeCalls, 0);
    assert.doesNotMatch(JSON.stringify(response), /must-not-leak|email/);
  } finally {
    await client.close();
  }
});

test('adds one nullable column only after table and duplicate-column preflight', async () => {
  let executed: unknown;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[{ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', columnName: 'id', ordinalPosition: 1 }], []];
          },
          async execute(options: unknown) {
            executed = options;
            return [{ affectedRows: 0, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', {
      name: 'alter_table_add_column',
      arguments: {
        schema: 'app',
        table: 'accounts',
        column: { name: 'nickname', type: { kind: 'varchar', length: 100 }, nullable: true },
        reason: 'Add an optional account nickname.',
      },
    });
    assert.equal(response.result?.isError, undefined);
    const result = JSON.parse(toolText(response)) as Record<string, unknown>;
    assert.deepEqual(result.target, { schema: 'app', table: 'accounts', column: 'nickname' });
    assert.equal(result.operation, 'alter_table_add_column');
    assert.deepEqual(executed, { sql: 'ALTER TABLE `app`.`accounts` ADD COLUMN `nickname` VARCHAR(100) NULL', timeout: 30_000 });
  } finally {
    await client.close();
  }
});

test('returns a sanitized ALTER TABLE failure without retrying', async () => {
  let calls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[{ schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE', columnName: 'id', ordinalPosition: 1 }], []];
          },
          async execute() {
            calls += 1;
            throw Object.assign(new Error('deadlock ddl-secret'), { code: 'ER_LOCK_DEADLOCK' });
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', {
      name: 'alter_table_add_column',
      arguments: {
        schema: 'app',
        table: 'accounts',
        column: { name: 'nickname', type: { kind: 'varchar', length: 100 }, nullable: true },
        reason: 'Add an optional account nickname.',
      },
    });
    assert.equal(response.result?.isError, true);
    assert.deepEqual(response.result?.structuredContent, {
      code: 'MYSQL_DDL_DEADLOCK',
      message: 'The DDL operation encountered a deadlock.',
    });
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(response), /ddl-secret|ALTER TABLE|VARCHAR/);
  } finally {
    await client.close();
  }
});

test('executes exactly one internal CREATE TABLE statement and returns only operation metadata', async () => {
  let calls = 0;
  let options: unknown;
  const application = createApplication(async (received) => {
    calls += 1;
    options = received;
    return [{ affectedRows: 0, warningStatus: 2 }, []];
  });
  const client = await connect(application);
  const request = input();
  try {
    const response = await client.request('tools/call', { name: 'create_table', arguments: request });
    const result = JSON.parse(toolText(response)) as Record<string, unknown>;
    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(result, {
      operation: 'create_table',
      operationId: result.operationId,
      target: { schema: 'app', table: 'accounts' },
      warnings: 2,
    });
    assert.equal(typeof result.operationId, 'string');
    assert.equal(calls, 1);
    assert.deepEqual(options, {
      sql: 'CREATE TABLE `app`.`accounts` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `email` VARCHAR(255) NOT NULL, PRIMARY KEY (`id`))',
      timeout: 30_000,
    });
    assert.doesNotMatch(JSON.stringify(response), /Create accounts|BIGINT|VARCHAR|AUTO_INCREMENT/);
  } finally {
    await client.close();
  }
});

test('returns sanitized invalid, permission, existing-table, and indeterminate outcomes', async () => {
  const cases: readonly [string, ReturnType<typeof input>, unknown, string, string | undefined][] = [
    ['invalid', { ...input(), columns: [] }, undefined, 'MYSQL_DDL_INVALID_ARGUMENT', undefined],
    [
      'permission',
      input(),
      Object.assign(new Error('Access denied for ddl-secret'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }),
      'MYSQL_DDL_PERMISSION_DENIED',
      undefined,
    ],
    [
      'exists',
      input(),
      Object.assign(new Error('Table accounts already exists'), { code: 'ER_TABLE_EXISTS_ERROR' }),
      'MYSQL_DDL_TABLE_EXISTS',
      undefined,
    ],
    [
      'indeterminate',
      input(),
      Object.assign(new Error('transport ddl-secret'), { code: 'ECONNRESET' }),
      'MYSQL_DDL_OUTCOME_UNKNOWN',
      'VERIFY_STATE_BEFORE_RETRYING',
    ],
  ];
  for (const [, argumentsValue, failure, code, retryAdvice] of cases) {
    let calls = 0;
    const application = createApplication(async () => {
      calls += 1;
      if (failure !== undefined) throw failure;
      return [{ affectedRows: 0, warningStatus: 0 }, []];
    });
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', { name: 'create_table', arguments: argumentsValue });
      assert.equal(response.result?.isError, true);
      const structured = response.result?.structuredContent as { code: string; retryAdvice?: string };
      assert.equal(structured.code, code);
      assert.equal(structured.retryAdvice, retryAdvice);
      assert.doesNotMatch(JSON.stringify(response), /ddl-secret|CREATE TABLE|BIGINT|VARCHAR/);
      assert.equal(calls, code === 'MYSQL_DDL_INVALID_ARGUMENT' ? 0 : 1);
    } finally {
      await client.close();
    }
  }
});
