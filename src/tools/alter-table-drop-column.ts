import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateAlterTableDropColumnMetadata, verifyAlterTableDropColumnMetadata } from '../db/metadata.js';
import { createAlterTableDropColumnStatement, DdlResultError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  alterTableDropColumnInputJsonSchema,
  normalizeAlterTableDropColumnInput,
  type AlterTableDropColumnInput,
} from './alter-table-drop-column-input.js';

type AlterTableDropColumnResult = Readonly<{
  operation: 'alter_table_drop_column';
  operationId: string;
  target: Readonly<{ schema: string; table: string; column: string }>;
  warnings: number;
}>;
type AlterTableDropColumnError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const ERROR_CODES = [
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

function validInput(value: unknown): value is AlterTableDropColumnInput {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.column === 'string' &&
    typeof value.reason === 'string' &&
    value.confirmation === 'DROP_COLUMN'
  );
}

function validResult(value: unknown): value is AlterTableDropColumnResult {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    value.operation === 'alter_table_drop_column' &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    record(value.target) &&
    Object.keys(value.target).length === 3 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    typeof value.target.column === 'string' &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function validError(value: unknown): value is AlterTableDropColumnError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    ERROR_CODES.includes(value.code as (typeof ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function validOutput(value: unknown): value is AlterTableDropColumnResult | AlterTableDropColumnError {
  return validResult(value) || validError(value);
}

function outputJsonSchema(): Record<string, unknown> {
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'warnings'],
    properties: {
      operation: { const: 'alter_table_drop_column' },
      operationId: { type: 'string', minLength: 1 },
      warnings: { type: 'integer', minimum: 0 },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['schema', 'table', 'column'],
        properties: { schema: { type: 'string' }, table: { type: 'string' }, column: { type: 'string' } },
      },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: { code: { enum: ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [result, error] };
}

const inputSchema: StandardSchemaWithJSON<AlterTableDropColumnInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for alter_table_drop_column.' }] };
    },
    jsonSchema: { input: () => alterTableDropColumnInputJsonSchema(), output: () => alterTableDropColumnInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<AlterTableDropColumnResult | AlterTableDropColumnError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'alter_table_drop_column result is invalid.' }] };
    },
    jsonSchema: { input: outputJsonSchema, output: outputJsonSchema },
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

/** Registers the explicit, dependency-aware DROP COLUMN operation. */
export function registerAlterTableDropColumnTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'alter_table_drop_column',
    {
      title: 'Drop one controlled MySQL column',
      description:
        'Drops one explicitly confirmed column only after fail-closed dependency preflight and post-execution verification. The operation is destructive, audited, requires separate DDL opt-in, and is never retried automatically.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeAlterTableDropColumnInput(input);
        await validateAlterTableDropColumnMetadata(mysql, normalized);
        const [result, operationId] = await mysql.ddl.executeAlterTableDropColumnWithOperationId(
          createAlterTableDropColumnStatement(normalized),
          async () => {
            try {
              await verifyAlterTableDropColumnMetadata(mysql, normalized);
            } catch {
              throw new DdlResultError();
            }
          },
        );
        const response: AlterTableDropColumnResult = Object.freeze({
          operation: 'alter_table_drop_column',
          operationId,
          target: Object.freeze({ schema: normalized.schema, table: normalized.table, column: normalized.column }),
          warnings: result.warningStatus,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
