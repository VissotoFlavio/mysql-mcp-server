import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { toSafeDdlOutcome } from '../db/ddl-audit.js';
import { validateAlterTableModifyColumnMetadata, verifyAlterTableModifyColumnMetadata } from '../db/metadata.js';
import { createAlterTableModifyColumnStatement, DdlResultError, type ConnectionLayerBundle, wasDdlSubmitted } from '../db/pool.js';

import {
  alterTableModifyColumnInputJsonSchema,
  normalizeAlterTableModifyColumnInput,
  type AlterTableModifyColumnInput,
} from './alter-table-modify-column-input.js';

type AlterTableModifyColumnResult = Readonly<{
  operation: 'alter_table_modify_column';
  operationId: string;
  target: Readonly<{ schema: string; table: string; column: string }>;
  warnings: number;
}>;
type AlterTableModifyColumnError = Readonly<{ code: string; message: string; retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING' }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validInput(value: unknown): value is AlterTableModifyColumnInput {
  return (
    record(value) &&
    Object.keys(value).length === 5 &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.column === 'string' &&
    record(value.definition) &&
    typeof value.reason === 'string'
  );
}

function validOutput(value: unknown): value is AlterTableModifyColumnResult | AlterTableModifyColumnError {
  return (
    record(value) &&
    ((value.operation === 'alter_table_modify_column' &&
      typeof value.operationId === 'string' &&
      record(value.target) &&
      typeof value.warnings === 'number') ||
      (typeof value.code === 'string' && typeof value.message === 'string'))
  );
}

const inputSchema: StandardSchemaWithJSON<AlterTableModifyColumnInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validInput(value) ? { value } : { issues: [{ message: 'Invalid arguments for alter_table_modify_column.' }] };
    },
    jsonSchema: { input: () => alterTableModifyColumnInputJsonSchema(), output: () => alterTableModifyColumnInputJsonSchema() },
  },
};
const outputSchema: StandardSchemaWithJSON<AlterTableModifyColumnResult | AlterTableModifyColumnError> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      return validOutput(value) ? { value } : { issues: [{ message: 'alter_table_modify_column result is invalid.' }] };
    },
    jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
  },
};

function errorResult(error: unknown) {
  const outcome = toSafeDdlOutcome(error, wasDdlSubmitted(error));
  const structuredContent = outcome.retryAdvice === undefined ? { code: outcome.code, message: outcome.message } : outcome;
  return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent, isError: true };
}

export function registerAlterTableModifyColumnTool(server: McpServer, mysql: ConnectionLayerBundle): void {
  server.registerTool(
    'alter_table_modify_column',
    {
      title: 'Modify one bounded MySQL column definition',
      description:
        'Applies one preflighted, widening-only column definition change. The operation is non-idempotent, audited, and requires DDL opt-in.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const normalized = normalizeAlterTableModifyColumnInput(input);
        const prepared = await validateAlterTableModifyColumnMetadata(mysql, normalized);
        const [result, operationId] = await mysql.ddl.executeAlterTableModifyColumnWithOperationId(
          createAlterTableModifyColumnStatement(prepared),
          async () => {
            try {
              await verifyAlterTableModifyColumnMetadata(mysql, prepared);
            } catch {
              throw new DdlResultError();
            }
          },
        );
        const response: AlterTableModifyColumnResult = {
          operation: 'alter_table_modify_column',
          operationId,
          target: { schema: normalized.schema, table: normalized.table, column: normalized.column },
          warnings: result.warningStatus,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
