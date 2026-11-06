import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS = 16;
export const MAX_ALTER_TABLE_FOREIGN_KEY_IDENTIFIER_LENGTH = 64;
export const MAX_ALTER_TABLE_FOREIGN_KEY_REASON_LENGTH = 500;
export const MAX_ALTER_TABLE_FOREIGN_KEY_PAYLOAD_BYTES = 262_144;
export const MAX_ALTER_TABLE_FOREIGN_KEY_NESTING_DEPTH = 100;
export const ALTER_TABLE_FOREIGN_KEY_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = '^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\u2028\\u2029])';

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const IDENTIFIER_QUOTE_PATTERN = /[`"]/u;
const ACTIONS = ['RESTRICT', 'NO ACTION'] as const;

export type ForeignKeyAction = (typeof ACTIONS)[number];
export type AlterTableAddForeignKeyInput = Readonly<{
  schema: string;
  table: string;
  constraint: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete: ForeignKeyAction;
  onUpdate: ForeignKeyAction;
  reason: string;
}>;
export type AlterTableAddForeignKeyValidationCode =
  | 'additional_property'
  | 'column_limit_exceeded'
  | 'control_character'
  | 'duplicate_column'
  | 'invalid_action'
  | 'invalid_identifier'
  | 'invalid_payload'
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_property'
  | 'payload_too_large'
  | 'sparse_array'
  | 'string_too_long'
  | 'column_count_mismatch';

const SAFE_MESSAGES: Readonly<Record<AlterTableAddForeignKeyValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  column_limit_exceeded: 'The foreign key contains too many columns.',
  control_character: 'Control characters are not accepted here.',
  duplicate_column: 'Foreign-key columns must be distinct.',
  invalid_action: 'Only RESTRICT and NO ACTION referential actions are accepted.',
  invalid_identifier: 'Identifiers must be unquoted names.',
  invalid_payload: 'The payload must be a safe JSON value.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
  column_count_mismatch: 'Local and referenced column lists must have the same length.',
};

export class AlterTableAddForeignKeyInputValidationError extends Error {
  readonly code: AlterTableAddForeignKeyValidationCode;
  readonly path: string;
  constructor(code: AlterTableAddForeignKeyValidationCode, path: string) {
    super(`Invalid ALTER TABLE ADD FOREIGN KEY input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'AlterTableAddForeignKeyInputValidationError';
    this.code = code;
    this.path = path;
  }
}
function fail(code: AlterTableAddForeignKeyValidationCode, path: string): never {
  throw new AlterTableAddForeignKeyInputValidationError(code, path);
}
function unicodeLength(value: string): number {
  return Array.from(value).length;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function payloadSnapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, {
      maximumBytes: MAX_ALTER_TABLE_FOREIGN_KEY_PAYLOAD_BYTES,
      maximumDepth: MAX_ALTER_TABLE_FOREIGN_KEY_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof AlterTableAddForeignKeyInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}
function assertProperties(value: unknown): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('invalid_type', 'input');
  const required = ['schema', 'table', 'constraint', 'columns', 'referencedTable', 'referencedColumns', 'onDelete', 'onUpdate', 'reason'];
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
}
function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_ALTER_TABLE_FOREIGN_KEY_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (IDENTIFIER_QUOTE_PATTERN.test(value)) fail('invalid_identifier', path);
  return value;
}
function columnList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (value.length > MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS) fail('column_limit_exceeded', path);
  const names = new Set<string>();
  return Object.freeze(
    value.map((item, index) => {
      const name = identifier(item, `${path}[${index}]`);
      if (names.has(name)) fail('duplicate_column', path);
      names.add(name);
      return name;
    }),
  );
}
function action(value: unknown, path: string): ForeignKeyAction {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (!ACTIONS.includes(value as ForeignKeyAction)) fail('invalid_action', path);
  return value as ForeignKeyAction;
}
function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_ALTER_TABLE_FOREIGN_KEY_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}
function precheckColumnCardinality(value: unknown): void {
  if (!isRecord(value)) return;
  for (const property of ['columns', 'referencedColumns']) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) continue;
      const length = Object.getOwnPropertyDescriptor(descriptor.value, 'length')?.value;
      if (typeof length === 'number' && Number.isSafeInteger(length) && length > MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS)
        fail('column_limit_exceeded', `input.${property}`);
    } catch (error) {
      if (error instanceof AlterTableAddForeignKeyInputValidationError) throw error;
      fail('invalid_payload', 'input');
    }
  }
}

/** Normalizes the only supported intra-schema, indexed foreign-key request shape. */
export function normalizeAlterTableAddForeignKeyInput(value: unknown): AlterTableAddForeignKeyInput {
  precheckColumnCardinality(value);
  const payload = payloadSnapshot(value);
  assertProperties(payload);
  const columns = columnList(payload.columns, 'input.columns');
  const referencedColumns = columnList(payload.referencedColumns, 'input.referencedColumns');
  if (columns.length !== referencedColumns.length) fail('column_count_mismatch', 'input.referencedColumns');
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    table: identifier(payload.table, 'input.table'),
    constraint: identifier(payload.constraint, 'input.constraint'),
    columns,
    referencedTable: identifier(payload.referencedTable, 'input.referencedTable'),
    referencedColumns,
    onDelete: action(payload.onDelete, 'input.onDelete'),
    onUpdate: action(payload.onUpdate, 'input.onUpdate'),
    reason: reason(payload.reason),
  });
}

/** JSON Schema for the bounded foreign-key surface. */
export function alterTableAddForeignKeyInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_ALTER_TABLE_FOREIGN_KEY_IDENTIFIER_LENGTH,
    pattern: ALTER_TABLE_FOREIGN_KEY_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'constraint', 'columns', 'referencedTable', 'referencedColumns', 'onDelete', 'onUpdate', 'reason'],
    properties: {
      schema: identifier,
      table: identifier,
      constraint: identifier,
      referencedTable: identifier,
      columns: { type: 'array', minItems: 1, maxItems: MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS, uniqueItems: true, items: identifier },
      referencedColumns: { type: 'array', minItems: 1, maxItems: MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS, uniqueItems: true, items: identifier },
      onDelete: { enum: ACTIONS },
      onUpdate: { enum: ACTIONS },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ALTER_TABLE_FOREIGN_KEY_REASON_LENGTH,
        pattern: `^(?=.*\\S)${ALTER_TABLE_FOREIGN_KEY_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
  };
}
