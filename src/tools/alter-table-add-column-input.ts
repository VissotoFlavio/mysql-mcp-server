import {
  createTableInputJsonSchema,
  normalizeCreateTableInput,
  type CreateTableColumn,
  type CreateTableInput,
  type CreateTableValidationCode,
  type CreateTableValidationIssue,
} from './create-table-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export type AlterTableAddColumnInput = Readonly<{
  schema: string;
  table: string;
  column: CreateTableColumn;
  reason: string;
}>;

export type AlterTableAddColumnValidationCode = CreateTableValidationCode | 'column_not_nullable';

const MAX_PAYLOAD_BYTES = 262_144;
const MAX_NESTING_DEPTH = 100;

const SAFE_MESSAGES: Readonly<Record<AlterTableAddColumnValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  auto_increment_invalid: 'AUTO_INCREMENT is not supported when adding a column.',
  column_limit_exceeded: 'The request contains too many columns.',
  column_not_nullable: 'The added column must be nullable.',
  control_character: 'Control characters are not accepted here.',
  duplicate_column: 'Column names must be distinct.',
  duplicate_primary_key: 'Primary-key columns must be distinct.',
  invalid_identifier: 'Identifiers must be unquoted names.',
  invalid_payload: 'The payload must be a safe JSON value.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  primary_key_invalid: 'Primary-key columns must name declared columns.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
};

export class AlterTableAddColumnInputValidationError extends Error {
  readonly code: AlterTableAddColumnValidationCode;
  readonly path: string;

  constructor(code: AlterTableAddColumnValidationCode, path: string) {
    super(`Invalid ALTER TABLE ADD COLUMN input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'AlterTableAddColumnInputValidationError';
    this.code = code;
    this.path = path;
  }

  get issue(): CreateTableValidationIssue | Readonly<{ code: 'column_not_nullable'; path: string; message: string }> {
    return { code: this.code, path: this.path, message: this.message } as CreateTableValidationIssue;
  }
}

function fail(code: AlterTableAddColumnValidationCode, path: string): never {
  throw new AlterTableAddColumnInputValidationError(code, path);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProperties(value: unknown, required: readonly string[], path: string): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('invalid_type', path);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', path);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', `${path}.${missing}`);
}

function snapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, { maximumBytes: MAX_PAYLOAD_BYTES, maximumDepth: MAX_NESTING_DEPTH, fail });
  } catch (error) {
    if (error instanceof AlterTableAddColumnInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

/** Validates the deliberately narrow nullable-column ALTER TABLE surface. */
export function normalizeAlterTableAddColumnInput(value: unknown): AlterTableAddColumnInput {
  const payload = snapshot(value);
  assertProperties(payload, ['schema', 'table', 'column', 'reason'], 'input');
  assertProperties(payload.column, ['name', 'type', 'nullable'], 'input.column');
  if (payload.column.nullable !== true) fail('column_not_nullable', 'input.column.nullable');

  let tableInput: CreateTableInput;
  try {
    tableInput = normalizeCreateTableInput({
      schema: payload.schema,
      table: payload.table,
      columns: [payload.column],
      primaryKey: [isRecord(payload.column) ? payload.column.name : undefined],
      reason: payload.reason,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && 'path' in error) {
      const typed = error as Readonly<{ code: AlterTableAddColumnValidationCode; path: string }>;
      fail(typed.code, typed.path.replace(/^input\.columns\[0\]/u, 'input.column'));
    }
    fail('invalid_payload', 'input');
  }

  const column = tableInput.columns[0];
  if (column === undefined || column.autoIncrement === true || column.nullable !== true) fail('auto_increment_invalid', 'input.column');
  return Object.freeze({ schema: tableInput.schema, table: tableInput.table, column, reason: tableInput.reason });
}

/** JSON Schema for the bounded one-column nullable ALTER TABLE operation. */
export function alterTableAddColumnInputJsonSchema(): Record<string, unknown> {
  const createTableSchema = createTableInputJsonSchema();
  const properties = createTableSchema.properties as Record<string, unknown>;
  const columnProperties = ((properties.columns as Record<string, unknown>).items as Record<string, unknown>).properties;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'column', 'reason'],
    properties: {
      schema: properties.schema,
      table: properties.table,
      reason: properties.reason,
      column: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'nullable'],
        properties: {
          name: (columnProperties as Record<string, unknown>).name,
          type: (columnProperties as Record<string, unknown>).type,
          nullable: { const: true },
        },
      },
    },
  };
}
