import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';
import { MAX_QUERY_RESPONSE_BYTES } from '../../src/tools/query.js';

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

test('executes an approved parameterized SELECT with the configured timeout and bounded SQL', async () => {
  let queryOptions: unknown;
  let values: unknown;
  const application = createApplication(async (options, queryValues) => {
    queryOptions = options;
    values = queryValues;
    return [
      [{ id: 42, active: true, nickname: null }],
      [
        { name: 'id', typeName: 'LONG' },
        { name: 'active', typeName: 'TINY' },
        { name: 'nickname', typeName: 'VAR_STRING' },
      ],
    ];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'SELECT id, active, nickname FROM accounts WHERE id = ?', parameters: [42] },
    });

    assert.deepEqual(JSON.parse(toolText(response)), {
      columns: [
        { name: 'id', type: 'LONG' },
        { name: 'active', type: 'TINY' },
        { name: 'nickname', type: 'VAR_STRING' },
      ],
      rows: [{ id: 42, active: true, nickname: null }],
    });
    assert.match((queryOptions as { sql: string }).sql, /WHERE `id` = \? LIMIT 100$/);
    assert.equal((queryOptions as { timeout: number }).timeout, 30_000);
    assert.deepEqual(values, [42]);
  } finally {
    await client.close();
  }
});

test('executes a read-only common table expression through the same bounded query path', async () => {
  let queryOptions: unknown;
  const application = createApplication(async (options) => {
    queryOptions = options;
    return [[{ id: 1 }], [{ name: 'id', typeName: 'LONG' }]];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'WITH visible AS (SELECT id FROM accounts) SELECT id FROM visible', parameters: [] },
    });

    assert.equal(response.result?.isError, undefined);
    assert.match((queryOptions as { sql: string }).sql, /^WITH `visible` AS \(SELECT `id` FROM `accounts`\) SELECT `id` FROM `visible` LIMIT 100$/);
  } finally {
    await client.close();
  }
});

test('caps returned rows even if a driver ignores the SQL result limit', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ id: index }));
  const application = createApplication(async () => [rows, [{ name: 'id', typeName: 'LONG' }]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'SELECT id FROM accounts', parameters: [] },
    });

    const result = JSON.parse(toolText(response));
    assert.equal(result.rows.length, 100);
    assert.equal(result.rows[0].id, 0);
    assert.equal(result.rows.at(-1).id, 99);
  } finally {
    await client.close();
  }
});

test('preserves a smaller literal query limit while capping a larger one', async () => {
  const suppliedSql: string[] = [];
  const application = createApplication(async (options) => {
    suppliedSql.push((options as { sql: string }).sql);
    return [[], []];
  });
  const client = await connect(application);

  try {
    for (const sql of ['SELECT id FROM accounts LIMIT 3', 'SELECT id FROM accounts LIMIT 1, 500']) {
      const response = await client.request('tools/call', { name: 'execute_read_only_query', arguments: { sql, parameters: [] } });
      assert.equal(response.result?.isError, undefined);
    }

    assert.match(suppliedSql[0] ?? '', /LIMIT 3$/);
    assert.match(suppliedSql[1] ?? '', /LIMIT 1, 100$/);
  } finally {
    await client.close();
  }
});

test('rejects invalid arguments and unsupported query shapes before calling the driver', async () => {
  let calls = 0;
  const application = createApplication(async () => {
    calls += 1;
    return [[], []];
  });
  const client = await connect(application);

  try {
    for (const arguments_ of [
      {},
      { sql: '', parameters: [] },
      { sql: 'SELECT 1', parameters: [new Date()] },
      { sql: 'SELECT 1', parameters: [], extra: true },
    ]) {
      const response = await client.request('tools/call', { name: 'execute_read_only_query', arguments: arguments_ });
      assert.equal(response.result?.isError, true);
      assert.match(toolText(response), /Invalid arguments/);
    }

    for (const sql of ['INSERT INTO accounts VALUES (1)', 'SELECT 1; SELECT 2', 'EXPLAIN SELECT * FROM accounts']) {
      const response = await client.request('tools/call', { name: 'execute_read_only_query', arguments: { sql, parameters: [] } });
      assert.equal(response.result?.isError, true);
      assert.equal(toolText(response), 'The query must be a single approved read-only SELECT statement.');
    }

    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});

test('rejects responses above the JSON size limit without exposing result contents', async () => {
  const application = createApplication(async () => [
    [{ payload: 'x'.repeat(MAX_QUERY_RESPONSE_BYTES) }],
    [{ name: 'payload', typeName: 'LONG_BLOB' }],
  ]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'SELECT payload FROM documents', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'The query result exceeds the 1 MiB response limit. Refine the query and try again.');
    assert.doesNotMatch(toolText(response), /xxxx/);
  } finally {
    await client.close();
  }
});

test('sanitizes database query failures', async () => {
  const application = createApplication(async () => {
    throw new Error('mysql://user:secret@host/internal query detail');
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'SELECT id FROM accounts', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /Unable to execute the query/);
    assert.doesNotMatch(toolText(response), /secret|query detail/);
  } finally {
    await client.close();
  }
});
