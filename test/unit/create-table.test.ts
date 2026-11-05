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

test('registers create_table only with the DDL opt-in and preserves the existing tool surface', async () => {
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
      disabledTools.some(({ name }) => name === 'create_table'),
      false,
    );
    assert.deepEqual(enabledTools.find(({ name }) => name === 'create_table')?.annotations, {
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
        .filter(({ name }) => name !== 'create_table')
        .map(({ name }) => name)
        .sort(),
      disabledTools.map(({ name }) => name).sort(),
    );
  } finally {
    await disabledClient.close();
    await enabledClient.close();
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
