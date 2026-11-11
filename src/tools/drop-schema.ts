import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { inspectDropSchemaMetadata, type DropSchemaImpact } from '../db/metadata.js';
import { createDropSchemaStatement, DropSchemaPolicyError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { dropSchemaInputJsonSchema, normalizeDropSchemaInput, type DropSchemaInput } from './drop-schema-input.js';

type DropSchemaPreflightResult = Readonly<{
  operation: 'drop_schema_preflight';
  target: Readonly<{ schema: string }>;
  impact: DropSchemaImpact;
  metadataRevision: string;
  confirmation: string;
}>;
type DropSchemaResult = Readonly<{
  operation: 'drop_schema';
  operationId: string;
  target: Readonly<{ schema: string }>;
  warnings: number;
}>;
type DropSchemaError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;

const DROP_SCHEMA_ERROR_CODES = [
  'MYSQL_DDL_INVALID_ARGUMENT',
  'MYSQL_DDL_DISABLED',
  'MYSQL_DDL_FAILED',
  'MYSQL_DDL_OUTCOME_UNKNOWN',
  'MYSQL_DDL_PERMISSION_DENIED',
  'MYSQL_DDL_SCHEMA_NOT_ALLOWED',
  'MYSQL_DDL_SCHEMA_INVALID',
  'MYSQL_DDL_LOCK_TIMEOUT',
  'MYSQL_DDL_DEADLOCK',
  'MYSQL_DDL_STRUCTURE_INVALID',
  'MYSQL_DDL_METADATA_INVALID',
] as const;

const dropSchemaExecutionLocks = new Map<string, Promise<void>>();

async function withDropSchemaExecutionLock<T>(schema: string, operation: () => Promise<T>): Promise<T> {
  const previous = dropSchemaExecutionLocks.get(schema) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  dropSchemaExecutionLocks.set(schema, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (dropSchemaExecutionLocks.get(schema) === queued) dropSchemaExecutionLocks.delete(schema);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is DropSchemaInput {
  return (
    record(value) &&
    (Object.keys(value).length === 2 || Object.keys(value).length === 3) &&
    typeof value.schema === 'string' &&
    typeof value.reason === 'string' &&
    (value.confirmation === undefined || typeof value.confirmation === 'string')
  );
}

function validImpactGroup(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    Array.isArray(value.names) &&
    value.names.length === value.count &&
    value.names.every((name) => typeof name === 'string')
  );
}

function validImpact(value: unknown): value is DropSchemaImpact {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    validImpactGroup(value.tables) &&
    validImpactGroup(value.views) &&
    validImpactGroup(value.otherObjects)
  );
}

function validPreflight(value: unknown): value is DropSchemaPreflightResult {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    value.operation === 'drop_schema_preflight' &&
    record(value.target) &&
    Object.keys(value.target).length === 1 &&
    typeof value.target.schema === 'string' &&
    validImpact(value.impact) &&
    typeof value.metadataRevision === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.metadataRevision) &&
    typeof value.confirmation === 'string' &&
    value.confirmation === `DROP_SCHEMA:${value.metadataRevision}`
  );
}

function validResult(value: unknown): value is DropSchemaResult {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    value.operation === 'drop_schema' &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    record(value.target) &&
    Object.keys(value.target).length === 1 &&
    typeof value.target.schema === 'string' &&
    typeof value.warnings === 'number' &&
    Number.isSafeInteger(value.warnings) &&
    value.warnings >= 0
  );
}

function validError(value: unknown): value is DropSchemaError {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    DROP_SCHEMA_ERROR_CODES.includes(value.code as (typeof DROP_SCHEMA_ERROR_CODES)[number]) &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function validOutput(value: unknown): value is DropSchemaPreflightResult | DropSchemaResult | DropSchemaError {
  return validPreflight(value) || validResult(value) || validError(value);
}

export function dropSchemaOutputJsonSchema(): Record<string, unknown> {
  const impactGroup = {
    type: 'object',
    additionalProperties: false,
    required: ['count', 'names'],
    properties: { count: { type: 'integer', minimum: 0 }, names: { type: 'array', items: { type: 'string' } } },
  };
  const impact = {
    type: 'object',
    additionalProperties: false,
    required: ['tables', 'views', 'otherObjects'],
    properties: { tables: impactGroup, views: impactGroup, otherObjects: impactGroup },
  };
  const preflight = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'target', 'impact', 'metadataRevision', 'confirmation'],
    properties: {
      operation: { const: 'drop_schema_preflight' },
      target: { type: 'object', additionalProperties: false, required: ['schema'], properties: { schema: { type: 'string' } } },
      impact,
      metadataRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      confirmation: { type: 'string', pattern: '^DROP_SCHEMA:[0-9a-f]{64}$' },
    },
  };
  const result = {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'operationId', 'target', 'warnings'],
    properties: {
      operation: { const: 'drop_schema' },
      operationId: { type: 'string', minLength: 1 },
      target: { type: 'object', additionalProperties: false, required: ['schema'], properties: { schema: { type: 'string' } } },
      warnings: { type: 'integer', minimum: 0 },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: { code: { enum: DROP_SCHEMA_ERROR_CODES }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
  };
  return { anyOf: [preflight, result, error] };
}

const inputSchema: StandardSchemaWithJSON<DropSchemaInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for drop_schema.' }] };
    },
    jsonSchema: { input: () => dropSchemaInputJsonSchema(), output: () => dropSchemaInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<DropSchemaPreflightResult | DropSchemaResult | DropSchemaError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'drop_schema result is invalid.' }] };
    },
    jsonSchema: { input: dropSchemaOutputJsonSchema, output: dropSchemaOutputJsonSchema },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

/** Registers the explicitly allowlisted, target-bound DROP SCHEMA operation. */
export function registerDropSchemaTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'drop_schema',
    {
      title: 'Drop one explicitly allowlisted MySQL schema',
      description:
        'Preflights one explicitly allowlisted schema and returns bounded impact metadata; a matching target-bound confirmation is required before the irreversible, audited DROP SCHEMA operation. No automatic retry is performed.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeDropSchemaInput(input);
        if (!mysql.dropSchemaAllowlist.includes(normalized.schema)) throw new DropSchemaPolicyError();
        return await withDropSchemaExecutionLock(normalized.schema, async () => {
          if (normalized.confirmation === undefined) {
            const preflight = await inspectDropSchemaMetadata(mysql, normalized.schema);
            const response: DropSchemaPreflightResult = Object.freeze({
              operation: 'drop_schema_preflight',
              target: Object.freeze({ schema: normalized.schema }),
              impact: preflight.impact,
              metadataRevision: preflight.metadataRevision,
              confirmation: preflight.confirmation,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
          }

          const [result, operationId] = await mysql.ddl.executeDropSchemaWithOperationId(createDropSchemaStatement(normalized));
          const response: DropSchemaResult = Object.freeze({
            operation: 'drop_schema',
            operationId,
            target: Object.freeze({ schema: normalized.schema }),
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
