import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { MAX_DML_FILTER_IN_VALUES, MAX_DML_FILTERS, MAX_DML_LIMIT } from '../../src/db/dml-builder.js';
import { createMcpApplication } from '../../src/server.js';
import { MAX_DML_COLUMNS, MAX_DML_PARAMETERS, MAX_DML_PAYLOAD_BYTES } from '../../src/tools/dml-input.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}

type MetadataRow = Readonly<{
  schemaName: string;
  tableName: string;
  tableType: string;
  columnName: string;
  dataType: string;
  isNullable: 'YES' | 'NO';
  columnKey: string;
  ordinalPosition: number;
  extra: string;
}>;

const metadata: readonly MetadataRow[] = [
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'tenant_id',
    dataType: 'int',
    isNullable: 'NO',
    columnKey: 'PRI',
    ordinalPosition: 1,
    extra: '',
  },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'id',
    dataType: 'int',
    isNullable: 'NO',
    columnKey: 'PRI',
    ordinalPosition: 2,
    extra: '',
  },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'name',
    dataType: 'varchar',
    isNullable: 'NO',
    columnKey: '',
    ordinalPosition: 3,
    extra: '',
  },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'counter',
    dataType: 'int',
    isNullable: 'NO',
    columnKey: '',
    ordinalPosition: 4,
    extra: '',
  },
];

const primaryKeys = [
  { schemaName: 'app', tableName: 'orders', constraintName: 'PRIMARY', columnName: 'tenant_id', ordinalPosition: 1 },
  { schemaName: 'app', tableName: 'orders', constraintName: 'PRIMARY', columnName: 'id', ordinalPosition: 2 },
];

