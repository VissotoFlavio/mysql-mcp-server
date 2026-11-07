import {
  CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_TABLE_IDENTIFIER_LENGTH,
  MAX_CREATE_TABLE_NESTING_DEPTH,
  MAX_CREATE_TABLE_PAYLOAD_BYTES,
  MAX_CREATE_TABLE_REASON_LENGTH,
  createTableInputJsonSchema,
  normalizeCreateTableInput,
  type CreateTableColumn,
  type CreateTableInput,
  type CreateTableValidationCode,
  type CreateTableValidationIssue,
} from './create-table-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export type AlterTableModifyColumnInput = Readonly<{
  schema: string;
  table: string;
  column: string;
  definition: AlterTableModifyColumnDefinition;
  reason: string;
}>;
export type AlterTableModifyColumnDefinition = CreateTableColumn &
  Readonly<{
    characterSet?: string;
    collation?: string;
  }>;

export type AlterTableModifyColumnValidationCode = CreateTableValidationCode | 'column_name_mismatch';

const SAFE_MESSAGES: Readonly<Record<AlterTableModifyColumnValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  auto_increment_invalid: 'AUTO_INCREMENT is only accepted when preserved by the metadata preflight.',
  column_limit_exceeded: 'The request contains too many columns.',
  column_name_mismatch: 'The target definition must keep the source column name.',
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

export class AlterTableModifyColumnInputValidationError extends Error {
  readonly code: AlterTableModifyColumnValidationCode;
  readonly path: string;

  constructor(code: AlterTableModifyColumnValidationCode, path: string) {
    super(`Invalid ALTER TABLE MODIFY COLUMN input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'AlterTableModifyColumnInputValidationError';
    this.code = code;
    this.path = path;
  }

  get issue(): CreateTableValidationIssue | Readonly<{ code: 'column_name_mismatch'; path: string; message: string }> {
    return { code: this.code, path: this.path, message: this.message } as CreateTableValidationIssue;
  }
}

function fail(code: AlterTableModifyColumnValidationCode, path: string): never {
  throw new AlterTableModifyColumnInputValidationError(code, path);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProperties(
  value: unknown,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('invalid_type', path);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) fail('additional_property', path);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', `${path}.${missing}`);
}

function snapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, { maximumBytes: MAX_CREATE_TABLE_PAYLOAD_BYTES, maximumDepth: MAX_CREATE_TABLE_NESTING_DEPTH, fail });
  } catch (error) {
    if (error instanceof AlterTableModifyColumnInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

function metadataName(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0 || value.length > MAX_CREATE_TABLE_IDENTIFIER_LENGTH)
    fail(value.length > MAX_CREATE_TABLE_IDENTIFIER_LENGTH ? 'string_too_long' : 'invalid_value', path);
  if (!/^[A-Za-z0-9_]+$/u.test(value)) fail('invalid_identifier', path);
  return value;
}

/** Validates the structured target definition for one bounded column modification. */
export function normalizeAlterTableModifyColumnInput(value: unknown): AlterTableModifyColumnInput {
  const payload = snapshot(value);
  assertProperties(payload, ['schema', 'table', 'column', 'definition', 'reason'], 'input');
  assertProperties(payload.definition, ['name', 'type', 'nullable'], 'input.definition', ['autoIncrement', 'characterSet', 'collation']);

  let tableInput: CreateTableInput;
  try {
    const createTableDefinition = { ...payload.definition };
    delete createTableDefinition.characterSet;
    delete createTableDefinition.collation;
    tableInput = normalizeCreateTableInput({
      schema: payload.schema,
      table: payload.table,
      columns: [createTableDefinition],
      primaryKey: [isRecord(createTableDefinition) ? createTableDefinition.name : undefined],
      reason: payload.reason,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && 'path' in error) {
      const typed = error as Readonly<{ code: AlterTableModifyColumnValidationCode; path: string }>;
      fail(typed.code, typed.path.replace(/^input\.columns\[0\]/u, 'input.definition'));
    }
    fail('invalid_payload', 'input');
  }

  const column = tableInput.columns[0];
  if (column === undefined) fail('invalid_value', 'input.definition');

  let sourceColumn: string;
  if (typeof payload.column !== 'string') fail('invalid_type', 'input.column');
  try {
    sourceColumn = normalizeCreateTableInput({
      schema: payload.schema,
      table: payload.table,
      columns: [{ name: payload.column, type: { kind: 'text' }, nullable: true }],
      primaryKey: [payload.column],
      reason: payload.reason,
    }).columns[0]?.name as string;
  } catch (error) {
    if (error instanceof Error && 'code' in error && 'path' in error) {
      const typed = error as Readonly<{ code: AlterTableModifyColumnValidationCode; path: string }>;
      fail(typed.code, typed.path.replace(/^input\.columns\[0\]\.name$/u, 'input.column'));
    }
    fail('invalid_payload', 'input.column');
  }
  if (column.name !== sourceColumn) fail('column_name_mismatch', 'input.definition.name');

  const characterSet = metadataName(payload.definition.characterSet, 'input.definition.characterSet');
  const collation = metadataName(payload.definition.collation, 'input.definition.collation');
  return Object.freeze({
    schema: tableInput.schema,
    table: tableInput.table,
    column: sourceColumn,
    definition: Object.freeze({
      ...column,
      ...(characterSet === undefined ? {} : { characterSet }),
      ...(collation === undefined ? {} : { collation }),
    }),
    reason: tableInput.reason,
  });
}

/** JSON Schema for one fully structured, same-name column modification request. */
export function alterTableModifyColumnInputJsonSchema(): Record<string, unknown> {
  const createTableSchema = createTableInputJsonSchema();
  const properties = createTableSchema.properties as Record<string, unknown>;
  const columnProperties = ((properties.columns as Record<string, unknown>).items as Record<string, unknown>).properties;
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_CREATE_TABLE_IDENTIFIER_LENGTH,
    pattern: CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'column', 'definition', 'reason'],
    properties: {
      schema: properties.schema,
      table: properties.table,
      column: identifier,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CREATE_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      definition: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'nullable'],
        properties: {
          name: (columnProperties as Record<string, unknown>).name,
          type: (columnProperties as Record<string, unknown>).type,
          nullable: { type: 'boolean' },
          autoIncrement: { type: 'boolean' },
          characterSet: identifier,
          collation: identifier,
        },
      },
    },
  };
}
