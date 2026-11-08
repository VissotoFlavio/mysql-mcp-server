import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface Response {
  readonly result?: Record<string, unknown>;
}

async function connectedApplication(environment: Record<string, string>) {
  let executeCalls = 0;
  let executeOptions: unknown;
  const application = createMcpApplication({
    environment: validEnvironment(environment),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('information_schema.SCHEMATA')) return [[], []];
            return [[]];
          },
          async execute(options: unknown) {
            executeCalls += 1;
            executeOptions = options;
            return [{ affectedRows: 0, warningStatus: 0, secret: 'driver-secret' }, []];
          },
          async end() {},
        }) as never,
    },
  });
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: Response) => void>();
  let requestId = 0;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as Response);
      pending.delete(message.id);
    }
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<Response>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  await application.server.connect(server);
  await client.start();
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'create-schema-test', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return {
    application,
    request,
    get executeCalls() {
      return executeCalls;
    },
    get executeOptions() {
      return executeOptions;
    },
  };
}

test('advertises create_schema only when both opt-ins are true and executes after absence preflight', async () => {
  const disabled = await connectedApplication({ MYSQL_DDL_ENABLED: 'true' });
  try {
    const listed = (await disabled.request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.equal(
      listed.some(({ name }) => name === 'create_schema'),
      false,
    );
  } finally {
    await disabled.application.close();
  }

  const enabled = await connectedApplication({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'true' });
  try {
    const listed = (await enabled.request('tools/list', {})).result?.tools as readonly { name: string }[];
    assert.equal(
      listed.some(({ name }) => name === 'create_schema'),
      true,
    );
    const response = await enabled.request('tools/call', {
      name: 'create_schema',
      arguments: {
        schema: 'mcp_ddl_test_target',
        charset: 'utf8mb4',
        collation: 'utf8mb4_0900_ai_ci',
        reason: 'Create isolated schema with sensitive internal note',
      },
    });
    assert.equal(response.result?.isError, undefined);
    assert.equal(enabled.executeCalls, 1);
    assert.deepEqual(enabled.executeOptions, {
      sql: 'CREATE SCHEMA `mcp_ddl_test_target` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      timeout: 30_000,
    });
    assert.doesNotMatch(JSON.stringify(response), /CREATE SCHEMA|sensitive internal note|driver-secret/);
    assert.deepEqual(response.result?.structuredContent && (response.result.structuredContent as Record<string, unknown>).target, {
      schema: 'mcp_ddl_test_target',
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
    });
  } finally {
    await enabled.application.close();
  }
});

test('returns a sanitized schema conflict without attempting driver DDL', async () => {
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DDL_ENABLED: 'true', MYSQL_DDL_CREATE_SCHEMA_ENABLED: 'true' }),
    driver: {
      createPool: () =>
        ({
          async query(options: { sql: string }) {
            if (options.sql.includes('information_schema.SCHEMATA')) return [[{ schemaName: 'mcp_ddl_test_existing' }], []];
            return [[]];
          },
          async execute() {
            assert.fail('DDL must not execute after a schema conflict preflight.');
          },
          async end() {},
        }) as never,
    },
  });
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: Response) => void>();
  let requestId = 0;
  client.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      pending.get(message.id)?.(message as Response);
      pending.delete(message.id);
    }
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    const response = new Promise<Response>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params } as never);
    return response;
  };
  try {
    await application.server.connect(server);
    await client.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'create-schema-conflict-test', version: '1' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
    const response = await request('tools/call', {
      name: 'create_schema',
      arguments: { schema: 'mcp_ddl_test_existing', reason: 'Conflict must be safe.' },
    });
    assert.equal(response.result?.isError, true);
    assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DDL_SCHEMA_EXISTS');
    assert.doesNotMatch(JSON.stringify(response), /Conflict must be safe|CREATE SCHEMA/);
  } finally {
    await application.close();
  }
});
