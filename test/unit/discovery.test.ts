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

interface DescriptionRow extends MetadataRow {
  readonly tableName: string;
  readonly tableType: string;
  readonly columnName: string;
  readonly dataType: string;
  readonly isNullable: 'YES' | 'NO';
  readonly columnKey: string;
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

test('describes a visible table with parameterized bounded column metadata', async () => {
  let queryOptions: unknown;
  let values: unknown;
  const application = createApplication(async (options, queryValues) => {
    queryOptions = options;
    values = queryValues;
    return [
      [
        {
          schemaName: 'app',
          tableName: 'accounts',
          tableType: 'BASE TABLE',
          columnName: 'id',
          dataType: 'bigint',
          isNullable: 'NO',
          columnKey: 'PRI',
        },
        {
          schemaName: 'app',
          tableName: 'accounts',
          tableType: 'BASE TABLE',
          columnName: 'status',
          dataType: 'varchar',
          isNullable: 'YES',
          columnKey: '',
        },
      ] satisfies DescriptionRow[],
    ];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'app', table: 'accounts' },
    });
    assert.deepEqual(JSON.parse(toolText(response)), {
      table: { schemaName: 'app', tableName: 'accounts', tableType: 'BASE TABLE' },
      columns: [
        { columnName: 'id', dataType: 'bigint', isNullable: false, columnKey: 'PRI' },
        { columnName: 'status', dataType: 'varchar', isNullable: true, columnKey: '' },
      ],
    });
    assert.match((queryOptions as { sql: string }).sql, /FROM information_schema\.TABLES AS tables/);
    assert.match((queryOptions as { sql: string }).sql, /INNER JOIN information_schema\.COLUMNS AS columns/);
    assert.match((queryOptions as { sql: string }).sql, /WHERE tables\.TABLE_SCHEMA = \?/);
    assert.match((queryOptions as { sql: string }).sql, /AND tables\.TABLE_NAME = \?/);
    assert.match((queryOptions as { sql: string }).sql, /ORDER BY columns\.ORDINAL_POSITION ASC/);
    assert.equal((queryOptions as { timeout: number }).timeout, 30_000);
    assert.deepEqual(values, ['app', 'accounts', 100]);
  } finally {
    await client.close();
  }
});

test('omits default metadata rather than conflating DEFAULT NULL with no default', async () => {
  let queryOptions: unknown;
  const application = createApplication(async (options) => {
    queryOptions = options;
    return [
      [
        {
          schemaName: 'app',
          tableName: 'nullable_defaults',
          tableType: 'BASE TABLE',
          columnName: 'optional_label',
          dataType: 'varchar',
          isNullable: 'YES',
          columnKey: '',
        } satisfies DescriptionRow,
      ],
    ];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'app', table: 'nullable_defaults' },
    });
    const description = JSON.parse(toolText(response));
    assert.doesNotMatch((queryOptions as { sql: string }).sql, /COLUMN_DEFAULT/);
    assert.equal('hasDefault' in description.columns[0], false);
  } finally {
    await client.close();
  }
});

test('binds quoted-compatible MySQL identifiers without altering their values', async () => {
  let values: unknown;
  const application = createApplication(async (_options, queryValues) => {
    values = queryValues;
    return [
      [
        {
          schemaName: 'sales-2026',
          tableName: 'ações 2024',
          tableType: 'BASE TABLE',
          columnName: 'ação',
          dataType: 'varchar',
          isNullable: 'NO',
          columnKey: '',
        } satisfies DescriptionRow,
      ],
    ];
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'sales-2026', table: 'ações 2024' },
    });
    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(values, ['sales-2026', 'ações 2024', 100]);
  } finally {
    await client.close();
  }
});

test('represents a visible view in its table metadata', async () => {
  const application = createApplication(async () => [
    [
      {
        schemaName: 'reporting',
        tableName: 'active_accounts',
        tableType: 'VIEW',
        columnName: 'id',
        dataType: 'bigint',
        isNullable: 'NO',
        columnKey: '',
      } satisfies DescriptionRow,
    ],
  ]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'reporting', table: 'active_accounts' },
    });
    const description = JSON.parse(toolText(response));
    assert.equal(description.table.tableType, 'VIEW');
    assert.equal(description.columns[0].columnName, 'id');
  } finally {
    await client.close();
  }
});

test('returns a safe actionable error for a missing or inaccessible table or view', async () => {
  const application = createApplication(async () => [[]]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'app', table: 'missing_table' },
    });
    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /not found or is not accessible/);
    assert.doesNotMatch(toolText(response), /information_schema|mysql|query/i);
  } finally {
    await client.close();
  }
});

test('caps described column metadata when a driver returns more rows than the SQL limit', async () => {
  const rows = Array.from(
    { length: 101 },
    (_, index) =>
      ({
        schemaName: 'app',
        tableName: 'wide_table',
        tableType: 'BASE TABLE',
        columnName: `column_${index}`,
        dataType: 'varchar',
        isNullable: 'YES',
        columnKey: '',
      }) satisfies DescriptionRow,
  );
  const application = createApplication(async () => [rows]);
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'app', table: 'wide_table' },
    });
    const description = JSON.parse(toolText(response));
    assert.equal(description.columns.length, 100);
    assert.equal(description.columns[0].columnName, 'column_0');
    assert.equal(description.columns.at(-1).columnName, 'column_99');
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
        {
          name: 'describe_table',
          readOnlyHint: true,
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['table', 'columns'],
            properties: {
              table: {
                type: 'object',
                additionalProperties: false,
                required: ['schemaName', 'tableName', 'tableType'],
                properties: {
                  schemaName: { type: 'string' },
                  tableName: { type: 'string' },
                  tableType: { type: 'string' },
                },
              },
              columns: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['columnName', 'dataType', 'isNullable', 'columnKey'],
                  properties: {
                    columnName: { type: 'string' },
                    dataType: { type: 'string' },
                    isNullable: { type: 'boolean' },
                    columnKey: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        {
          name: 'execute_read_only_query',
          readOnlyHint: true,
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['columns', 'rows'],
            properties: {
              columns: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'type'],
                  properties: {
                    name: { type: 'string' },
                    type: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              },
              rows: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: {
                    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                  },
                },
              },
            },
          },
        },
        {
          name: 'explain_read_only_query',
          readOnlyHint: true,
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['columns', 'rows'],
            properties: {
              columns: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'type'],
                  properties: {
                    name: { type: 'string' },
                    type: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              },
              rows: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: {
                    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
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

test('rejects invalid table descriptions before querying the pool', async () => {
  let calls = 0;
  const application = createApplication(async () => {
    calls += 1;
    return [[]];
  });
  const client = await connect(application);

  try {
    for (const arguments_ of [
      {},
      { schema: 'app' },
      { schema: 'app', table: '' },
      { schema: 'app\nname', table: 'accounts' },
      { schema: 'app', table: 'accounts\u0000archive' },
      { schema: 'app', table: 123 },
      { schema: 'app', table: 'accounts', extra: true },
    ]) {
      const response = await client.request('tools/call', { name: 'describe_table', arguments: arguments_ });
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

test('sanitizes table description query failures', async () => {
  const application = createApplication(async () => {
    throw new Error('mysql://user:secret@host/internal query detail');
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'describe_table',
      arguments: { schema: 'app', table: 'accounts' },
    });
    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /Unable to describe the requested table or view/);
    assert.doesNotMatch(toolText(response), /secret|query detail/);
  } finally {
    await client.close();
  }
});
