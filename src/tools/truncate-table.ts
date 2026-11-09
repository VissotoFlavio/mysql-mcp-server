import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import {
  consumeTruncateTableMetadataAttestation,
  TruncateTableMetadataError,
  validateTruncateTableMetadata,
  verifyTruncateTableMetadata,
} from '../db/metadata.js';
import { createTruncateTableStatement, DdlResultError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  normalizeTruncateTableInput,
  truncateTableInputJsonSchema,
  truncateTableMetadataRevision,
  type TruncateTableInput,
} from './truncate-table-input.js';

const TRUNCATE_TABLE_EFFECTS = Object.freeze(['AUTO_INCREMENT_RESET', 'IMPLICIT_COMMIT_NO_ROLLBACK', 'METADATA_LOCKS'] as const);
type TruncateTableEffect = (typeof TRUNCATE_TABLE_EFFECTS)[number];
type TruncateTableResult = Readonly<{
  operation: 'truncate_table';
  operationId: string;
  target: Readonly<{ schema: string; table: string }>;
  warnings: number;
  effects: readonly TruncateTableEffect[];
}>;
type TruncateTableError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const TRUNCATE_TABLE_ERROR_CODES = [
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
const truncateTableExecutionLocks = new Map<string, Promise<void>>();

async function withTruncateTableExecutionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = truncateTableExecutionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  truncateTableExecutionLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (truncateTableExecutionLocks.get(key) === queued) truncateTableExecutionLocks.delete(key);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is TruncateTableInput {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.confirmation === 'string' &&
    /^TRUNCATE_TABLE:[0-9a-f]{64}$/u.test(value.confirmation)
  );
}

function validResult(value: unknown): value is TruncateTableResult {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    value.operation === 'truncate_table' &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    record(value.target) &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0 &&
    Array.isArray(value.effects) &&
    value.effects.length === TRUNCATE_TABLE_EFFECTS.length &&
    value.effects.every((effect, index) => effect === TRUNCATE_TABLE_EFFECTS[index])
  );
}

function validError(value: unknown): value is TruncateTableError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    TRUNCATE_TABLE_ERROR_CODES.includes(value.code as (typeof TRUNCATE_TABLE_ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function validOutput(value: unknown): value is TruncateTableResult | TruncateTableError {
  return validResult(value) || validError(value);
}

export function truncateTableOutputJsonSchema(): Record<string, unknown> {
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'warnings', 'effects'],
    properties: {
      operation: { const: 'truncate_table' },
      operationId: { type: 'string', minLength: 1 },
      warnings: { type: 'integer', minimum: 0 },
      effects: {
        type: 'array',
        minItems: TRUNCATE_TABLE_EFFECTS.length,
        maxItems: TRUNCATE_TABLE_EFFECTS.length,
        items: { enum: TRUNCATE_TABLE_EFFECTS },
      },
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
    properties: { code: { enum: TRUNCATE_TABLE_ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [result, error] };
}

const inputSchema: StandardSchemaWithJSON<TruncateTableInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for truncate_table.' }] };
    },
    jsonSchema: { input: truncateTableInputJsonSchema, output: truncateTableInputJsonSchema },
  },
};
const outputSchema: StandardSchemaWithJSON<TruncateTableResult | TruncateTableError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'truncate_table result is invalid.' }] };
    },
    jsonSchema: { input: truncateTableOutputJsonSchema, output: truncateTableOutputJsonSchema },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

/** Registers the explicit, foreign-key-aware TRUNCATE TABLE operation. */
export function registerTruncateTableTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'truncate_table',
    {
      title: 'Truncate one bounded MySQL table',
      description:
        'Truncates one explicitly confirmed base table after a target-bound metadata revision and foreign-key preflight. The operation resets AUTO_INCREMENT, commits implicitly without rollback, acquires metadata locks, is destructive and audited, requires separate DDL opt-in, and is never retried automatically.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeTruncateTableInput(input);
        return await withTruncateTableExecutionLock(`${normalized.schema}\u0000${normalized.table}`, async () => {
          if (!mysql.truncateTableMetadataComplete)
            throw new TruncateTableMetadataError(
              'MYSQL_DDL_METADATA_INVALID',
              'TRUNCATE TABLE metadata visibility must be explicitly confirmed by the operator.',
            );
          let expectedShapeFingerprint: string | undefined;
          const [result, operationId] = await mysql.ddl.executeTruncateTableWithOperationId(
            createTruncateTableStatement(normalized),
            async () => {
              try {
                if (expectedShapeFingerprint === undefined) throw new DdlResultError();
                await verifyTruncateTableMetadata(mysql, normalized.schema, normalized.table, expectedShapeFingerprint);
              } catch {
                throw new DdlResultError();
              }
            },
            async (connection) => {
              const metadata = await validateTruncateTableMetadata(connection, normalized);
              if (truncateTableMetadataRevision(normalized.confirmation) !== metadata.metadataRevision)
                throw new TruncateTableMetadataError(
                  'MYSQL_DDL_METADATA_INVALID',
                  'The TRUNCATE TABLE confirmation is stale for the current metadata.',
                );
              expectedShapeFingerprint = metadata.shapeFingerprint;
              consumeTruncateTableMetadataAttestation(normalized.schema, normalized.table, metadata.metadataRevision);
            },
          );
          const response: TruncateTableResult = Object.freeze({
            operation: 'truncate_table',
            operationId,
            target: Object.freeze({ schema: normalized.schema, table: normalized.table }),
            warnings: result.warningStatus,
            effects: TRUNCATE_TABLE_EFFECTS,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
