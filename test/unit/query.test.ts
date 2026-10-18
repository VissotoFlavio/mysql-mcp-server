import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
      arguments: { sql: 'SELECT id, active, nickname FROM accounts WHERE id = ? LIMIT 100', parameters: [42] },
    });

    assert.deepEqual(JSON.parse(toolText(response)), {
      columns: [
        { name: 'id', type: 'LONG' },
        { name: 'active', type: 'TINY' },
        { name: 'nickname', type: 'VAR_STRING' },
      ],
      rows: [{ id: 42, active: true, nickname: null }],
    });
    assert.equal((queryOptions as { sql: string }).sql, 'SELECT id, active, nickname FROM accounts WHERE id = ? LIMIT 100');
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
      arguments: { sql: 'WITH visible AS (SELECT id FROM accounts) SELECT id FROM visible LIMIT 100', parameters: [] },
    });

    assert.equal(response.result?.isError, undefined);
    assert.equal((queryOptions as { sql: string }).sql, 'WITH visible AS (SELECT id FROM accounts) SELECT id FROM visible LIMIT 100');
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
      arguments: { sql: 'SELECT id FROM accounts LIMIT 100', parameters: [] },
    });

    const result = JSON.parse(toolText(response));
    assert.equal(result.rows.length, 100);
    assert.equal(result.rows[0].id, 0);
    assert.equal(result.rows.at(-1).id, 99);
  } finally {
    await client.close();
  }
});

test('requires an explicit literal query limit of at most 100 rows', async () => {
  const suppliedSql: string[] = [];
  const application = createApplication(async (options) => {
    suppliedSql.push((options as { sql: string }).sql);
    return [[], []];
  });
  const client = await connect(application);

  try {
    for (const sql of ['SELECT id FROM accounts LIMIT 3', 'SELECT id FROM accounts LIMIT 1 OFFSET 3']) {
      const response = await client.request('tools/call', { name: 'execute_read_only_query', arguments: { sql, parameters: [] } });
      assert.equal(response.result?.isError, undefined);
    }

    assert.equal(suppliedSql[0], 'SELECT id FROM accounts LIMIT 3');
    assert.equal(suppliedSql[1], 'SELECT id FROM accounts LIMIT 1 OFFSET 3');

    for (const sql of [
      'SELECT id FROM accounts',
      'SELECT id FROM accounts LIMIT 101',
      'SELECT id FROM accounts LIMIT 500 OFFSET 1',
      'SELECT id FROM accounts LIMIT ?',
    ]) {
      const response = await client.request('tools/call', { name: 'execute_read_only_query', arguments: { sql, parameters: [] } });
      assert.equal(response.result?.isError, true);
      assert.equal(toolText(response), 'The query must be a single approved read-only SELECT statement.');
    }
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
      arguments: { sql: 'SELECT payload FROM documents LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'The query result exceeds the 512 KiB response limit. Refine the query and try again.');
    assert.doesNotMatch(toolText(response), /xxxx/);
  } finally {
    await client.close();
  }
});

test('accepts a serialized response just below the 512 KiB boundary', async () => {
  const emptyResult = JSON.stringify({ columns: [{ name: 'payload', type: 'LONG_BLOB' }], rows: [{ payload: '' }] });
  const payload = 'x'.repeat(MAX_QUERY_RESPONSE_BYTES - Buffer.byteLength(emptyResult, 'utf8') - 1024);
  const application = createApplication(async () => [[{ payload }], [{ name: 'payload', typeName: 'LONG_BLOB' }]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'SELECT payload FROM documents LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, undefined);
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
      arguments: { sql: 'SELECT id FROM accounts LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /Unable to execute the query/);
    assert.doesNotMatch(toolText(response), /secret|query detail/);
  } finally {
    await client.close();
  }
});

test('reports query timeouts without exposing driver details', async () => {
  const application = createApplication(async () => {
    const error = new Error('internal timeout detail') as Error & { code: string };
    error.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
    throw error;
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'execute_read_only_query',
      arguments: { sql: 'SELECT id FROM accounts LIMIT 1', parameters: [] },
    });

    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'The query timed out. Reduce the result size or simplify the query and try again.');
    assert.doesNotMatch(toolText(response), /internal timeout detail/);
  } finally {
    await client.close();
  }
});
