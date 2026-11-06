import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { createCreateTableStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { createTableInputJsonSchema, normalizeCreateTableInput, type CreateTableInput } from './create-table-input.js';

type CreateTableResult = Readonly<{
  operation: 'create_table';
  operationId: string;
  target: Readonly<{ schema: string; table: string }>;
  warnings: number;
}>;

type CreateTableError = Readonly<{
  code: string;
  message: string;
  retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING';
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCreateTableInputShape(value: unknown): value is CreateTableInput {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.reason === 'string' &&
    Array.isArray(value.columns) &&
    Array.isArray(value.primaryKey)
  );
}

function isCreateTableResult(value: unknown): value is CreateTableResult {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    value.operation === 'create_table' &&
    typeof value.operationId === 'string' &&
    isRecord(value.target) &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function isCreateTableError(value: unknown): value is CreateTableError {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

const inputSchema: StandardSchemaWithJSON<CreateTableInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return isCreateTableInputShape(value) ? { value } : { issues: [{ message: 'Invalid arguments for create_table.' }] };
    },
    jsonSchema: { input: () => createTableInputJsonSchema(), output: () => createTableInputJsonSchema() },
  },
};

const outputSchema: StandardSchemaWithJSON<CreateTableResult | CreateTableError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return isCreateTableResult(value) || isCreateTableError(value) ? { value } : { issues: [{ message: 'create_table result is invalid.' }] };
    },
    jsonSchema: {
      input: () => ({
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['operation', 'operationId', 'target', 'warnings'],
            properties: {
              operation: { const: 'create_table' },
              operationId: { type: 'string', minLength: 1 },
              target: {
                type: 'object',
                additionalProperties: false,
                required: ['schema', 'table'],
                properties: { schema: { type: 'string' }, table: { type: 'string' } },
              },
              warnings: { type: 'integer', minimum: 0 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: {
                enum: [
                  'MYSQL_DDL_INVALID_ARGUMENT',
                  'MYSQL_DDL_DISABLED',
                  'MYSQL_DDL_FAILED',
                  'MYSQL_DDL_OUTCOME_UNKNOWN',
                  'MYSQL_DDL_PERMISSION_DENIED',
                  'MYSQL_DDL_TABLE_EXISTS',
                  'MYSQL_DDL_LOCK_TIMEOUT',
                  'MYSQL_DDL_DEADLOCK',
                  'MYSQL_DDL_STRUCTURE_INVALID',
                ],
              },
              message: { type: 'string' },
              retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] },
            },
          },
        ],
      }),
      output: () => ({
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['operation', 'operationId', 'target', 'warnings'],
            properties: {
              operation: { const: 'create_table' },
              operationId: { type: 'string', minLength: 1 },
              target: {
                type: 'object',
                additionalProperties: false,
                required: ['schema', 'table'],
                properties: { schema: { type: 'string' }, table: { type: 'string' } },
              },
              warnings: { type: 'integer', minimum: 0 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: {
                enum: [
                  'MYSQL_DDL_INVALID_ARGUMENT',
                  'MYSQL_DDL_DISABLED',
                  'MYSQL_DDL_FAILED',
                  'MYSQL_DDL_OUTCOME_UNKNOWN',
                  'MYSQL_DDL_PERMISSION_DENIED',
                  'MYSQL_DDL_TABLE_EXISTS',
                  'MYSQL_DDL_LOCK_TIMEOUT',
                  'MYSQL_DDL_DEADLOCK',
                  'MYSQL_DDL_STRUCTURE_INVALID',
                ],
              },
              message: { type: 'string' },
              retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] },
            },
          },
        ],
      }),
    },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerCreateTableTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'create_table',
    {
      title: 'Create a bounded MySQL table',
      description: 'Creates one table from a validated structured specification. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeCreateTableInput(input);
        const statement = createCreateTableStatement(normalized);
        const [result, operationId] = await mysql.ddl.executeCreateTableWithOperationId(statement);
        const response: CreateTableResult = {
          operation: 'create_table',
          operationId,
          target: { schema: normalized.schema, table: normalized.table },
          warnings: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
