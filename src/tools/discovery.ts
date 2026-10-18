import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { MAX_METADATA_RESULTS, listAccessibleSchemas, listAccessibleTables, type SchemaMetadata, type TableMetadata } from '../db/metadata.js';
import type { ConnectionLayer } from '../db/pool.js';

type TablesInput = Readonly<{ schema: string }>;
type SchemaResult = Readonly<{ metadata: readonly SchemaMetadata[] }>;
type TableResult = Readonly<{ metadata: readonly TableMetadata[] }>;

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

function isTablesInput(value: unknown): value is TablesInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 1 && typeof input.schema === 'string' && input.schema.length > 0 && input.schema.length <= 64;
}

function isSchemaResult(value: unknown): value is SchemaResult {
  return hasMetadata(value) && value.metadata.every((item) => hasExactStringProperties(item, ['schemaName']));
}

function isTableResult(value: unknown): value is TableResult {
  return hasMetadata(value) && value.metadata.every((item) => hasExactStringProperties(item, ['schemaName', 'tableName', 'tableType']));
}

function hasMetadata(value: unknown): value is Readonly<{ metadata: readonly unknown[] }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 1 && Array.isArray(result.metadata);
}

function hasExactStringProperties(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;
  return Object.keys(item).length === keys.length && keys.every((key) => typeof item[key] === 'string');
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
}
