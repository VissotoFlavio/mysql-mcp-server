import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { MAX_METADATA_RESULTS, describeAccessibleTable, type TableDescription } from '../db/metadata.js';
import type { ConnectionLayer } from '../db/pool.js';

type DescribeTableInput = Readonly<{ schema: string; table: string }>;
type TableDescriptionResult = TableDescription;

const IDENTIFIER_PATTERN = '^[^\\u0000-\\u001F\\u007F]*$';

const describeTableInputSchema: StandardSchemaWithJSON<DescribeTableInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isDescribeTableInput(value)) {
        return { issues: [{ message: 'schema and table must be non-empty identifiers with at most 64 characters and no control characters' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => describeTableInputJsonSchema(),
      output: () => describeTableInputJsonSchema(),
    },
  },
};

const tableDescriptionOutputSchema: StandardSchemaWithJSON<TableDescriptionResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isTableDescriptionResult(value)) {
        return { issues: [{ message: 'table description must contain table and column metadata' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => tableDescriptionOutputJsonSchema(),
      output: () => tableDescriptionOutputJsonSchema(),
    },
  },
};

function isDescribeTableInput(value: unknown): value is DescribeTableInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2 && isIdentifier(input.schema) && isIdentifier(input.table);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isTableDescriptionResult(value: unknown): value is TableDescriptionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 2 &&
    hasExactStringProperties(result.table, ['schemaName', 'tableName', 'tableType']) &&
    Array.isArray(result.columns) &&
    result.columns.every(
      (column) =>
        hasExactProperties(column, ['columnName', 'dataType', 'isNullable', 'columnKey']) &&
        typeof column.columnName === 'string' &&
        typeof column.dataType === 'string' &&
        typeof column.isNullable === 'boolean' &&
        typeof column.columnKey === 'string',
    )
  );
}

function hasExactStringProperties(value: unknown, keys: readonly string[]): boolean {
  return hasExactProperties(value, keys) && keys.every((key) => typeof value[key] === 'string');
}

function hasExactProperties(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;
  return Object.keys(item).length === keys.length && keys.every((key) => key in item);
}

function describeTableInputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table'],
    properties: {
      schema: { type: 'string', minLength: 1, maxLength: 64, pattern: IDENTIFIER_PATTERN },
      table: { type: 'string', minLength: 1, maxLength: 64, pattern: IDENTIFIER_PATTERN },
    },
  };
}

function tableDescriptionOutputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['table', 'columns'],
    properties: {
      table: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaName', 'tableName', 'tableType'],
        properties: {
          schemaName: { type: 'string' },
          tableName: { type: 'string' },
          tableType: { type: 'string' },
        },
      },
      columns: {
        type: 'array',
        maxItems: MAX_METADATA_RESULTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['columnName', 'dataType', 'isNullable', 'columnKey'],
          properties: {
            columnName: { type: 'string' },
            dataType: { type: 'string' },
            isNullable: { type: 'boolean' },
            columnKey: { type: 'string' },
          },
        },
      },
    },
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function tableDescriptionResult(description: TableDescriptionResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(description) }],
    structuredContent: description,
  };
}

export function registerDescribeTableTool(server: McpServer, mysql: ConnectionLayer): void {
  server.registerTool(
    'describe_table',
    {
      title: 'Describe accessible table or view',
      description: 'Describes one table or view visible to the configured MySQL account, including bounded column metadata. This tool is read-only.',
      inputSchema: describeTableInputSchema,
      outputSchema: tableDescriptionOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ schema, table }) => {
      try {
        const description = await describeAccessibleTable(mysql, schema, table);
        if (description === undefined) {
          return errorResult('The requested table or view was not found or is not accessible. Verify the identifiers and configured permissions.');
        }

        return tableDescriptionResult(description);
      } catch {
        return errorResult('Unable to describe the requested table or view. Verify the configured MySQL connection and permissions.');
      }
    },
  );
}
