import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateCreateIndexMetadata } from '../db/metadata.js';
import { createCreateIndexStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { createIndexInputJsonSchema, normalizeCreateIndexInput, type CreateIndexInput } from './create-index-input.js';

type CreateIndexResult = Readonly<{
  operation: 'create_index';
  operationId: string;
  target: Readonly<{ schema: string; table: string; index: string }>;
  warnings: number;
}>;
type CreateIndexError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validInput(value: unknown): value is CreateIndexInput {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.index === 'string' &&
    Array.isArray(value.columns) &&
    typeof value.reason === 'string'
  );
}
function validOutput(value: unknown): value is CreateIndexResult | CreateIndexError {
  return (
    record(value) &&
    ((value.operation === 'create_index' && typeof value.operationId === 'string' && record(value.target) && typeof value.warnings === 'number') ||
      (typeof value.code === 'string' && typeof value.message === 'string'))
  );
}

const inputSchema: StandardSchemaWithJSON<CreateIndexInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for create_index.' }] };
    },
    jsonSchema: { input: () => createIndexInputJsonSchema(), output: () => createIndexInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<CreateIndexResult | CreateIndexError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'create_index result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};
function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerCreateIndexTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'create_index',
    {
      title: 'Create a bounded MySQL index',
      description: 'Creates one validated non-unique B-tree index. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeCreateIndexInput(input);
        await validateCreateIndexMetadata(mysql, normalized.schema, normalized.table, normalized.index, normalized.columns);
        const [result, operationId] = await mysql.ddl.executeCreateIndexWithOperationId(createCreateIndexStatement(normalized));
        const response: CreateIndexResult = {
          operation: 'create_index',
          operationId,
          target: { schema: normalized.schema, table: normalized.table, index: normalized.index },
          warnings: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
