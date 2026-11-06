import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateAlterTableRenameColumnMetadata } from '../db/metadata.js';
import { createAlterTableRenameColumnStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  alterTableRenameColumnInputJsonSchema,
  normalizeAlterTableRenameColumnInput,
  type AlterTableRenameColumnInput,
} from './alter-table-rename-column-input.js';

type Result = Readonly<{
  operation: 'alter_table_rename_column';
  operationId: string;
  target: Readonly<{ schema: string; table: string; column: string; newColumn: string }>;
  warnings: number;
}>;
type ErrorResult = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const inputSchema: StandardSchemaWithJSON<AlterTableRenameColumnInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value) {
      return record(value) &&
        Object.keys(value).length === 5 &&
        typeof value.schema === 'string' &&
        typeof value.table === 'string' &&
        typeof value.column === 'string' &&
        typeof value.newColumn === 'string' &&
        typeof value.reason === 'string'
        ? { value: value as AlterTableRenameColumnInput }
        : { issues: [{ message: 'Invalid arguments for alter_table_rename_column.' }] };
    },
    jsonSchema: { input: alterTableRenameColumnInputJsonSchema, output: alterTableRenameColumnInputJsonSchema },
  },
};
const outputSchema: StandardSchemaWithJSON<Result | ErrorResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value) {
      return record(value) &&
        ((value.operation === 'alter_table_rename_column' &&
          typeof value.operationId === 'string' &&
          record(value.target) &&
          typeof value.warnings === 'number') ||
          (typeof value.code === 'string' && typeof value.message === 'string'))
        ? { value: value as Result | ErrorResult }
        : { issues: [{ message: 'alter_table_rename_column result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};
export function registerAlterTableRenameColumnTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'alter_table_rename_column',
    {
      title: 'Rename one bounded MySQL column',
      description: 'Renames one existing column without changing its definition. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeAlterTableRenameColumnInput(input);
        await validateAlterTableRenameColumnMetadata(mysql, normalized.schema, normalized.table, normalized.column, normalized.newColumn);
        const [result, operationId] = await mysql.ddl.executeAlterTableRenameColumnWithOperationId(createAlterTableRenameColumnStatement(normalized));
        const response: Result = {
          operation: 'alter_table_rename_column',
          operationId,
          target: { schema: normalized.schema, table: normalized.table, column: normalized.column, newColumn: normalized.newColumn },
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
