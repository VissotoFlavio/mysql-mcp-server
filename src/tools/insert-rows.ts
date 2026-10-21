import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { ResultSetHeader } from 'mysql2';

import { toSafeDmlOutcome } from '../db/dml-audit.js';
import { validateDmlMetadata } from '../db/metadata.js';
import {
  createAuditedDmlStatement,
  DmlResultError,
  normalizeDmlInsertId,
  type ConnectionLayerBundle,
  type DmlStatement,
  wasDmlSubmitted,
} from '../db/pool.js';

import {
  MAX_DML_COLUMNS,
  DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  DML_SCALAR_JSON_SCHEMA,
  MAX_DML_IDENTIFIER_LENGTH,
  MAX_DML_PARAMETERS,
  MAX_DML_PAYLOAD_BYTES,
  MAX_DML_REASON_LENGTH,
  MAX_DML_ROWS,
  normalizeDmlInsertInput,
  type DmlInsertInput,
  type DmlScalar,
} from './dml-input.js';

type InsertRowsInput = Readonly<{
  schema: string;
  table: string;
  rows: readonly Readonly<Record<string, DmlScalar>>[];
  reason: string;
}>;

type InsertRowsResult = Readonly<{
  operation: 'insert';
  operationId: string;
  target: Readonly<{ schema: string; table: string }>;
  affectedRows: number;
  insertId: string | null;
  warnings: number;
}>;

type InsertRowsError = Readonly<{
  code: string;
  message: string;
  retryAdvice?: string;
}>;

const insertRowsInputSchema: StandardSchemaWithJSON<InsertRowsInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isInsertRowsInputShape(value)) {
        return { issues: [{ message: 'Invalid arguments for insert_rows.' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => insertRowsInputJsonSchema(),
      output: () => insertRowsInputJsonSchema(),
    },
  },
};

const insertRowsOutputSchema: StandardSchemaWithJSON<InsertRowsResult | InsertRowsError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isInsertRowsResult(value) && !isInsertRowsError(value)) {
        return { issues: [{ message: 'insert_rows result is invalid.' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => insertRowsOutputJsonSchema(),
      output: () => insertRowsOutputJsonSchema(),
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInsertRowsInputShape(value: unknown): value is InsertRowsInput {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  return typeof value.schema === 'string' && typeof value.table === 'string' && typeof value.reason === 'string' && Array.isArray(value.rows);
}

function insertRowsInputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: `Insert 1-${MAX_DML_ROWS} rows with at most ${MAX_DML_COLUMNS} columns and ${MAX_DML_PARAMETERS} prepared parameters within a ${MAX_DML_PAYLOAD_BYTES}-byte JSON payload.`,
    'x-maxParameters': MAX_DML_PARAMETERS,
    'x-maxPayloadBytes': MAX_DML_PAYLOAD_BYTES,
    additionalProperties: false,
    required: ['schema', 'table', 'rows', 'reason'],
    properties: {
      schema: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
      table: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DML_ROWS,
        items: {
          type: 'object',
          minProperties: 1,
          maxProperties: MAX_DML_COLUMNS,
          propertyNames: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_DML_IDENTIFIER_LENGTH,
            pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
          },
          additionalProperties: DML_SCALAR_JSON_SCHEMA,
        },
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_DML_REASON_LENGTH,
        pattern: `^(?=.*\\S)${DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
  };
}

function insertRowsOutputJsonSchema(): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'operationId', 'target', 'affectedRows', 'insertId', 'warnings'],
        properties: {
          operation: { const: 'insert' },
          operationId: { type: 'string', minLength: 1 },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['schema', 'table'],
            properties: {
              schema: { type: 'string' },
              table: { type: 'string' },
            },
          },
          affectedRows: { type: 'integer', minimum: 0, maximum: MAX_DML_ROWS },
          insertId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          warnings: { type: 'integer', minimum: 0 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            enum: [
              'MYSQL_DML_INVALID_ARGUMENT',
              'MYSQL_DML_INCOMPATIBLE_OBJECT',
              'MYSQL_DML_DISABLED',
              'MYSQL_DML_FAILED',
              'MYSQL_DML_OUTCOME_UNKNOWN',
              'MYSQL_CONSTRAINT_VIOLATION',
              'MYSQL_DUPLICATE_KEY',
              'MYSQL_FOREIGN_KEY_VIOLATION',
              'MYSQL_PERMISSION_DENIED',
            ],
          },
          message: { type: 'string' },
          retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] },
        },
      },
    ],
  };
}

function isInsertRowsResult(value: unknown): value is InsertRowsResult {
  if (!isRecord(value) || Object.keys(value).length !== 6 || !isRecord(value.target)) return false;
  return (
    value.operation === 'insert' &&
    typeof value.operationId === 'string' &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    typeof value.affectedRows === 'number' &&
    Number.isSafeInteger(value.affectedRows) &&
    value.affectedRows >= 0 &&
    value.affectedRows <= MAX_DML_ROWS &&
    (typeof value.insertId === 'string' || value.insertId === null) &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function isInsertRowsError(value: unknown): value is InsertRowsError {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function errorResult(error: unknown) {
  const outcome = toSafeDmlOutcome(error, wasDmlSubmitted(error));
  const structuredContent =
    outcome.retryAdvice === undefined
      ? { code: outcome.code, message: outcome.message }
      : { code: outcome.code, message: outcome.message, retryAdvice: outcome.retryAdvice };
  return {
    content: [{ type: 'text' as const, text: outcome.message }],
    structuredContent,
    isError: true,
  };
}

function safeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new Error('Invalid DML result count.');
}

function safeInsertId(value: unknown): string | null {
  return normalizeDmlInsertId(value);
}

function insertRowsResult(result: ResultSetHeader, operationId: string, input: DmlInsertInput): InsertRowsResult {
  const affectedRows = safeCount(result.affectedRows);
  if (affectedRows > MAX_DML_ROWS) throw new DmlResultError();
  return {
    operation: 'insert',
    operationId,
    target: { schema: input.target.schema, table: input.target.table },
    affectedRows,
    insertId: safeInsertId(result.insertId),
    warnings: safeCount(result.warningStatus),
  };
}

export function registerInsertRowsTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'insert_rows',
    {
      title: 'Insert rows into a MySQL table',
      description:
        'Inserts bounded rows into one validated MySQL base table using one prepared statement. The operation is audited and requires DML opt-in.',
      inputSchema: insertRowsInputSchema,
      outputSchema: insertRowsOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      let normalized: DmlInsertInput;
      try {
        normalized = normalizeDmlInsertInput(input);
        await validateDmlMetadata(mysql, normalized.target.schema, normalized.target.table, normalized.columns, { operation: 'insert' });
        const statement: DmlStatement = createAuditedDmlStatement('insert', normalized);
        const [result, , operationId] = await mysql.dml.executeDmlWithOperationId<ResultSetHeader>(statement);
        const response = insertRowsResult(result, operationId, normalized);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          structuredContent: response,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