function createApplication(
  options: Readonly<{
    metadata?: readonly MetadataRow[];
    primaryKeys?: readonly Record<string, unknown>[];
    execute?: (...args: unknown[]) => Promise<unknown>;
    dmlEnabled?: boolean;
  }> = {},
) {
  const receivedMetadata = options.metadata ?? metadata;
  const receivedKeys = options.primaryKeys ?? primaryKeys;
  return createMcpApplication({
    environment: validEnvironment({ MYSQL_DML_ENABLED: options.dmlEnabled === false ? 'false' : 'true' }),
    driver: {
      createPool() {
        return {
          async query(queryOptions: { readonly sql: string }) {
            if (queryOptions.sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) return [receivedKeys, []];
            if (queryOptions.sql.includes('FROM information_schema.TABLES AS tables')) return [receivedMetadata, []];
            return [[], []];
          },
          async execute(...args: unknown[]) {
            return options.execute?.(...args) ?? [{ affectedRows: 2, changedRows: 1, warningStatus: 0 }, []];
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
      pending.get(message.id)?.(message as JsonRpcResponse);
      pending.delete(message.id);
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
    clientInfo: { name: 'update-rows-unit-test', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);
  return { request, close: () => application.close() };
}

function text(response: JsonRpcResponse): string {
  return ((response.result?.content as ReadonlyArray<{ readonly text: string }>)[0] ?? { text: '' }).text;
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'app',
    table: 'orders',
    values: { name: 'new name', counter: 4 },
    filters: [
      { column: 'tenant_id', operator: 'eq', value: 7 },
      { column: 'name', operator: 'neq', value: 'old name' },
      { column: 'id', operator: 'in', values: [3, 4] },
      { column: 'counter', operator: 'is_not_null' },
    ],
    limit: 10,
    reason: 'bounded update test',
    ...overrides,
  };
}

test('registers update_rows only for DML and advertises the required risk annotations', async () => {
  const enabled = createApplication();
  const disabled = createApplication({ dmlEnabled: false });
  const client = await connect(enabled);
  const disabledClient = await connect(disabled);
  try {
    const tools = (await client.request('tools/list', {})).result?.tools as ReadonlyArray<{ name: string; annotations?: Record<string, unknown> }>;
    const disabledTools = (await disabledClient.request('tools/list', {})).result?.tools as ReadonlyArray<{ name: string }>;
    assert.deepEqual(
      tools.map(({ name }) => name),
      [
        'list_accessible_schemas',
        'list_accessible_tables',
        'describe_table',
        'execute_read_only_query',
        'explain_read_only_query',
        'insert_rows',
        'update_rows',
        'delete_rows',
      ],
    );
    assert.equal(
      disabledTools.some(({ name }) => name === 'update_rows'),
      false,
    );
    assert.equal(
      disabledTools.some(({ name }) => name === 'delete_rows'),
      false,
    );
    const updateTool = tools.find(({ name }) => name === 'update_rows') as {
      inputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    };
    assert.deepEqual(updateTool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    const deleteTool = tools.find(({ name }) => name === 'delete_rows') as { annotations?: Record<string, unknown> };
    assert.deepEqual(deleteTool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    const inputSchema = updateTool.inputSchema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
    const valuesSchema = properties.values;
    assert.match(String((valuesSchema.propertyNames as Record<string, unknown>).pattern), /Cc/);
    const filterVariants = ((properties.filters.items as Record<string, unknown>).anyOf as ReadonlyArray<Record<string, unknown>>).map((variant) => ({
      properties: variant.properties as Record<string, unknown>,
      required: variant.required,
    }));
    assert.deepEqual(
      filterVariants.map(({ required }) => required),
      [
        ['column', 'operator', 'value'],
        ['column', 'operator', 'values'],
        ['column', 'operator'],
      ],
    );
    assert.deepEqual(
      filterVariants.map(
        ({ properties: variantProperties }) =>
          (variantProperties.operator as Record<string, unknown>).enum ?? (variantProperties.operator as Record<string, unknown>).const,
      ),
      [['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], 'in', ['is_null', 'is_not_null']],
    );
    assert.equal(Object.hasOwn(filterVariants[0].properties, 'values'), false);
    assert.equal(Object.hasOwn(filterVariants[1].properties, 'value'), false);
    assert.equal(Object.hasOwn(filterVariants[2].properties, 'value'), false);
    assert.equal(Object.hasOwn(filterVariants[2].properties, 'values'), false);
    assert.deepEqual(filterVariants[0].properties.value, (filterVariants[1].properties.values as Record<string, unknown>).items);
    assert.doesNotMatch(JSON.stringify(filterVariants[0].properties.value), /"null"/);
  } finally {
    await client.close();
    await disabledClient.close();
  }
});

test('executes one deterministic parameterized update and returns only normalized metadata', async () => {
  let receivedOptions: unknown;
  let receivedValues: unknown;
  let executions = 0;
  const secret = 'must-not-be-returned';
  const application = createApplication({
    execute: async (options, values) => {
      executions += 1;
      receivedOptions = options;
      receivedValues = values;
      return [{ affectedRows: 2, changedRows: 1, warningStatus: 3 }, []];
    },
  });
  const client = await connect(application);
  try {
    const response = await client.request('tools/call', { name: 'update_rows', arguments: args({ values: { counter: 5, name: secret } }) });
    const result = JSON.parse(text(response)) as Record<string, unknown>;
    assert.deepEqual(result, {
      operation: 'update',
      operationId: result.operationId,
      target: { schema: 'app', table: 'orders' },
      matchedRows: 2,
      affectedRows: 2,
      changedRows: 1,
      warningCount: 3,
    });
    assert.equal(executions, 1);
    assert.deepEqual(receivedOptions, {
      sql: 'UPDATE `app`.`orders` SET `counter` = ?, `name` = ? WHERE `tenant_id` = ? AND `name` <> ? AND `id` IN (?, ?) AND `counter` IS NOT NULL ORDER BY `tenant_id` ASC, `id` ASC LIMIT 10',
      timeout: 30_000,
    });
    assert.deepEqual(receivedValues, [5, secret, 7, 'old name', 3, 4]);
    assert.doesNotMatch(text(response), /must-not-be-returned/);
  } finally {
    await client.close();
  }
});

test('distinguishes zero matches from zero changes and normalizes bigint driver counts', async () => {
  for (const result of [
    { affectedRows: 0, changedRows: 0, warningStatus: 0 },
    { affectedRows: 1n, changedRows: 0n, warningStatus: 0n },
  ]) {
    const application = createApplication({ execute: async () => [result, []] });
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', { name: 'update_rows', arguments: args({ limit: 1 }) });
      const output = JSON.parse(text(response));
      assert.equal(output.matchedRows, Number(result.affectedRows));
      assert.equal(output.affectedRows, Number(result.affectedRows));
      assert.equal(output.changedRows, 0);
      assert.equal(output.warningCount, 0);
    } finally {
      await client.close();
    }
  }
});

test('rejects missing, empty, invalid, and over-limit input before metadata or execution', async () => {
  let executions = 0;
  const application = createApplication({
    execute: async () => {
      executions += 1;
      return [{ affectedRows: 1, changedRows: 1, warningStatus: 0 }, []];
    },
  });
  const client = await connect(application);
  try {
    for (const invalid of [
      args({ limit: 0 }),
      args({ limit: MAX_DML_LIMIT + 1 }),
      args({ filters: [] }),
      args({ filters: undefined }),
      args({ values: {} }),
      args({ values: { counter: 'x', extra: 'unknown' } }),
      args({ values: { counter: { expression: 'counter + 1' } } }),
      args({ values: { 'bad\nname': 'x' } }),
      { ...args(), extra: 'secret' },
    ]) {
      const response = await client.request('tools/call', { name: 'update_rows', arguments: invalid });
      assert.equal(response.result?.isError, true);
    }
    assert.equal(executions, 0);
  } finally {
    await client.close();
  }
});

test('rejects missing primary keys and protected or unknown columns', async () => {
  const noPrimaryKey = metadata.map((column) => ({ ...column, columnKey: '' }));
  for (const candidate of [
    { label: 'missing primary key', metadata: noPrimaryKey, values: { name: 'x' } },
    {
      label: 'generated column',
      metadata: metadata.map((column) => (column.columnName === 'name' ? { ...column, extra: 'STORED GENERATED' } : column)),
      values: { name: 'x' },
    },
    {
      label: 'AUTO_INCREMENT column',
      metadata: metadata.map((column) => (column.columnName === 'name' ? { ...column, extra: 'auto_increment' } : column)),
      values: { name: 'x' },
    },
    { label: 'unknown column', metadata, values: { missing: 'x' } },
    { label: 'primary-key column', metadata, values: { tenant_id: 9 } },
  ]) {
    const application = createApplication(candidate);
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', { name: 'update_rows', arguments: args({ values: candidate.values }) });
      assert.equal(response.result?.isError, true);
      assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DML_INCOMPATIBLE_OBJECT', candidate.label);
    } finally {
      await client.close();
    }
  }
});

test('maps permission, constraint, timeout, and disconnection errors without retrying or leaking audit data', async () => {
  for (const [code, expected] of [
    ['ER_TABLEACCESS_DENIED_ERROR', 'MYSQL_PERMISSION_DENIED'],
    ['ER_CHECK_CONSTRAINT_VIOLATED', 'MYSQL_CONSTRAINT_VIOLATION'],
    ['ETIMEDOUT', 'MYSQL_DML_OUTCOME_UNKNOWN'],
    ['ECONNRESET', 'MYSQL_DML_OUTCOME_UNKNOWN'],
  ] as const) {
    let executions = 0;
    const application = createApplication({
      execute: async () => {
        executions += 1;
        throw Object.assign(new Error(`raw ${code} audit-secret`), { code });
      },
    });
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', {
        name: 'update_rows',
        arguments: args({ values: { name: 'audit-secret' }, reason: 'audit-secret' }),
      });
      assert.equal(response.result?.isError, true);
      assert.equal((response.result?.structuredContent as { code: string }).code, expected);
      assert.equal(executions, 1);
      assert.doesNotMatch(JSON.stringify(response), /audit-secret|raw/);
    } finally {
      await client.close();
    }
  }
});

test('enforces parameter and payload ceilings', async () => {
  const application = createApplication();
  const client = await connect(application);
  try {
    const tooManyValues = Object.fromEntries(Array.from({ length: MAX_DML_COLUMNS }, (_, index) => [`c${index}`, index]));
    const tooManyParameters = {
      values: { ...tooManyValues },
      filters: Array.from({ length: MAX_DML_FILTERS }, (_, index) => ({
        column: 'name',
        operator: 'in',
        values: Array.from({ length: MAX_DML_FILTER_IN_VALUES }, () => `v${index}`),
      })),
    };
    const tooLarge = { values: { name: 'x'.repeat(MAX_DML_PAYLOAD_BYTES) } };
    for (const override of [tooManyParameters, tooLarge]) {
      const response = await client.request('tools/call', { name: 'update_rows', arguments: args(override) });
      assert.equal(response.result?.isError, true);
    }
    assert.equal(typeof MAX_DML_PARAMETERS, 'number');
  } finally {
    await client.close();
  }
});
