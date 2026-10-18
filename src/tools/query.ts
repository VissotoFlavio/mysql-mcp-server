import { Buffer } from 'node:buffer';

import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { FieldPacket, RowDataPacket } from 'mysql2';
import mysql from 'mysql2/promise';

import type { ConnectionLayer } from '../db/pool.js';
import { prepareBoundedSelectSql, SqlPolicyError } from '../db/sql-policy.js';

export const MAX_QUERY_RESULTS = 100;
export const MAX_QUERY_COLUMNS = 100;
export const MAX_QUERY_RESPONSE_BYTES = 1_048_576;
export const MAX_QUERY_SQL_LENGTH = 10_000;
export const MAX_QUERY_PARAMETERS = 100;
export const MAX_QUERY_PARAMETER_LENGTH = 8_192;

type QueryValue = string | number | boolean | null;
type QueryInput = Readonly<{ sql: string; parameters: readonly QueryValue[] }>;
type QueryColumn = Readonly<{ name: string; type: string | null }>;
type QueryRow = Readonly<Record<string, QueryValue>>;
type QueryResult = Readonly<{ columns: readonly QueryColumn[]; rows: readonly QueryRow[] }>;

class QueryResponseLimitError extends Error {
  constructor() {
    super('Query response exceeded its configured limit.');
    this.name = 'QueryResponseLimitError';
  }
}

const queryInputSchema: StandardSchemaWithJSON<QueryInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isQueryInput(value)) {
        return { issues: [{ message: 'sql must be a non-empty statement and parameters must be a bounded collection of JSON scalar values' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => queryInputJsonSchema(),
      output: () => queryInputJsonSchema(),
    },
  },
};

const queryOutputSchema: StandardSchemaWithJSON<QueryResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isQueryResult(value)) {
        return { issues: [{ message: 'query result must contain bounded column metadata and JSON-compatible rows' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => queryOutputJsonSchema(),
      output: () => queryOutputJsonSchema(),
    },
  },
};

function isQueryInput(value: unknown): value is QueryInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 2 &&
    typeof input.sql === 'string' &&
    input.sql.trim().length > 0 &&
    input.sql.length <= MAX_QUERY_SQL_LENGTH &&
    Array.isArray(input.parameters) &&
    input.parameters.length <= MAX_QUERY_PARAMETERS &&
    input.parameters.every(isQueryValue)
  );
}

function isQueryValue(value: unknown): value is QueryValue {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= MAX_QUERY_PARAMETER_LENGTH)
  );
}

function isQueryResult(value: unknown): value is QueryResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 2 &&
    Array.isArray(result.columns) &&
    result.columns.length <= MAX_QUERY_COLUMNS &&
    result.columns.every(isQueryColumn) &&
    Array.isArray(result.rows) &&
    result.rows.length <= MAX_QUERY_RESULTS &&
    result.rows.every(isQueryRow)
  );
}

function isQueryColumn(value: unknown): value is QueryColumn {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const column = value as Record<string, unknown>;
  return Object.keys(column).length === 2 && typeof column.name === 'string' && (typeof column.type === 'string' || column.type === null);
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every(isQueryValue);
}

function queryInputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['sql', 'parameters'],
    properties: {
      sql: { type: 'string', minLength: 1, maxLength: MAX_QUERY_SQL_LENGTH },
      parameters: {
        type: 'array',
        maxItems: MAX_QUERY_PARAMETERS,
        items: {
          anyOf: [{ type: 'string', maxLength: MAX_QUERY_PARAMETER_LENGTH }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
        },
      },
    },
  };
}

function queryOutputJsonSchema(): Record<string, unknown> {
  const queryValueSchema = {
    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['columns', 'rows'],
    properties: {
      columns: {
        type: 'array',
        maxItems: MAX_QUERY_COLUMNS,
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
        maxItems: MAX_QUERY_RESULTS,
        items: {
          type: 'object',
          additionalProperties: queryValueSchema,
        },
      },
    },
  };
}

function toQueryValue(value: unknown): QueryValue {
  if (isQueryValue(value)) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  throw new QueryResponseLimitError();
}

function columnType(field: FieldPacket): string | null {
  if (field.typeName !== undefined) {
    return field.typeName;
  }

  const typeCode = field.columnType ?? field.type;
  if (typeCode === undefined) {
    return null;
  }

  const typeName = mysql.Types[typeCode as keyof typeof mysql.Types];
  return typeof typeName === 'string' ? typeName : null;
}

function toQueryResult(rows: readonly RowDataPacket[], fields: readonly FieldPacket[]): QueryResult {
  if (fields.length > MAX_QUERY_COLUMNS) {
    throw new QueryResponseLimitError();
  }

  return {
    columns: fields.map((field) => ({ name: field.name, type: columnType(field) })),
    rows: rows.slice(0, MAX_QUERY_RESULTS).map((row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, toQueryValue(value)]))),
  };
}

function serializeQueryResult(result: QueryResult): string {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_QUERY_RESPONSE_BYTES) {
    throw new QueryResponseLimitError();
  }

  return serialized;
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function queryResult(result: QueryResult, serialized: string) {
  return {
    content: [{ type: 'text' as const, text: serialized }],
    structuredContent: result,
  };
}

export function registerReadOnlyQueryTool(server: McpServer, mysql: ConnectionLayer): void {
  server.registerTool(
    'execute_read_only_query',
    {
      title: 'Execute a bounded read-only query',
      description:
        'Executes one approved SELECT query with driver-bound parameters, a configured timeout, and bounded results. This tool is read-only.',
      inputSchema: queryInputSchema,
      outputSchema: queryOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ sql, parameters }) => {
      try {
        const boundedSql = prepareBoundedSelectSql(sql, MAX_QUERY_RESULTS);
        const [rows, fields] = await mysql.query<RowDataPacket[]>({ ...mysql.queryOptions(), sql: boundedSql }, [...parameters]);
        const result = toQueryResult(rows, fields);
        return queryResult(result, serializeQueryResult(result));
      } catch (error) {
        if (error instanceof SqlPolicyError) {
          return errorResult('The query must be a single approved read-only SELECT statement.');
        }

        if (error instanceof QueryResponseLimitError) {
          return errorResult('The query result exceeds the 1 MiB response limit. Refine the query and try again.');
        }

        return errorResult('Unable to execute the query. Verify the configured MySQL connection and query parameters.');
      }
    },
  );
}
