import {
  CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_TABLE_IDENTIFIER_LENGTH,
  MAX_CREATE_TABLE_NESTING_DEPTH,
  MAX_CREATE_TABLE_PAYLOAD_BYTES,
  MAX_CREATE_TABLE_REASON_LENGTH,
} from './create-table-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

/** The deliberately small projection-only definition supported by create_view. */
export const MAX_CREATE_VIEW_COLUMNS = 100;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const IDENTIFIER_QUOTE_PATTERN = /[`"]/u;

export type CreateViewInput = Readonly<{
  schema: string;
  view: string;
  definition: Readonly<{ table: string; columns: readonly string[] }>;
  reason: string;
}>;
export type CreateViewValidationCode =
  | 'additional_property'
  | 'column_limit_exceeded'
  | 'control_character'
  | 'duplicate_column'
  | 'invalid_identifier'
  | 'invalid_payload'
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_property'
  | 'payload_too_large'
  | 'sparse_array'
  | 'string_too_long';
const MESSAGES: Readonly<Record<CreateViewValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  column_limit_exceeded: 'The view contains too many columns.',
  control_character: 'Control characters are not accepted here.',
  duplicate_column: 'Column names must be distinct.',
  invalid_identifier: 'Identifiers must be unquoted names.',
  invalid_payload: 'The payload must be a safe JSON value.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
};
export class CreateViewInputValidationError extends Error {
  constructor(
    readonly code: CreateViewValidationCode,
    readonly path: string,
  ) {
    super(`Invalid CREATE VIEW input at ${path}: ${MESSAGES[code]}`);
    this.name = 'CreateViewInputValidationError';
  }
}
function fail(code: CreateViewValidationCode, path: string): never {
  throw new CreateViewInputValidationError(code, path);
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function properties(value: unknown, required: readonly string[], path: string): asserts value is Readonly<Record<string, unknown>> {
  if (!record(value)) fail('invalid_type', path);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', path);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', `${path}.${missing}`);
}
function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (Array.from(value).length > MAX_CREATE_TABLE_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (IDENTIFIER_QUOTE_PATTERN.test(value)) fail('invalid_identifier', path);
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (normalized.length === 0) fail('invalid_value', 'input.reason');
  if (Array.from(normalized).length > MAX_CREATE_TABLE_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}
function definition(value: unknown): CreateViewInput['definition'] {
  properties(value, ['table', 'columns'], 'input.definition');
  if (!Array.isArray(value.columns)) fail('invalid_type', 'input.definition.columns');
  if (value.columns.length === 0) fail('invalid_value', 'input.definition.columns');
  if (value.columns.length > MAX_CREATE_VIEW_COLUMNS) fail('column_limit_exceeded', 'input.definition.columns');
  const columns = value.columns.map((column, index) => identifier(column, `input.definition.columns[${index}]`));
  if (new Set(columns).size !== columns.length) fail('duplicate_column', 'input.definition.columns');
  return Object.freeze({ table: identifier(value.table, 'input.definition.table'), columns: Object.freeze(columns) });
}

/** Validates and snapshots the projection-only create_view contract. */
export function normalizeCreateViewInput(value: unknown): CreateViewInput {
  let payload: unknown;
  try {
    payload = snapshotDdlInput(value, { maximumBytes: MAX_CREATE_TABLE_PAYLOAD_BYTES, maximumDepth: MAX_CREATE_TABLE_NESTING_DEPTH, fail });
  } catch (error) {
    if (error instanceof CreateViewInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
  properties(payload, ['schema', 'view', 'definition', 'reason'], 'input');
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    view: identifier(payload.view, 'input.view'),
    definition: definition(payload.definition),
    reason: reason(payload.reason),
  });
}

export function createViewInputJsonSchema(): Record<string, unknown> {
  const identifierSchema = {
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
    required: ['schema', 'view', 'definition', 'reason'],
    properties: {
      schema: identifierSchema,
      view: identifierSchema,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CREATE_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      definition: {
        type: 'object',
        additionalProperties: false,
        required: ['table', 'columns'],
        properties: {
          table: identifierSchema,
          columns: { type: 'array', minItems: 1, maxItems: MAX_CREATE_VIEW_COLUMNS, uniqueItems: true, items: identifierSchema },
        },
      },
    },
  };
}
export const CREATE_VIEW_INPUT_JSON_SCHEMA = createViewInputJsonSchema;
