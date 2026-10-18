import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}

function createApplication(query: (...args: unknown[]) => Promise<unknown>) {
  return createMcpApplication({
    environment: validEnvironment(),
    driver: {
      createPool() {
        return {
          query,
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
    clientInfo: { name: 'unit-test', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

  return { request, close: () => application.close() };
}

function toolText(response: JsonRpcResponse): string {
  const content = response.result?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
  assert.equal(content[0]?.type, 'text');
  return content[0].text;
}

test('returns a normalized bounded EXPLAIN plan with driver-bound parameters and the configured timeout', async () => {
  let queryOptions: unknown;
  let values: unknown;
  const application = createApplication(async (options, queryValues) => {
    queryOptions = options;
    values = queryValues;
    return [
      [{ id: 1, select_type: 'SIMPLE', table: 'accounts', type: 'const', rows: 1n, Extra: null }],
      [
        { name: 'id', typeName: 'LONG' },
        { name: 'select_type', typeName: 'VAR_STRING' },
        { name: 'table', typeName: 'VAR_STRING' },
        { name: 'type', typeName: 'VAR_STRING' },
        { name: 'rows', typeName: 'LONGLONG' },
        { name: 'Extra', typeName: 'VAR_STRING' },
      ],
    ];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'explain_read_only_query',
      arguments: { sql: 'WITH visible AS (SELECT id FROM accounts) SELECT id FROM visible WHERE id = ? LIMIT 1', parameters: [42] },
    });

    assert.deepEqual(JSON.parse(toolText(response)), {
      columns: [
        { name: 'id', type: 'LONG' },
        { name: 'select_type', type: 'VAR_STRING' },
        { name: 'table', type: 'VAR_STRING' },
        { name: 'type', type: 'VAR_STRING' },
        { name: 'rows', type: 'LONGLONG' },
        { name: 'Extra', type: 'VAR_STRING' },
      ],
      rows: [{ id: 1, select_type: 'SIMPLE', table: 'accounts', type: 'const', rows: '1', Extra: null }],
    });
    assert.equal(
      (queryOptions as { sql: string }).sql,
      'EXPLAIN WITH visible AS (SELECT id FROM accounts) SELECT id FROM visible WHERE id = ? LIMIT 1',
    );
    assert.equal((queryOptions as { timeout: number }).timeout, 30_000);
    assert.deepEqual(values, [42]);
  } finally {
    await client.close();
  }
});

test('caps EXPLAIN plan rows at the shared result limit', async () => {
  const planRows = Array.from({ length: 101 }, (_, index) => ({ id: index }));
  const application = createApplication(async () => [planRows, [{ name: 'id', typeName: 'LONG' }]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'explain_read_only_query',
      arguments: { sql: 'SELECT id FROM accounts LIMIT 100', parameters: [] },
    });

    const plan = JSON.parse(toolText(response));
    assert.equal(plan.rows.length, 100);
    assert.equal(plan.rows[0].id, 0);
    assert.equal(plan.rows.at(-1).id, 99);
  } finally {
    await client.close();
  }
});

test('returns an empty normalized plan', async () => {
  const application = createApplication(async () => [[], []]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'explain_read_only_query',
      arguments: { sql: 'SELECT id FROM accounts LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(JSON.parse(toolText(response)), { columns: [], rows: [] });
  } finally {
    await client.close();
  }
});

test('rejects invalid SQL before it reaches the driver', async () => {
  let calls = 0;
  const application = createApplication(async () => {
    calls += 1;
    return [[], []];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'explain_read_only_query',
      arguments: { sql: 'SELECT FROM accounts LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'The query must be a single approved read-only SELECT statement.');
    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});

test('rejects policy-bypassing input before it reaches the driver', async () => {
  let calls = 0;
  const application = createApplication(async () => {
    calls += 1;
    return [[], []];
  });
  const client = await connect(application);

  try {
    for (const sql of [
      'EXPLAIN SELECT id FROM accounts LIMIT 1',
      'EXPLAIN ANALYZE SELECT id FROM accounts LIMIT 1',
      'INSERT INTO accounts (id) VALUES (1)',
      "UPDATE accounts SET role = 'admin'",
      'DELETE FROM accounts',
      'CREATE TABLE copied_accounts (id INT)',
      'SELECT id FROM accounts LIMIT 1; DELETE FROM accounts',
    ]) {
      const response = await client.request('tools/call', {
        name: 'explain_read_only_query',
        arguments: { sql, parameters: [] },
      });

      assert.equal(response.result?.isError, true);
      assert.equal(toolText(response), 'The query must be a single approved read-only SELECT statement.');
    }

    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});

test('sanitizes EXPLAIN failures', async () => {
  const application = createApplication(async () => {
    throw new Error('mysql://user:secret@host/internal query detail');
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'explain_read_only_query',
      arguments: { sql: 'SELECT id FROM accounts LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'Unable to explain the query. Verify the configured MySQL connection and query parameters.');
    assert.doesNotMatch(toolText(response), /secret|query detail/);
  } finally {
    await client.close();
  }
});
