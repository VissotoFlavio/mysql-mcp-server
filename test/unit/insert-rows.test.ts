import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';
import {
  MAX_DML_COLUMNS,
  MAX_DML_IDENTIFIER_LENGTH,
  MAX_DML_PARAMETERS,
  MAX_DML_PAYLOAD_BYTES,
  MAX_DML_REASON_LENGTH,
  MAX_DML_ROWS,
  MAX_DML_STRING_LENGTH,
} from '../../src/tools/dml-input.js';

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

const metadataRows: readonly MetadataRow[] = [
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'id',
    dataType: 'bigint',
    isNullable: 'NO',
    columnKey: 'PRI',
    ordinalPosition: 1,
    extra: 'auto_increment',
  },
  {
    schemaName: 'app',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    columnName: 'name',
    dataType: 'varchar',
    isNullable: 'NO',
    columnKey: '',
    ordinalPosition: 2,
    extra: '',
  },
];

const primaryKeyRows = [
  {
    schemaName: 'app',
    tableName: 'orders',
    constraintName: 'PRIMARY',
    columnName: 'id',
    ordinalPosition: 1,
  },
];

type PrimaryKeyRow = (typeof primaryKeyRows)[number];

function createApplication(
  options: Readonly<{
    metadata?: readonly MetadataRow[];
    primaryKeys?: readonly PrimaryKeyRow[];
    execute?: (...args: unknown[]) => Promise<unknown>;
  }> = {},
) {
  const metadata = options.metadata ?? metadataRows;
  const primaryKeys = options.primaryKeys ?? primaryKeyRows;
  return createMcpApplication({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query(queryOptions: { readonly sql: string }) {
            if (queryOptions.sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) return [primaryKeys, []];
            if (queryOptions.sql.includes('FROM information_schema.TABLES AS tables')) return [metadata, []];
            return [[], []];
          },
          async execute(...args: unknown[]) {
            return options.execute?.(...args) ?? [{ affectedRows: 1, insertId: 42, warningStatus: 0 }, []];
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
    clientInfo: { name: 'insert-rows-unit-test', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

  return { request, close: () => application.close() };
}

function toolText(response: JsonRpcResponse): string {
  const content = response.result?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
  assert.equal(content[0]?.type, 'text');
  return content[0].text;
}

function insertArguments(rows: readonly Readonly<Record<string, unknown>>[] = [{ name: 'safe-value' }]) {
  return { schema: 'app', table: 'orders', rows, reason: 'controlled insert' };
}

test('registers insert_rows only when DML is enabled', async () => {
  const disabled = createMcpApplication({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'false' }),
    driver: {
      createPool() {
        return {
          async query() {
            return [[], []];
          },
          async end() {},
        } as never;
      },
    },
  });
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
      disabledTools.some(({ name }) => name === 'insert_rows'),
      false,
    );
    assert.deepEqual(enabledTools.find(({ name }) => name === 'insert_rows')?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  } finally {
    await disabledClient.close();
    await enabledClient.close();
  }
});

test('advertises insert_rows input limits, patterns, and scalar constraints', async () => {
  const application = createApplication();
  const client = await connect(application);

  try {
    const listed = await client.request('tools/list', {});
    const tool = (listed.result?.tools as ReadonlyArray<{ readonly name: string; readonly inputSchema?: Record<string, unknown> }>).find(
      ({ name }) => name === 'insert_rows',
    );
    const inputSchema = tool?.inputSchema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
    const rowItems = (properties.rows.items ?? {}) as Record<string, unknown>;
    const scalarAlternatives = ((rowItems.additionalProperties ?? {}) as Record<string, unknown>).anyOf as ReadonlyArray<Record<string, unknown>>;

    assert.equal(inputSchema['x-maxParameters'], MAX_DML_PARAMETERS);
    assert.equal(inputSchema['x-maxPayloadBytes'], MAX_DML_PAYLOAD_BYTES);
    assert.match(
      inputSchema.description as string,
      new RegExp(`${MAX_DML_ROWS}.*${MAX_DML_COLUMNS}.*${MAX_DML_PARAMETERS}.*${MAX_DML_PAYLOAD_BYTES}`),
    );
    for (const field of ['schema', 'table']) {
      assert.equal(properties[field].maxLength, MAX_DML_IDENTIFIER_LENGTH);
      assert.equal(properties[field].pattern, '^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\u2028\\u2029])');
    }
    assert.equal(properties.reason.maxLength, MAX_DML_REASON_LENGTH);
    assert.equal(properties.reason.pattern, properties.schema.pattern);
    assert.equal(properties.rows.maxItems, MAX_DML_ROWS);
    assert.equal(rowItems.maxProperties, MAX_DML_COLUMNS);
    assert.equal(scalarAlternatives[0]?.maxLength, MAX_DML_STRING_LENGTH);
    assert.deepEqual(scalarAlternatives[2], { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
  } finally {
    await client.close();
  }
});

test('executes one prepared insert and returns only sanitized result metadata', async () => {
  let receivedOptions: unknown;
  let receivedValues: unknown;
  const application = createApplication({
    execute: async (options, values) => {
      receivedOptions = options;
      receivedValues = values;
      return [{ affectedRows: 2, insertId: '9007199254740993', warningStatus: 1 }, []];
    },
  });
  const client = await connect(application);
  const secret = 'row-value-must-not-leak';

  try {
    const response = await client.request('tools/call', {
      name: 'insert_rows',
      arguments: insertArguments([{ name: secret }, { name: 'second-value' }]),
    });
    const result = JSON.parse(toolText(response)) as Record<string, unknown>;

    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(result, {
      operationId: result.operationId,
      target: { schema: 'app', table: 'orders' },
      affectedRows: 2,
      insertId: '9007199254740993',
      warnings: 1,
    });
    assert.equal(typeof result.operationId, 'string');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(receivedOptions, {
      sql: 'INSERT INTO `app`.`orders` (`name`) VALUES (?), (?)',
      timeout: 30_000,
    });
    assert.deepEqual(receivedValues, [secret, 'second-value']);
  } finally {
    await client.close();
  }
});

test('normalizes mysql2 signed BIGINT UNSIGNED insertId values', async () => {
  const application = createApplication({
    execute: async () => [{ affectedRows: 1, insertId: '-1', warningStatus: 0 }, []],
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'insert_rows',
      arguments: insertArguments(),
    });
    const result = JSON.parse(toolText(response)) as { insertId: string };
    assert.equal(result.insertId, '18446744073709551615');
  } finally {
    await client.close();
  }
});

for (const invalidInsertId of [
  { label: 'secret string', value: 'insert-id-secret' },
  { label: 'malformed string', value: '01' },
  { label: 'negative number', value: -1 },
  { label: 'decimal number', value: 1.5 },
  { label: 'oversized bigint', value: 18446744073709551616n },
  { label: 'object', value: { value: 'insert-id-secret' } },
] as const) {
  test(`rejects ${invalidInsertId.label} insertId without leaking it`, async () => {
    const application = createApplication({
      execute: async () => [{ affectedRows: 1, insertId: invalidInsertId.value, warningStatus: 0 }, []],
    });
    const client = await connect(application);

    try {
      const response = await client.request('tools/call', {
        name: 'insert_rows',
        arguments: insertArguments([{ name: 'insert-id-row-secret' }]),
      });
      assert.equal(response.result?.isError, true);
      assert.equal(toolText(response), 'The DML outcome is unknown; verify state before retrying.');
      assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DML_OUTCOME_UNKNOWN');
      assert.doesNotMatch(JSON.stringify(response), /insert-id-secret|insert-id-row-secret/);
    } finally {
      await client.close();
    }
  });
}

test('allows inserts into a base table without a primary key and orders columns deterministically', async () => {
  let receivedOptions: unknown;
  let receivedValues: unknown;
  const noPrimaryKeyMetadata = metadataRows.map((row) => ({ ...row, columnKey: '' }));
  const unorderedMetadata: MetadataRow[] = [
    { ...noPrimaryKeyMetadata[0], columnName: 'z', ordinalPosition: 1, extra: '' },
    { ...noPrimaryKeyMetadata[1], columnName: 'a', ordinalPosition: 2 },
  ];
  const application = createApplication({
    metadata: unorderedMetadata,
    primaryKeys: [],
    execute: async (options, values) => {
      receivedOptions = options;
      receivedValues = values;
      return [{ affectedRows: 1, insertId: 7, warningStatus: 0 }, []];
    },
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'insert_rows',
      arguments: insertArguments([{ z: 'z-value', a: 'a-value' }]),
    });
    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(receivedOptions, {
      sql: 'INSERT INTO `app`.`orders` (`a`, `z`) VALUES (?, ?)',
      timeout: 30_000,
    });
    assert.deepEqual(receivedValues, ['a-value', 'z-value']);
  } finally {
    await client.close();
  }
});

test('rejects bounded input violations before metadata or execution', async () => {
  let metadataCalls = 0;
  let executeCalls = 0;
  const application = createMcpApplication({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    driver: {
      createPool() {
        return {
          async query() {
            metadataCalls += 1;
            return [[], []];
          },
          async execute() {
            executeCalls += 1;
            return [{ affectedRows: 1, insertId: 1, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
  const client = await connect(application);
  const wideRow = Object.fromEntries(Array.from({ length: MAX_DML_COLUMNS + 1 }, (_, index) => [`c${index}`, index]));
  const parameterRows = Array.from({ length: Math.ceil((MAX_DML_PARAMETERS + 1) / MAX_DML_COLUMNS) }, () =>
    Object.fromEntries(Array.from({ length: MAX_DML_COLUMNS }, (_, index) => [`c${index}`, index])),
  );
  const payloadRows = Array.from({ length: Math.ceil((MAX_DML_PAYLOAD_BYTES + 1) / 8_300) }, () => ({ name: 'x'.repeat(8_192) }));

  try {
    for (const rows of [
      [],
      new Array(MAX_DML_ROWS + 1).fill({ name: 'x' }),
      [wideRow],
      parameterRows,
      payloadRows,
      [{ name: 'x' }, { other: 'y' }],
    ]) {
      const response = await client.request('tools/call', { name: 'insert_rows', arguments: insertArguments(rows) });
      assert.equal(response.result?.isError, true);
      assert.match(toolText(response), /Invalid arguments|DML request is invalid/);
      assert.doesNotMatch(toolText(response), /\bx\b|other/);
    }
    assert.equal(metadataCalls, 0);
    assert.equal(executeCalls, 0);
  } finally {
    await client.close();
  }
});

test('rejects unknown, invisible, generated, and AUTO_INCREMENT columns from metadata', async () => {
  const metadata: MetadataRow[] = [
    ...metadataRows,
    { ...metadataRows[1], columnName: 'generated_value', ordinalPosition: 3, extra: 'STORED GENERATED' },
    { ...metadataRows[1], columnName: 'invisible_value', ordinalPosition: 4, extra: 'INVISIBLE' },
  ];

  for (const column of ['missing', 'invisible_value', 'generated_value', 'id']) {
    let executeCalls = 0;
    const application = createApplication({
      metadata,
      execute: async () => {
        executeCalls += 1;
        return [{ affectedRows: 1, insertId: 1, warningStatus: 0 }, []];
      },
    });
    const client = await connect(application);
    try {
      const response = await client.request('tools/call', {
        name: 'insert_rows',
        arguments: insertArguments([{ [column]: 'candidate' }]),
      });
      assert.equal(response.result?.isError, true);
      assert.equal(toolText(response), 'The requested object is incompatible with this DML operation.');
      assert.equal(executeCalls, 0);
    } finally {
      await client.close();
    }
  }
});

test('maps MySQL permission denial to the sanitized DML taxonomy without leaking values', async () => {
  const secret = 'permission-secret-value';
  const application = createApplication({
    execute: async () => {
      const error = new Error(`Access denied for ${secret}`) as Error & { code: string };
      error.code = 'ER_TABLEACCESS_DENIED_ERROR';
      throw error;
    },
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'insert_rows',
      arguments: insertArguments([{ name: secret }]),
    });
    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'MySQL denied permission for this DML operation.');
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.match(JSON.stringify(response), /MYSQL_PERMISSION_DENIED/);
  } finally {
    await client.close();
  }
});

test('returns an unknown outcome with retry advice for post-submission timeout and transport loss', async () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
    const application = createApplication({
      execute: async () => {
        throw Object.assign(new Error(`raw ${code} detail`), { code });
      },
    });
    const client = await connect(application);

    try {
      const response = await client.request('tools/call', {
        name: 'insert_rows',
        arguments: insertArguments([{ name: 'post-submit-secret' }]),
      });
      assert.equal(response.result?.isError, true);
      assert.equal(toolText(response), 'The DML outcome is unknown; verify state before retrying.');
      assert.deepEqual(response.result?.structuredContent, {
        code: 'MYSQL_DML_OUTCOME_UNKNOWN',
        message: 'The DML outcome is unknown; verify state before retrying.',
        retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
      });
      assert.doesNotMatch(JSON.stringify(response), /raw|post-submit-secret/);
    } finally {
      await client.close();
    }
  }
});

test('maps malformed post-execute result metadata to an unknown outcome', async () => {
  const application = createApplication({
    execute: async () => [{ affectedRows: 'not-a-count', warningStatus: 0 }, []],
  });
  const client = await connect(application);

  try {
    const response = await client.request('tools/call', {
      name: 'insert_rows',
      arguments: insertArguments([{ name: 'malformed-result-secret' }]),
    });
    assert.equal(response.result?.isError, true);
    assert.equal(toolText(response), 'The DML outcome is unknown; verify state before retrying.');
    assert.equal((response.result?.structuredContent as { code: string }).code, 'MYSQL_DML_OUTCOME_UNKNOWN');
    assert.doesNotMatch(JSON.stringify(response), /malformed-result-secret|not-a-count/);
  } finally {
    await client.close();
  }
});

test('advertises the structured sanitized error shape alongside the success fields', async () => {
  const application = createApplication({
    execute: async () => {
      throw Object.assign(new Error('permission detail'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    },
  });
  const client = await connect(application);

  try {
    const listed = await client.request('tools/list', {});
    const tool = (listed.result?.tools as ReadonlyArray<{ readonly name: string; readonly outputSchema?: Record<string, unknown> }>).find(
      ({ name }) => name === 'insert_rows',
    );
    assert.equal(tool?.outputSchema?.type, 'object');
    assert.deepEqual(
      (tool?.outputSchema?.anyOf as ReadonlyArray<Record<string, unknown>>).map((schema) => schema.required),
      [
        ['operationId', 'target', 'affectedRows', 'insertId', 'warnings'],
        ['code', 'message'],
      ],
    );
  } finally {
    await client.close();
  }
});
