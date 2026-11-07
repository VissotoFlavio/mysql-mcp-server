import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateAlterTableDropForeignKeyMetadata } from '../db/metadata.js';
import { createAlterTableDropForeignKeyStatement, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  alterTableDropForeignKeyInputJsonSchema,
  normalizeAlterTableDropForeignKeyInput,
  type AlterTableDropForeignKeyInput,
} from './alter-table-drop-foreign-key-input.js';

type Result = Readonly<{
  operation: 'alter_table_drop_foreign_key';
  operationId: string;
  target: Readonly<{ schema: string; table: string; constraint: string }>;
  warnings: number;
}>;
type ErrorResult = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const inputSchema: StandardSchemaWithJSON<AlterTableDropForeignKeyInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return record(value) &&
        Object.keys(value).length === 4 &&
        typeof value.schema === 'string' &&
        typeof value.table === 'string' &&
        typeof value.constraint === 'string' &&
        typeof value.reason === 'string'
        ? { value: value as AlterTableDropForeignKeyInput }
        : { issues: [{ message: 'Invalid arguments for alter_table_drop_foreign_key.' }] };
    },
    jsonSchema: { input: alterTableDropForeignKeyInputJsonSchema, output: alterTableDropForeignKeyInputJsonSchema },
  },
};
const outputSchema: StandardSchemaWithJSON<Result | ErrorResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return record(value) &&
        ((value.operation === 'alter_table_drop_foreign_key' &&
          typeof value.operationId === 'string' &&
          record(value.target) &&
          typeof value.warnings === 'number') ||
          (typeof value.code === 'string' && typeof value.message === 'string'))
        ? { value: value as Result | ErrorResult }
        : { issues: [{ message: 'alter_table_drop_foreign_key result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};
function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerAlterTableDropForeignKeyTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'alter_table_drop_foreign_key',
    {
      title: 'Drop one controlled MySQL foreign key',
      description:
        'Drops one explicitly named foreign key after metadata preflight. Supporting indexes are preserved. The operation is destructive, audited, requires DDL opt-in, and is never retried automatically.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeAlterTableDropForeignKeyInput(input);
        await validateAlterTableDropForeignKeyMetadata(mysql, normalized);
        const [result, operationId] = await mysql.ddl.executeAlterTableDropForeignKeyWithOperationId(
          createAlterTableDropForeignKeyStatement(normalized),
        );
        const response: Result = {
          operation: 'alter_table_drop_foreign_key',
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
