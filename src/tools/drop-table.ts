import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { consumeDropTableMetadataAttestation, DropTableMetadataError, validateDropTableMetadata, verifyDropTableMetadata } from '../db/metadata.js';
import { createDropTableStatement, DdlResultError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { dropTableInputJsonSchema, dropTableMetadataRevision, normalizeDropTableInput, type DropTableInput } from './drop-table-input.js';

type DropTableResult = Readonly<{
  operation: 'drop_table';
  operationId: string;
  target: Readonly<{ schema: string; table: string }>;
  warnings: number;
}>;
type DropTableError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const DROP_TABLE_ERROR_CODES = [
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
const dropTableExecutionLocks = new Map<string, Promise<void>>();

async function withDropTableExecutionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = dropTableExecutionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  dropTableExecutionLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (dropTableExecutionLocks.get(key) === queued) dropTableExecutionLocks.delete(key);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is DropTableInput {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.confirmation === 'string' &&
    /^DROP_TABLE:[0-9a-f]{64}$/u.test(value.confirmation)
  );
}

function validResult(value: unknown): value is DropTableResult {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    value.operation === 'drop_table' &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    record(value.target) &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function validError(value: unknown): value is DropTableError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    DROP_TABLE_ERROR_CODES.includes(value.code as (typeof DROP_TABLE_ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function validOutput(value: unknown): value is DropTableResult | DropTableError {
  return validResult(value) || validError(value);
}

export function dropTableOutputJsonSchema(): Record<string, unknown> {
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'warnings'],
    properties: {
      operation: { const: 'drop_table' },
      operationId: { type: 'string', minLength: 1 },
      warnings: { type: 'integer', minimum: 0 },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['schema', 'table'],
        properties: { schema: { type: 'string' }, table: { type: 'string' } },
      },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: { code: { enum: DROP_TABLE_ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [result, error] };
}

const inputSchema: StandardSchemaWithJSON<DropTableInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for drop_table.' }] };
    },
    jsonSchema: { input: () => dropTableInputJsonSchema(), output: () => dropTableInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<DropTableResult | DropTableError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'drop_table result is invalid.' }] };
    },
    jsonSchema: { input: dropTableOutputJsonSchema, output: dropTableOutputJsonSchema },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

/** Registers the explicit, dependency-aware DROP TABLE operation. */
export function registerDropTableTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'drop_table',
    {
      title: 'Drop one bounded MySQL table',
      description:
        'Drops one explicitly confirmed base table after a target-bound metadata revision and dependency preflight. The operation is irreversible, destructive, audited, requires separate DDL opt-in, and is never retried automatically.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeDropTableInput(input);
        return await withDropTableExecutionLock(`${normalized.schema}\u0000${normalized.table}`, async () => {
          if (!mysql.dropTableMetadataComplete)
            throw new DropTableMetadataError(
              'MYSQL_DDL_METADATA_INVALID',
              'DROP TABLE metadata visibility must be explicitly confirmed by the operator.',
            );
          const [result, operationId] = await mysql.ddl.executeDropTableWithOperationId(
            createDropTableStatement(normalized),
            async () => {
              try {
                await verifyDropTableMetadata(mysql, normalized.schema, normalized.table);
              } catch {
                throw new DdlResultError();
              }
            },
            async (connection) => {
              const metadata = await validateDropTableMetadata(connection, normalized);
              if (dropTableMetadataRevision(normalized.confirmation) !== metadata.metadataRevision)
                throw new DropTableMetadataError('MYSQL_DDL_METADATA_INVALID', 'The DROP TABLE confirmation is stale for the current metadata.');
              consumeDropTableMetadataAttestation(normalized.schema, normalized.table, metadata.metadataRevision);
            },
          );
          const response: DropTableResult = Object.freeze({
            operation: 'drop_table',
            operationId,
            target: Object.freeze({ schema: normalized.schema, table: normalized.table }),
            warnings: result.warningStatus,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
