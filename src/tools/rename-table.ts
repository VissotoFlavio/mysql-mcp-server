import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateRenameTableMetadata } from '../db/metadata.js';
import { createRenameTableStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import { normalizeRenameTableInput, renameTableInputJsonSchema, type RenameTableInput } from './rename-table-input.js';

type Result = Readonly<{
  operation: 'rename_table';
  operationId: string;
  target: Readonly<{ schema: string; table: string; newTable: string }>;
  warnings: number;
}>;
type ErrorResult = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const inputSchema: StandardSchemaWithJSON<RenameTableInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value) {
      return record(value) &&
        Object.keys(value).length === 4 &&
        typeof value.schema === 'string' &&
        typeof value.table === 'string' &&
        typeof value.newTable === 'string' &&
        typeof value.reason === 'string'
        ? { value: value as RenameTableInput }
        : { issues: [{ message: 'Invalid arguments for rename_table.' }] };
    },
    jsonSchema: { input: renameTableInputJsonSchema, output: renameTableInputJsonSchema },
  },
};
const outputSchema: StandardSchemaWithJSON<Result | ErrorResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value) {
      return record(value) &&
        ((value.operation === 'rename_table' &&
          typeof value.operationId === 'string' &&
          record(value.target) &&
          typeof value.warnings === 'number') ||
          (typeof value.code === 'string' && typeof value.message === 'string'))
        ? { value: value as Result | ErrorResult }
        : { issues: [{ message: 'rename_table result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};

export function registerRenameTableTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'rename_table',
    {
      title: 'Rename one bounded MySQL table',
      description: 'Renames one existing base table within its schema. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeRenameTableInput(input);
        await validateRenameTableMetadata(mysql, normalized.schema, normalized.table, normalized.newTable);
        const [result, operationId] = await mysql.ddl.executeRenameTableWithOperationId(createRenameTableStatement(normalized));
        const response: Result = {
          operation: 'rename_table',
          operationId,
          target: { schema: normalized.schema, table: normalized.table, newTable: normalized.newTable },
          warnings: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
        const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
        return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
      }
    },
  );
}
