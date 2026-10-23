import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { createMcpApplication } from '../../src/server.js';

import { validEnvironment } from './fixtures.js';

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
}

const auditLines: string[] = [];

function createApplication() {
  auditLines.length = 0;
  return createMcpApplication({
    environment: validEnvironment({ MYSQL_DML_ENABLED: 'true' }),
    dmlAuditWriter: (line) => auditLines.push(line),
    driver: {
      createPool() {
        return {
          async query(options: unknown) {
            const sql = (options as { readonly sql: string }).sql;

            if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) {
              return [
                [{ schemaName: 'demo_catalog', tableName: 'sample_records', constraintName: 'PRIMARY', columnName: 'record_id', ordinalPosition: 1 }],
              ];
            }

            if (sql.includes('FROM information_schema.SCHEMATA')) {
              return [[{ schemaName: 'demo_catalog' }]];
            }

            if (sql.includes('FROM information_schema.TABLES AS tables')) {
              return [
                [
                  {
                    schemaName: 'demo_catalog',
                    tableName: 'sample_records',
                    tableType: 'BASE TABLE',
                    columnName: 'record_id',
                    dataType: 'bigint',
                    isNullable: 'NO',
                    columnKey: 'PRI',
                    ordinalPosition: 1,
                    extra: 'auto_increment',
                  },
                  {
                    schemaName: 'demo_catalog',
                    tableName: 'sample_records',
                    tableType: 'BASE TABLE',
                    columnName: 'created_at',
                    dataType: 'datetime',
                    isNullable: 'NO',
                    columnKey: '',
                    ordinalPosition: 2,
                    extra: '',
                  },
                  {
                    schemaName: 'demo_catalog',
                    tableName: 'sample_records',
                    tableType: 'BASE TABLE',
                    columnName: 'label',
                    dataType: 'varchar',
                    isNullable: 'NO',
                    columnKey: '',
                    ordinalPosition: 3,
                    extra: '',
                  },
                ],
              ];
            }

            if (sql.includes('FROM information_schema.TABLES')) {
              return [[{ schemaName: 'demo_catalog', tableName: 'sample_records', tableType: 'BASE TABLE' }]];
            }

            if (sql.startsWith('EXPLAIN ')) {
              return [
                [{ id: 1, select_type: 'SIMPLE', table: 'sample_records', type: 'ALL', rows: 2n, Extra: 'Using filesort' }],
                [
                  { name: 'id', typeName: 'LONG' },
                  { name: 'select_type', typeName: 'VAR_STRING' },
                  { name: 'table', typeName: 'VAR_STRING' },
                  { name: 'type', typeName: 'VAR_STRING' },
                  { name: 'rows', typeName: 'LONGLONG' },
                  { name: 'Extra', typeName: 'VAR_STRING' },
                ],
              ];
            }

            return [
              [
                { record_id: 2, created_at: '2026-01-02T00:00:00.000Z' },
                { record_id: 1, created_at: '2026-01-01T00:00:00.000Z' },
              ],
              [
                { name: 'record_id', typeName: 'LONGLONG' },
                { name: 'created_at', typeName: 'DATETIME' },
              ],
            ];
          },
          async execute(options: { readonly sql: string }) {
            if (options.sql.startsWith('INSERT ')) return [{ affectedRows: 1, insertId: 3, warningStatus: 0 }, []];
            return [{ affectedRows: 1, changedRows: 1, warningStatus: 0 }, []];
          },
          async end() {},
        } as never;
      },
    },
  });
}

async function connect(application: ReturnType<typeof createApplication>) {
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
    clientInfo: { name: 'sanitized-workflow-demo', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as never);

  return { request, close: () => application.close() };
}

function toolResult(response: JsonRpcResponse): unknown {
  const content = response.result?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
  assert.equal(content[0]?.type, 'text');
  return JSON.parse(content[0].text);
}

