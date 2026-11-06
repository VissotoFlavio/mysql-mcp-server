import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateAlterTableAddForeignKeyMetadata } from '../db/metadata.js';
import { createAlterTableAddForeignKeyStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  alterTableAddForeignKeyInputJsonSchema,
  normalizeAlterTableAddForeignKeyInput,
  type AlterTableAddForeignKeyInput,
} from './alter-table-add-foreign-key-input.js';

type AlterTableAddForeignKeyResult = Readonly<{
  operation: 'alter_table_add_foreign_key';
  operationId: string;
  target: Readonly<{ schema: string; table: string; constraint: string }>;
  warnings: number;
}>;
type AlterTableAddForeignKeyError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validInput(value: unknown): value is AlterTableAddForeignKeyInput {
  return (
    record(value) &&
    Object.keys(value).length === 9 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.constraint === 'string' &&
    Array.isArray(value.columns) &&
    typeof value.referencedTable === 'string' &&
    Array.isArray(value.referencedColumns) &&
    typeof value.onDelete === 'string' &&
    typeof value.onUpdate === 'string' &&
    typeof value.reason === 'string'
  );
}
function validOutput(value: unknown): value is AlterTableAddForeignKeyResult | AlterTableAddForeignKeyError {
  return (
    record(value) &&
    ((value.operation === 'alter_table_add_foreign_key' &&
      typeof value.operationId === 'string' &&
      record(value.target) &&
      typeof value.warnings === 'number') ||
      (typeof value.code === 'string' && typeof value.message === 'string'))
  );
}
const inputSchema: StandardSchemaWithJSON<AlterTableAddForeignKeyInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for alter_table_add_foreign_key.' }] };
    },
    jsonSchema: { input: () => alterTableAddForeignKeyInputJsonSchema(), output: () => alterTableAddForeignKeyInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<AlterTableAddForeignKeyResult | AlterTableAddForeignKeyError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'alter_table_add_foreign_key result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};
function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerAlterTableAddForeignKeyTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'alter_table_add_foreign_key',
    {
      title: 'Add one controlled MySQL foreign key',
      description:
        'Adds one validated intra-schema foreign key between existing InnoDB base tables. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeAlterTableAddForeignKeyInput(input);
        await validateAlterTableAddForeignKeyMetadata(mysql, normalized);
        const [result, operationId] = await mysql.ddl.executeAlterTableAddForeignKeyWithOperationId(
          createAlterTableAddForeignKeyStatement(normalized),
        );
        const response: AlterTableAddForeignKeyResult = {
          operation: 'alter_table_add_foreign_key',
          operationId,
          target: { schema: normalized.schema, table: normalized.table, constraint: normalized.constraint },
          warnings: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
