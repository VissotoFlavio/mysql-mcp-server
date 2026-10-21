import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { ResultSetHeader } from 'mysql2';

import { toSafeDmlOutcome } from '../db/dml-audit.js';
import { MAX_DML_FILTER_IN_VALUES, MAX_DML_FILTERS, MAX_DML_LIMIT, normalizeDmlFilters, type DmlFilter } from '../db/dml-builder.js';
import { DmlMetadataError, validateDmlMetadata } from '../db/metadata.js';
import { createAuditedDmlStatement, type ConnectionLayerBundle, type DmlStatement, wasDmlSubmitted } from '../db/pool.js';

import {
  assertDmlPayloadSize,
  DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  DML_SCALAR_JSON_SCHEMA,
  DmlInputValidationError,
  MAX_DML_COLUMNS,
  MAX_DML_IDENTIFIER_LENGTH,
  MAX_DML_PARAMETERS,
  MAX_DML_PAYLOAD_BYTES,
  MAX_DML_REASON_LENGTH,
  normalizeDmlRow,
  normalizeDmlTarget,
  type DmlScalar,
  type DmlRow,
  type DmlTarget,
} from './dml-input.js';

type UpdateRowsInput = Readonly<{
  schema: string;
  table: string;
  values: Readonly<Record<string, DmlScalar>>;
  filters: readonly DmlFilter[];
  limit: number;
  reason: string;
}>;

type NormalizedUpdateRowsInput = Readonly<{
  target: DmlTarget;
  values: DmlRow;
  filters: readonly DmlFilter[];
  limit: number;
}>;

type UpdateRowsResult = Readonly<{
  operation: 'update';
  operationId: string;
  target: Readonly<{ schema: string; table: string }>;
  matchedRows: number;
  affectedRows: number;
  changedRows: number;
  warningCount: number;
}>;

type UpdateRowsError = Readonly<{
  code: string;
  message: string;
  retryAdvice?: string;
}>;

const filterJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['column', 'operator'],
  properties: {
    column: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
    operator: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'is_not_null'] },
    value: DML_SCALAR_JSON_SCHEMA,
    values: { type: 'array', minItems: 1, maxItems: MAX_DML_FILTER_IN_VALUES, items: DML_SCALAR_JSON_SCHEMA },
  },
};

const updateRowsInputSchema: StandardSchemaWithJSON<UpdateRowsInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isRecord(value) || Object.keys(value).length !== 6) return { issues: [{ message: 'Invalid arguments for update_rows.' }] };
      return { value: value as UpdateRowsInput };
    },
    jsonSchema: {
      input: () => updateRowsInputJsonSchema(),
      output: () => updateRowsInputJsonSchema(),
    },
  },
};

