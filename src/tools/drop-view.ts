import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateDropViewMetadata, verifyDropViewMetadata } from '../db/metadata.js';
import { createDropViewStatement, DdlResultError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { DROP_VIEW_CONFIRMATION, dropViewInputJsonSchema, normalizeDropViewInput, type DropViewInput } from './drop-view-input.js';

type DropViewResult = Readonly<{
  operation: 'drop_view';
  operationId: string;
  target: Readonly<{ schema: string; view: string }>;
  warnings: number;
}>;
type DropViewError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const DROP_VIEW_ERROR_CODES = [
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

function validInput(value: unknown): value is DropViewInput {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.schema === 'string' &&
    typeof value.view === 'string' &&
    typeof value.reason === 'string' &&
    value.confirmation === DROP_VIEW_CONFIRMATION
  );
}

function validResult(value: unknown): value is DropViewResult {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    value.operation === 'drop_view' &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    record(value.target) &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.view === 'string' &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function validError(value: unknown): value is DropViewError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    DROP_VIEW_ERROR_CODES.includes(value.code as (typeof DROP_VIEW_ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function validOutput(value: unknown): value is DropViewResult | DropViewError {
  return validResult(value) || validError(value);
}

export function dropViewOutputJsonSchema(): Record<string, unknown> {
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'warnings'],
    properties: {
      operation: { const: 'drop_view' },
      operationId: { type: 'string', minLength: 1 },
      warnings: { type: 'integer', minimum: 0 },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['schema', 'view'],
        properties: { schema: { type: 'string' }, view: { type: 'string' } },
      },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: { code: { enum: DROP_VIEW_ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [result, error] };
}

const inputSchema: StandardSchemaWithJSON<DropViewInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for drop_view.' }] };
    },
    jsonSchema: { input: () => dropViewInputJsonSchema(), output: () => dropViewInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<DropViewResult | DropViewError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'drop_view result is invalid.' }] };
    },
    jsonSchema: { input: dropViewOutputJsonSchema, output: dropViewOutputJsonSchema },
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

/** Registers the explicit, dependency-aware DROP VIEW operation. */
export function registerDropViewTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'drop_view',
    {
      title: 'Drop one bounded MySQL view',
      description:
        'Drops one explicitly confirmed view after metadata and known-dependency preflight and post-execution verification. The operation is destructive, audited, requires DDL opt-in, and is never retried automatically.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeDropViewInput(input);
        await validateDropViewMetadata(mysql, normalized.schema, normalized.view);
        const [result, operationId] = await mysql.ddl.executeDropViewWithOperationId(createDropViewStatement(normalized), async () => {
          try {
            await verifyDropViewMetadata(mysql, normalized.schema, normalized.view);
          } catch {
            throw new DdlResultError();
          }
        });
        const response: DropViewResult = Object.freeze({
          operation: 'drop_view',
          operationId,
          target: Object.freeze({ schema: normalized.schema, view: normalized.view }),
          warnings: result.warningStatus,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
