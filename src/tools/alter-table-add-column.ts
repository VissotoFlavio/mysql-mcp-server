import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateAlterTableAddColumnMetadata } from '../db/metadata.js';
import { createAlterTableAddColumnStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  alterTableAddColumnInputJsonSchema,
  normalizeAlterTableAddColumnInput,
  type AlterTableAddColumnInput,
} from './alter-table-add-column-input.js';

type AlterTableAddColumnResult = Readonly<{
  operation: 'alter_table_add_column';
  operationId: string;
  target: Readonly<{ schema: string; table: string; column: string }>;
  warnings: number;
}>;
type AlterTableAddColumnError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is AlterTableAddColumnInput {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    record(value.column) &&
    typeof value.reason === 'string'
  );
}

function validOutput(value: unknown): value is AlterTableAddColumnResult | AlterTableAddColumnError {
  return (
    record(value) &&
    ((value.operation === 'alter_table_add_column' &&
      typeof value.operationId === 'string' &&
      record(value.target) &&
      typeof value.warnings === 'number') ||
      (typeof value.code === 'string' && typeof value.message === 'string'))
  );
}

const inputSchema: StandardSchemaWithJSON<AlterTableAddColumnInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for alter_table_add_column.' }] };
    },
    jsonSchema: { input: () => alterTableAddColumnInputJsonSchema(), output: () => alterTableAddColumnInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<AlterTableAddColumnResult | AlterTableAddColumnError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'alter_table_add_column result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerAlterTableAddColumnTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'alter_table_add_column',
    {
      title: 'Add one bounded nullable MySQL column',
      description: 'Adds one validated nullable column to an existing base table. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeAlterTableAddColumnInput(input);
        await validateAlterTableAddColumnMetadata(mysql, normalized.schema, normalized.table, normalized.column.name);
        const [result, operationId] = await mysql.ddl.executeAlterTableAddColumnWithOperationId(createAlterTableAddColumnStatement(normalized));
        const response: AlterTableAddColumnResult = {
          operation: 'alter_table_add_column',
          operationId,
          target: { schema: normalized.schema, table: normalized.table, column: normalized.column.name },
          warnings: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