const updateRowsOutputSchema: StandardSchemaWithJSON<UpdateRowsResult | UpdateRowsError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isUpdateRowsResult(value) && !isUpdateRowsError(value)) return { issues: [{ message: 'update_rows result is invalid.' }] };
      return { value };
    },
    jsonSchema: {
      input: () => updateRowsOutputJsonSchema(),
      output: () => updateRowsOutputJsonSchema(),
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function updateRowsInputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: `Updates selected rows in one validated base table with ${MAX_DML_PARAMETERS} prepared-parameter and ${MAX_DML_PAYLOAD_BYTES}-byte payload limits.`,
    'x-maxParameters': MAX_DML_PARAMETERS,
    'x-maxPayloadBytes': MAX_DML_PAYLOAD_BYTES,
    additionalProperties: false,
    required: ['schema', 'table', 'values', 'filters', 'limit', 'reason'],
    properties: {
      schema: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
      table: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
      values: {
        type: 'object',
        minProperties: 1,
        maxProperties: MAX_DML_COLUMNS,
        propertyNames: { type: 'string', minLength: 1, maxLength: MAX_DML_IDENTIFIER_LENGTH, pattern: DML_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN },
        additionalProperties: DML_SCALAR_JSON_SCHEMA,
      },
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

function updateRowsOutputJsonSchema(): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'operationId', 'target', 'matchedRows', 'affectedRows', 'changedRows', 'warningCount'],
        properties: {
          operation: { const: 'update' },
          operationId: { type: 'string', minLength: 1 },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['schema', 'table'],
            properties: { schema: { type: 'string' }, table: { type: 'string' } },
          },
          matchedRows: { type: 'integer', minimum: 0, maximum: MAX_DML_LIMIT },
          affectedRows: { type: 'integer', minimum: 0, maximum: MAX_DML_LIMIT },
          changedRows: { type: 'integer', minimum: 0, maximum: MAX_DML_LIMIT },
          warningCount: { type: 'integer', minimum: 0 },
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

function isUpdateRowsResult(value: unknown): value is UpdateRowsResult {
  if (!isRecord(value) || !isRecord(value.target) || Object.keys(value).length !== 7) return false;
  return (
    value.operation === 'update' &&
    typeof value.operationId === 'string' &&
    Object.keys(value.target).length === 2 &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    ['matchedRows', 'affectedRows', 'changedRows', 'warningCount'].every(
      (key) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0,
    )
  );
}

function isUpdateRowsError(value: unknown): value is UpdateRowsError {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 2 || (keys.length === 3 && keys.includes('retryAdvice'))) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.retryAdvice === undefined || value.retryAdvice === 'VERIFY_STATE_BEFORE_RETRYING')
  );
}

function invalidUpdateInput(): never {
  throw new DmlInputValidationError('invalid_value', 'input');
}

function normalizeInput(value: unknown): NormalizedUpdateRowsInput {
  assertDmlPayloadSize(value, 'input');
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    Object.keys(value).some((key) => !['schema', 'table', 'values', 'filters', 'limit', 'reason'].includes(key))
  )
    invalidUpdateInput();
  const snapshot = structuredClone(value) as Record<string, unknown>;
  const target = normalizeDmlTarget({ schema: snapshot.schema, table: snapshot.table, reason: snapshot.reason }, 'input');
  const values = normalizeDmlRow(snapshot.values, 'input');
  const filters = normalizeDmlFilters(snapshot.filters, undefined, Object.keys(values).length);
  const limit = snapshot.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DML_LIMIT) invalidUpdateInput();
  return { target, values, filters, limit };
}

function errorResult(error: unknown) {
  const outcome = toSafeDmlOutcome(error, wasDmlSubmitted(error));
  const structuredContent =
    outcome.retryAdvice === undefined
      ? { code: outcome.code, message: outcome.message }
      : { code: outcome.code, message: outcome.message, retryAdvice: outcome.retryAdvice };
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerUpdateRowsTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'update_rows',
    {
      title: 'Update selected rows in a MySQL table',
      description:
        'Updates bounded selected rows in one validated MySQL base table using one prepared statement. The operation is audited and requires DML opt-in.',
      inputSchema: updateRowsInputSchema,
      outputSchema: updateRowsOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeInput(input);
        const metadata = await validateDmlMetadata(mysql, normalized.target.schema, normalized.target.table, Object.keys(normalized.values), {
          operation: 'update',
        });
        if (Object.keys(normalized.values).some((column) => metadata.primaryKey.includes(column))) {
          throw new DmlMetadataError('Primary-key columns cannot be updated.');
        }
        const statementInput = {
          target: normalized.target,
          values: normalized.values,
          filters: normalized.filters,
          limit: normalized.limit,
          columns: metadata.columns.map(({ columnName }) => columnName),
          primaryKey: metadata.primaryKey,
        };
        const statement: DmlStatement = createAuditedDmlStatement('update', statementInput);
        const [result, , operationId] = await mysql.dml.executeDmlWithOperationId<ResultSetHeader>(statement);
        const matchedRows = result.affectedRows;
        const changedRows = result.changedRows;
        const warningCount = result.warningStatus;
        const response: UpdateRowsResult = {
          operation: 'update',
          operationId,
          target: { schema: normalized.target.schema, table: normalized.target.table },
          matchedRows,
          affectedRows: matchedRows,
          changedRows,
          warningCount,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
