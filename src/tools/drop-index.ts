import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateDropIndexMetadata, verifyDropIndexMetadata } from '../db/metadata.js';
import { createDropIndexStatement, DdlResultError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { dropIndexInputJsonSchema, normalizeDropIndexInput, type DropIndexInput } from './drop-index-input.js';

type DropIndexResult = Readonly<{
  operation: 'drop_index';
  operationId: string;
  target: Readonly<{ schema: string; table: string; index: string }>;
  warnings: number;
}>;
type DropIndexError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is DropIndexInput {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.index === 'string' &&
    typeof value.reason === 'string'
  );
}

function validOutput(value: unknown): value is DropIndexResult | DropIndexError {
  return (
    record(value) &&
    ((value.operation === 'drop_index' && typeof value.operationId === 'string' && record(value.target) && typeof value.warnings === 'number') ||
      (typeof value.code === 'string' && typeof value.message === 'string'))
  );
}

const inputSchema: StandardSchemaWithJSON<DropIndexInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for drop_index.' }] };
    },
    jsonSchema: { input: dropIndexInputJsonSchema, output: dropIndexInputJsonSchema },
  },
};
const outputSchema: StandardSchemaWithJSON<DropIndexResult | DropIndexError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'drop_index result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerDropIndexTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'drop_index',
    {
      title: 'Drop one bounded MySQL secondary index',
      description:
        'Drops one explicitly named removable secondary non-unique B-tree index after metadata preflight and post-execution verification. The operation is destructive, audited, requires DDL opt-in, and is never retried automatically.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeDropIndexInput(input);
        await validateDropIndexMetadata(mysql, normalized.schema, normalized.table, normalized.index);
        const [result, operationId] = await mysql.ddl.executeDropIndexWithOperationId(createDropIndexStatement(normalized), async () => {
          try {
            await verifyDropIndexMetadata(mysql, normalized.schema, normalized.table, normalized.index);
          } catch {
            throw new DdlResultError();
          }
        });
        const response: DropIndexResult = {
          operation: 'drop_index',
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
