import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateCreateViewMetadata } from '../db/metadata.js';
import { createCreateViewStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { createViewInputJsonSchema, normalizeCreateViewInput, type CreateViewInput } from './create-view-input.js';

type CreateViewResult = Readonly<{
  operation: 'create_view';
  operationId: string;
  target: Readonly<{ schema: string; view: string }>;
  source: Readonly<{ schema: string; table: string; columns: readonly string[] }>;
  warnings: number;
}>;
type CreateViewError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const CREATE_VIEW_ERROR_CODES = [
  'MYSQL_DDL_INVALID_ARGUMENT',
  'MYSQL_DDL_DISABLED',
  'MYSQL_DDL_FAILED',
  'MYSQL_DDL_OUTCOME_UNKNOWN',
  'MYSQL_DDL_PERMISSION_DENIED',
  'MYSQL_DDL_TABLE_EXISTS',
  'MYSQL_DDL_LOCK_TIMEOUT',
  'MYSQL_DDL_DEADLOCK',
  'MYSQL_DDL_STRUCTURE_INVALID',
  'MYSQL_DDL_METADATA_INVALID',
  'MYSQL_DDL_TABLE_INVALID',
] as const;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && Object.keys(value).length === value.length && value.every((item) => typeof item === 'string');
}
function validInput(value: unknown): value is CreateViewInput {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.schema === 'string' &&
    typeof value.view === 'string' &&
    typeof value.reason === 'string' &&
    record(value.definition) &&
    Object.keys(value.definition).length === 2 &&
    typeof value.definition.table === 'string' &&
    stringArray(value.definition.columns)
  );
}
function validResult(value: unknown): value is CreateViewResult {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    value.operation === 'create_view' &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    record(value.target) &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.view === 'string' &&
    record(value.source) &&
    Object.keys(value.source).length === 3 &&
    typeof value.source.schema === 'string' &&
    typeof value.source.table === 'string' &&
    stringArray(value.source.columns) &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}
function validError(value: unknown): value is CreateViewError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    CREATE_VIEW_ERROR_CODES.includes(value.code as (typeof CREATE_VIEW_ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}
function validOutput(value: unknown): value is CreateViewResult | CreateViewError {
  return validResult(value) || validError(value);
}
export function createViewOutputJsonSchema(): Record<string, unknown> {
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'source', 'warnings'],
    properties: {
      operation: { const: 'create_view' },
      operationId: { type: 'string', minLength: 1 },
      warnings: { type: 'integer', minimum: 0 },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['schema', 'view'],
        properties: { schema: { type: 'string' }, view: { type: 'string' } },
      },
      source: {
        type: 'object',
        additionalProperties: false,
        required: ['schema', 'table', 'columns'],
        properties: { schema: { type: 'string' }, table: { type: 'string' }, columns: { type: 'array', minItems: 1, items: { type: 'string' } } },
      },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: { code: { enum: CREATE_VIEW_ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [result, error] };
}
const inputSchema: StandardSchemaWithJSON<CreateViewInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for create_view.' }] };
    },
    jsonSchema: { input: () => createViewInputJsonSchema(), output: () => createViewInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<CreateViewResult | CreateViewError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'create_view result is invalid.' }] };
    },
    jsonSchema: { input: createViewOutputJsonSchema, output: createViewOutputJsonSchema },
  },
};
function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent =
    outcome.retryAdvice === undefined
      ? { code: outcome.code, message: outcome.message }
      : { code: outcome.code, message: outcome.message, retryAdvice: outcome.retryAdvice };
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

/** Registers the constrained same-schema base-table projection CREATE VIEW operation. */
export function registerCreateViewTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'create_view',
    {
      title: 'Create a constrained MySQL view',
      description:
        'Creates one SQL SECURITY INVOKER view from a validated projection of one same-schema base table. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeCreateViewInput(input);
        await validateCreateViewMetadata(mysql, normalized.schema, normalized.view, normalized.definition.table, normalized.definition.columns);
        const [result, operationId] = await mysql.ddl.executeCreateViewWithOperationId(createCreateViewStatement(normalized));
        const response: CreateViewResult = Object.freeze({
          operation: 'create_view',
          operationId,
          target: Object.freeze({ schema: normalized.schema, view: normalized.view }),
          source: Object.freeze({ schema: normalized.schema, table: normalized.definition.table, columns: normalized.definition.columns }),
          warnings: result.warningStatus,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