function assertDmlResponse(response: JsonRpcResponse, operation: string, forbiddenValues: readonly string[]) {
  const content = response.result?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
  const structured = response.result?.structuredContent as Record<string, unknown>;
  assert.equal(structured.operation, operation);
  assert.equal(typeof structured.operationId, 'string');
  assert.deepEqual(structured.target, { schema: 'demo_catalog', table: 'sample_records' });
  assert.equal(typeof structured.affectedRows, 'number');
  if (operation === 'insert') assert.ok(Object.hasOwn(structured, 'warnings'));
  if (operation === 'update') {
    assert.equal(typeof structured.matchedRows, 'number');
    assert.equal(typeof structured.changedRows, 'number');
    assert.equal(typeof structured.warningCount, 'number');
  }
  if (operation === 'delete') assert.equal(typeof structured.warningCount, 'number');
  for (const value of forbiddenValues) assert.equal(JSON.stringify(structured).includes(value), false);
  for (const value of forbiddenValues)
    assert.equal(
      content.some(({ text }) => text.includes(value)),
      false,
    );
}

test('runs the published sanitized MCP workflow', async () => {
  const application = createApplication();
  const client = await connect(application);
  const sql = 'SELECT record_id, created_at FROM demo_catalog.sample_records ORDER BY created_at DESC, record_id DESC LIMIT 2';

  try {
    assert.deepEqual(toolResult(await client.request('tools/call', { name: 'list_accessible_schemas', arguments: {} })), {
      metadata: [{ schemaName: 'demo_catalog' }],
    });
    assert.deepEqual(toolResult(await client.request('tools/call', { name: 'list_accessible_tables', arguments: { schema: 'demo_catalog' } })), {
      metadata: [{ schemaName: 'demo_catalog', tableName: 'sample_records', tableType: 'BASE TABLE' }],
    });
    assert.deepEqual(
      toolResult(
        await client.request('tools/call', {
          name: 'describe_table',
          arguments: { schema: 'demo_catalog', table: 'sample_records' },
        }),
      ),
      {
        table: { schemaName: 'demo_catalog', tableName: 'sample_records', tableType: 'BASE TABLE' },
        columns: [
          { columnName: 'record_id', dataType: 'bigint', isNullable: false, columnKey: 'PRI' },
          { columnName: 'created_at', dataType: 'datetime', isNullable: false, columnKey: '' },
          { columnName: 'label', dataType: 'varchar', isNullable: false, columnKey: '' },
        ],
      },
    );
    assert.deepEqual(toolResult(await client.request('tools/call', { name: 'execute_read_only_query', arguments: { sql, parameters: [] } })), {
      columns: [
        { name: 'record_id', type: 'LONGLONG' },
        { name: 'created_at', type: 'DATETIME' },
      ],
      rows: [
        { record_id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        { record_id: 1, created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    assert.deepEqual(toolResult(await client.request('tools/call', { name: 'explain_read_only_query', arguments: { sql, parameters: [] } })), {
      columns: [
        { name: 'id', type: 'LONG' },
        { name: 'select_type', type: 'VAR_STRING' },
        { name: 'table', type: 'VAR_STRING' },
        { name: 'type', type: 'VAR_STRING' },
        { name: 'rows', type: 'LONGLONG' },
        { name: 'Extra', type: 'VAR_STRING' },
      ],
      rows: [{ id: 1, select_type: 'SIMPLE', table: 'sample_records', type: 'ALL', rows: '2', Extra: 'Using filesort' }],
    });

    const insertResponse = await client.request('tools/call', {
      name: 'insert_rows',
      arguments: {
        schema: 'demo_catalog',
        table: 'sample_records',
        rows: [{ label: 'synthetic example' }],
        reason: 'Create the synthetic example record',
      },
    });
    assertDmlResponse(insertResponse, 'insert', ['synthetic example']);
    const updateResponse = await client.request('tools/call', {
      name: 'update_rows',
      arguments: {
        schema: 'demo_catalog',
        table: 'sample_records',
        values: { label: 'updated synthetic example' },
        filters: [{ column: 'record_id', operator: 'eq', value: 1 }],
        limit: 1,
        reason: 'Correct the synthetic example label',
      },
    });
    assertDmlResponse(updateResponse, 'update', ['updated synthetic example']);
    const deleteResponse = await client.request('tools/call', {
      name: 'delete_rows',
      arguments: {
        schema: 'demo_catalog',
        table: 'sample_records',
        filters: [{ column: 'record_id', operator: 'eq', value: 1 }],
        limit: 1,
        reason: 'Remove the synthetic example record',
      },
    });
    assertDmlResponse(deleteResponse, 'delete', []);
    assert.ok(auditLines.length >= 6);
    assert.equal(
      auditLines.some((line) => line.includes('2026-01-03T00:00:00.000Z') || line.includes('updated synthetic example')),
      false,
    );
  } finally {
    await client.close();
  }
});
