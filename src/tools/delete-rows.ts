import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { ResultSetHeader } from 'mysql2';

import { toSafeDmlOutcome } from '../db/dml-audit.js';
import { MAX_DML_FILTER_IN_VALUES, MAX_DML_FILTERS, MAX_DML_LIMIT, normalizeDmlFilters, type DmlFilter } from '../db/dml-builder.js';
import { validateDmlMetadata } from '../db/metadata.js';
import { createAuditedDmlStatement, type ConnectionLayerBundle, type DmlStatement, wasDmlSubmitted } from '../db/pool.js';

import {
  assertDmlPayloadSize,
  DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  DML_NON_NULL_SCALAR_JSON_SCHEMA,
  DmlInputValidationError,
  MAX_DML_IDENTIFIER_LENGTH,
  MAX_DML_PARAMETERS,
  MAX_DML_PAYLOAD_BYTES,
  MAX_DML_REASON_LENGTH,
  normalizeDmlTarget,
  type DmlTarget,
} from './dml-input.js';

type DeleteRowsInput = Readonly<{ schema: string; table: string; filters: readonly DmlFilter[]; limit: number; reason: string }>;
type NormalizedDeleteRowsInput = Readonly<{ target: DmlTarget; filters: readonly DmlFilter[]; limit: number }>;
type DeleteRowsResult = Readonly<{
  operation: 'delete';
  operationId: string;
  target: Readonly<{ schema: string; table: string }>;
  affectedRows: number;
  warningCount: number;
}>;
type DeleteRowsError = Readonly<{ code: string; message: string; retryAdvice?: string }>;

const filterJsonSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['column', 'operator', 'value'],
      properties: {
        column: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
        operator: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] },
        value: DML_NON_NULL_SCALAR_JSON_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['column', 'operator', 'values'],
      properties: {
        column: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
        operator: { const: 'in' },
        values: { type: 'array', minItems: 1, maxItems: MAX_DML_FILTER_IN_VALUES, items: DML_NON_NULL_SCALAR_JSON_SCHEMA },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['column', 'operator'],
      properties: {
        column: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
        operator: { enum: ['is_null', 'is_not_null'] },
      },
    },
  ],
};

const deleteRowsInputSchema: StandardSchemaWithJSON<DeleteRowsInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isRecord(value) || Object.keys(value).length !== 5) return { issues: [{ message: 'Invalid arguments for delete_rows.' }] };
      return { value: value as DeleteRowsInput };
    },
    jsonSchema: { input: () => deleteRowsInputJsonSchema(), output: () => deleteRowsInputJsonSchema() },
  },
};
const deleteRowsOutputSchema: StandardSchemaWithJSON<DeleteRowsResult | DeleteRowsError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isRecord(value)) return { issues: [{ message: 'delete_rows result is invalid.' }] };
      return { value: value as DeleteRowsResult | DeleteRowsError };
    },
    jsonSchema: { input: () => deleteRowsOutputJsonSchema(), output: () => deleteRowsOutputJsonSchema() },
  },
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deleteRowsInputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: `Deletes at most ${MAX_DML_LIMIT} selected rows from one validated base table.`,
    'x-maxParameters': MAX_DML_PARAMETERS,
    'x-maxPayloadBytes': MAX_DML_PAYLOAD_BYTES,
    additionalProperties: false,
    required: ['schema', 'table', 'filters', 'limit', 'reason'],
    properties: {
      schema: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
      table: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
      filters: { type: 'array', minItems: 1, maxItems: MAX_DML_FILTERS, items: filterJsonSchema },
      limit: { type: 'integer', minimum: 1, maximum: MAX_DML_LIMIT },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_DML_REASON_LENGTH,
        pattern: `^(?=.*\\S)${DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
  };
}
function deleteRowsOutputJsonSchema(): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'operationId', 'target', 'affectedRows', 'warningCount'],
        properties: {
          operation: { const: 'delete' },
          operationId: { type: 'string', minLength: 1 },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['schema', 'table'],
            properties: { schema: { type: 'string' }, table: { type: 'string' } },
          },
          affectedRows: { type: 'integer', minimum: 0, maximum: MAX_DML_LIMIT },
          warningCount: { type: 'integer', minimum: 0 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' }, retryAdvice: { enum: ['VERIFY_STATE_BEFORE_RETRYING'] } },
      },
    ],
  };
}
function normalizeInput(value: unknown): NormalizedDeleteRowsInput {
  assertDmlPayloadSize(value, 'input');
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    Object.keys(value).some((key) => !['schema', 'table', 'filters', 'limit', 'reason'].includes(key))
  )
    throw new DmlInputValidationError('invalid_value', 'input');
  const snapshot = structuredClone(value) as Record<string, unknown>;
  const target = normalizeDmlTarget({ schema: snapshot.schema, table: snapshot.table, reason: snapshot.reason }, 'input');
  const filters = normalizeDmlFilters(snapshot.filters);
  const limit = snapshot.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DML_LIMIT)
    throw new DmlInputValidationError('invalid_value', 'input');
  return { target, filters, limit };
}
function errorResult(error: unknown) {
  const outcome = toSafeDmlOutcome(error, wasDmlSubmitted(error));
  const structuredContent =
    outcome.retryAdvice === undefined
      ? { code: outcome.code, message: outcome.message }
      : { code: outcome.code, message: outcome.message, retryAdvice: outcome.retryAdvice };
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerDeleteRowsTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'delete_rows',
    {
      title: 'Delete selected rows from a MySQL table',
      description: `Deletes bounded selected rows from one validated MySQL base table using one prepared statement. The operation is destructive, non-idempotent, audited, and requires DML opt-in; cascades remain the schema's responsibility.`,
      inputSchema: deleteRowsInputSchema,
      outputSchema: deleteRowsOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeInput(input);
        const metadata = await validateDmlMetadata(mysql, normalized.target.schema, normalized.target.table, [], { operation: 'delete' });
        const statementInput = {
          target: normalized.target,
          filters: normalized.filters,
          limit: normalized.limit,
          columns: metadata.columns.map(({ columnName }) => columnName),
          primaryKey: metadata.primaryKey,
        };
        const statement: DmlStatement = createAuditedDmlStatement('delete', statementInput);
        const [result, , operationId] = await mysql.dml.executeDmlWithOperationId<ResultSetHeader>(statement);
        const response: DeleteRowsResult = {
          operation: 'delete',
          operationId,
          target: { schema: normalized.target.schema, table: normalized.target.table },
          affectedRows: result.affectedRows,
          warningCount: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
