import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import {
  MAX_METADATA_RESULTS,
  describeAccessibleTable,
  listAccessibleSchemas,
  listAccessibleTables,
  type SchemaMetadata,
  type TableDescription,
  type TableMetadata,
} from '../db/metadata.js';
import type { ConnectionLayer } from '../db/pool.js';

type TablesInput = Readonly<{ schema: string }>;
type DescribeTableInput = Readonly<{ schema: string; table: string }>;
type SchemaResult = Readonly<{ metadata: readonly SchemaMetadata[] }>;
type TableResult = Readonly<{ metadata: readonly TableMetadata[] }>;
type TableDescriptionResult = TableDescription;

const IDENTIFIER_PATTERN = '^[^\\u0000-\\u001F\\u007F]*$';
const controlCharacterExpression = /[\u0000-\u001F\u007F]/;

const tablesInputSchema: StandardSchemaWithJSON<TablesInput> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isTablesInput(value)) {
        return { issues: [{ message: 'schema must be a non-empty string with at most 64 characters' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => ({
        type: 'object',
        additionalProperties: false,
        required: ['schema'],
        properties: {
          schema: { type: 'string', minLength: 1, maxLength: 64 },
        },
      }),
      output: () => ({
        type: 'object',
        additionalProperties: false,
        required: ['schema'],
        properties: {
          schema: { type: 'string', minLength: 1, maxLength: 64 },
        },
      }),
    },
  },
};

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

const schemasOutputSchema: StandardSchemaWithJSON<SchemaResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isSchemaResult(value)) {
        return { issues: [{ message: 'metadata must contain schema names' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => schemasOutputJsonSchema(),
      output: () => schemasOutputJsonSchema(),
    },
  },
};

const tablesOutputSchema: StandardSchemaWithJSON<TableResult> = {
  '~standard': {
    version: 1,
    vendor: 'mysql-mcp-server',
    validate(value: unknown) {
      if (!isTableResult(value)) {
        return { issues: [{ message: 'metadata must contain table metadata' }] };
      }

      return { value };
    },
    jsonSchema: {
      input: () => tablesOutputJsonSchema(),
      output: () => tablesOutputJsonSchema(),
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

function isTablesInput(value: unknown): value is TablesInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 1 && typeof input.schema === 'string' && input.schema.length > 0 && input.schema.length <= 64;
}

function isDescribeTableInput(value: unknown): value is DescribeTableInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2 && isIdentifier(input.schema) && isIdentifier(input.table);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !controlCharacterExpression.test(value);
}

function isSchemaResult(value: unknown): value is SchemaResult {
  return hasMetadata(value) && value.metadata.every((item) => hasExactStringProperties(item, ['schemaName']));
}

function isTableResult(value: unknown): value is TableResult {
  return hasMetadata(value) && value.metadata.every((item) => hasExactStringProperties(item, ['schemaName', 'tableName', 'tableType']));
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
        hasExactProperties(column, ['columnName', 'dataType', 'isNullable', 'columnKey', 'hasDefault']) &&
        typeof column.columnName === 'string' &&
        typeof column.dataType === 'string' &&
        typeof column.isNullable === 'boolean' &&
        typeof column.columnKey === 'string' &&
        typeof column.hasDefault === 'boolean',
    )
  );
}

function hasMetadata(value: unknown): value is Readonly<{ metadata: readonly unknown[] }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 1 && Array.isArray(result.metadata);
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

function schemasOutputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['metadata'],
    properties: {
      metadata: {
        type: 'array',
        maxItems: MAX_METADATA_RESULTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaName'],
          properties: { schemaName: { type: 'string' } },
        },
      },
    },
  };
}

function tablesOutputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['metadata'],
    properties: {
      metadata: {
        type: 'array',
        maxItems: MAX_METADATA_RESULTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaName', 'tableName', 'tableType'],
          properties: {
            schemaName: { type: 'string' },
            tableName: { type: 'string' },
            tableType: { type: 'string' },
          },
        },
      },
    },
  };
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
          required: ['columnName', 'dataType', 'isNullable', 'columnKey', 'hasDefault'],
          properties: {
            columnName: { type: 'string' },
            dataType: { type: 'string' },
            isNullable: { type: 'boolean' },
            columnKey: { type: 'string' },
            hasDefault: { type: 'boolean' },
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

function metadataResult<T extends object>(metadata: readonly T[]) {
  const structuredContent = { metadata };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function tableDescriptionResult(description: TableDescriptionResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(description) }],
    structuredContent: description,
  };
}

export function registerDiscoveryTools(server: McpServer, mysql: ConnectionLayer): void {
  server.registerTool(
    'list_accessible_schemas',
    {
      title: 'List accessible schemas',
      description: 'Lists up to 100 schemas visible to the configured MySQL account. This tool is read-only.',
      outputSchema: schemasOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return metadataResult(await listAccessibleSchemas(mysql));
      } catch {
        return errorResult('Unable to list accessible schemas. Verify the configured MySQL connection and permissions.');
      }
    },
  );

  server.registerTool(
    'list_accessible_tables',
    {
      title: 'List accessible tables',
      description: 'Lists up to 100 tables visible to the configured MySQL account in one schema. This tool is read-only.',
      inputSchema: tablesInputSchema,
      outputSchema: tablesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ schema }) => {
      try {
        return metadataResult(await listAccessibleTables(mysql, schema));
      } catch {
        return errorResult('Unable to list accessible tables. Verify the configured MySQL connection and permissions.');
      }
    },
  );

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
