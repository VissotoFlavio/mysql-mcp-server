import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}

interface MetadataRow {
  readonly schemaName: string;
  readonly tableName?: string;
  readonly tableType?: string;
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
  const responses = new Map<number, JsonRpcResponse>();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let requestId = 0;

  clientTransport.onmessage = (message) => {
    if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
      const response = message as JsonRpcResponse;
      responses.set(response.id, response);
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

function toolMetadata(response: JsonRpcResponse): readonly Record<string, unknown>[] {
  const structuredContent = response.result?.structuredContent as { readonly metadata?: readonly Record<string, unknown>[] };
  assert(Array.isArray(structuredContent.metadata));
  return structuredContent.metadata;
}

test('lists no schemas when information_schema reports none', async () => {
  const application = createApplication(async () => [[]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', { name: 'list_accessible_schemas', arguments: {} });
    assert.deepEqual(JSON.parse(toolText(response)), { metadata: [] });
  } finally {
    await client.close();
  }
});

test('returns only mocked accessible schema metadata in deterministic bounded query order', async () => {
  let queryOptions: unknown;
  let values: unknown;
  const application = createApplication(async (options, queryValues) => {
    queryOptions = options;
    values = queryValues;
    return [[{ schemaName: 'app' }, { schemaName: 'reporting' } satisfies MetadataRow]];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', { name: 'list_accessible_schemas', arguments: {} });
    assert.deepEqual(JSON.parse(toolText(response)), {
      metadata: [{ schemaName: 'app' }, { schemaName: 'reporting' }],
    });
    assert.match((queryOptions as { sql: string }).sql, /ORDER BY SCHEMA_NAME ASC/);
    assert.equal((queryOptions as { timeout: number }).timeout, 30_000);
    assert.deepEqual(values, [100]);
  } finally {
    await client.close();
  }
});

test('caps schema metadata when a driver returns more rows than the SQL limit', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ schemaName: `schema_${index}` }));
  const application = createApplication(async () => [rows]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', { name: 'list_accessible_schemas', arguments: {} });
    const metadata = toolMetadata(response);
    assert.equal(metadata.length, 100);
    assert.deepEqual(metadata[0], { schemaName: 'schema_0' });
    assert.deepEqual(metadata.at(-1), { schemaName: 'schema_99' });
  } finally {
    await client.close();
  }
});

test('filters accessible tables by schema with parameterized and bounded metadata query', async () => {
  let queryOptions: unknown;
  let values: unknown;
  const application = createApplication(async (options, queryValues) => {
    queryOptions = options;
    values = queryValues;
    return [
      [
        { schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE' },
        { schemaName: 'app', tableName: 'events', tableType: 'BASE TABLE' },
      ],
    ];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'list_accessible_tables',
      arguments: { schema: 'app' },
    });
    assert.deepEqual(JSON.parse(toolText(response)), {
      metadata: [
        { schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE' },
        { schemaName: 'app', tableName: 'events', tableType: 'BASE TABLE' },
      ],
    });
    assert.match((queryOptions as { sql: string }).sql, /WHERE TABLE_SCHEMA = \?/);
    assert.match((queryOptions as { sql: string }).sql, /ORDER BY TABLE_SCHEMA ASC, TABLE_NAME ASC/);
    assert.equal((queryOptions as { timeout: number }).timeout, 30_000);
    assert.deepEqual(values, ['app', 100]);
  } finally {
    await client.close();
  }
});

test('returns an empty table result for an inaccessible requested schema', async () => {
  const application = createApplication(async () => [[]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'list_accessible_tables',
      arguments: { schema: 'inaccessible' },
    });
    assert.deepEqual(toolMetadata(response), []);
  } finally {
    await client.close();
  }
});

test('returns only metadata visible through information_schema', async () => {
  const application = createApplication(async () => [[{ schemaName: 'app', tableName: 'visible_table', tableType: 'BASE TABLE' }]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'list_accessible_tables',
      arguments: { schema: 'app' },
    });
    assert.deepEqual(toolMetadata(response), [{ schemaName: 'app', tableName: 'visible_table', tableType: 'BASE TABLE' }]);
    assert.doesNotMatch(toolText(response), /invisible_table/);
  } finally {
    await client.close();
  }
});

test('caps table metadata when a driver returns more rows than the SQL limit', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    schemaName: 'app',
    tableName: `table_${index}`,
    tableType: 'BASE TABLE',
  }));
  const application = createApplication(async () => [rows]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'list_accessible_tables',
      arguments: { schema: 'app' },
    });
    assert.equal(toolMetadata(response).length, 100);
  } finally {
    await client.close();
  }
});

test('advertises discovery tools as read-only with output schemas', async () => {
  const application = createApplication(async () => [[]]);
  const client = await connect(application);

  try {
    const listed = await client.request('tools/list', {});
    const tools = listed.result?.tools as ReadonlyArray<{
      readonly name: string;
      readonly annotations?: { readonly readOnlyHint?: boolean };
      readonly outputSchema?: Record<string, unknown>;
    }>;
    assert.deepEqual(
      tools.map(({ name, annotations, outputSchema }) => ({ name, readOnlyHint: annotations?.readOnlyHint, outputSchema })),
      [
        {
          name: 'list_accessible_schemas',
          readOnlyHint: true,
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['metadata'],
            properties: {
              metadata: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['schemaName'],
                  properties: { schemaName: { type: 'string' } },
                },
              },
            },
          },
        },
        {
          name: 'list_accessible_tables',
          readOnlyHint: true,
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['metadata'],
            properties: {
              metadata: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['schemaName', 'tableName', 'tableType'],
                  properties: {
                    schemaName: { type: 'string' },
                    tableName: { type: 'string' },
                    tableType: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      ],
    );
  } finally {
    await client.close();
  }
});

test('rejects invalid table filters without calling the pool', async () => {
  let calls = 0;
  const application = createApplication(async () => {
    calls += 1;
    return [[]];
  });
  const client = await connect(application);

  try {
    for (const arguments_ of [{}, { schema: '' }, { schema: 123 }, { schema: 'app', extra: true }]) {
      const response = await client.request('tools/call', { name: 'list_accessible_tables', arguments: arguments_ });
      assert.equal(response.result?.isError, true);
      assert.match(toolText(response), /Invalid arguments/);
    }
    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});

test('sanitizes metadata query failures', async () => {
  const application = createApplication(async () => {
    throw new Error('mysql://user:secret@host/internal query detail');
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', { name: 'list_accessible_schemas', arguments: {} });
    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /Unable to list accessible schemas/);
    assert.doesNotMatch(toolText(response), /secret|query detail/);
  } finally {
    await client.close();
  }
});
