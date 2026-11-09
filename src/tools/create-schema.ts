import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateCreateSchemaMetadata } from '../db/metadata.js';
import { createCreateSchemaStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { createSchemaInputJsonSchema, normalizeCreateSchemaInput, type CreateSchemaInput } from './create-schema-input.js';

type CreateSchemaResult = Readonly<{
  operation: 'create_schema';
  operationId: string;
  target: Readonly<{ schema: string; charset?: string; collation?: string }>;
  warnings: number;
}>;
type CreateSchemaError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const CREATE_SCHEMA_ERROR_CODES = [
  'MYSQL_DDL_INVALID_ARGUMENT',
  'MYSQL_DDL_DISABLED',
  'MYSQL_DDL_FAILED',
  'MYSQL_DDL_OUTCOME_UNKNOWN',
  'MYSQL_DDL_PERMISSION_DENIED',
  'MYSQL_DDL_SCHEMA_EXISTS',
  'MYSQL_DDL_LOCK_TIMEOUT',
  'MYSQL_DDL_DEADLOCK',
  'MYSQL_DDL_STRUCTURE_INVALID',
  'MYSQL_DDL_METADATA_INVALID',
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is CreateSchemaInput {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['schema', 'charset', 'collation', 'reason'].includes(key)) &&
    typeof value.schema === 'string' &&
    typeof value.reason === 'string'
  );
}

function validResult(value: unknown): value is CreateSchemaResult {
  if (!record(value) || Object.keys(value).length !== 4 || value.operation !== 'create_schema' || typeof value.operationId !== 'string') return false;
  if (!record(value.target)) return false;
  const targetKeys = Object.keys(value.target);
  return (
    targetKeys.includes('schema') &&
    targetKeys.every((key) => ['schema', 'charset', 'collation'].includes(key)) &&
    typeof value.target.schema === 'string' &&
    (value.target.charset === undefined || typeof value.target.charset === 'string') &&
    (value.target.collation === undefined || typeof value.target.collation === 'string') &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function validError(value: unknown): value is CreateSchemaError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    CREATE_SCHEMA_ERROR_CODES.includes(value.code as (typeof CREATE_SCHEMA_ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function validOutput(value: unknown): value is CreateSchemaResult | CreateSchemaError {
  return validResult(value) || validError(value);
}

export function createSchemaOutputJsonSchema(): Record<string, unknown> {
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'warnings'],
    properties: {
      operation: { const: 'create_schema' },
      operationId: { type: 'string', minLength: 1 },
      warnings: { type: 'integer', minimum: 0 },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['schema'],
        properties: { schema: { type: 'string' }, charset: { type: 'string' }, collation: { type: 'string' } },
      },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: { code: { enum: CREATE_SCHEMA_ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [result, error] };
}

const inputSchema: StandardSchemaWithJSON<CreateSchemaInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for create_schema.' }] };
    },
    jsonSchema: { input: () => createSchemaInputJsonSchema(), output: () => createSchemaInputJsonSchema() },
  },
};

const outputSchema: StandardSchemaWithJSON<CreateSchemaResult | CreateSchemaError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'create_schema result is invalid.' }] };
    },
    jsonSchema: { input: createSchemaOutputJsonSchema, output: createSchemaOutputJsonSchema },
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

/** Registers the strict, opt-in CREATE SCHEMA operation. */
export function registerCreateSchemaTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'create_schema',
    {
      title: 'Create a controlled MySQL schema',
      description:
        'Creates one absent MySQL schema from a strict identifier and optional allowlisted charset/collation. The operation is non-idempotent, audited, and requires both DDL opt-ins.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeCreateSchemaInput(input);
        await validateCreateSchemaMetadata(mysql, normalized.schema);
        const [result, operationId] = await mysql.ddl.executeCreateSchemaWithOperationId(createCreateSchemaStatement(normalized));
        const response: CreateSchemaResult = Object.freeze({
          operation: 'create_schema',
          operationId,
          target: Object.freeze({
            schema: normalized.schema,
            ...(normalized.charset === undefined ? {} : { charset: normalized.charset }),
            ...(normalized.collation === undefined ? {} : { collation: normalized.collation }),
          }),
          warnings: result.warningStatus,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
