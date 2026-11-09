import {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_NESTING_DEPTH,
  MAX_CREATE_INDEX_PAYLOAD_BYTES,
  MAX_CREATE_INDEX_REASON_LENGTH,
} from './create-index-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const ALTER_TABLE_DROP_COLUMN_CONFIRMATION = 'DROP_COLUMN';
export const MAX_ALTER_TABLE_DROP_COLUMN_IDENTIFIER_LENGTH = MAX_CREATE_INDEX_IDENTIFIER_LENGTH;
export const MAX_ALTER_TABLE_DROP_COLUMN_REASON_LENGTH = MAX_CREATE_INDEX_REASON_LENGTH;
export const MAX_ALTER_TABLE_DROP_COLUMN_PAYLOAD_BYTES = MAX_CREATE_INDEX_PAYLOAD_BYTES;
export const MAX_ALTER_TABLE_DROP_COLUMN_NESTING_DEPTH = MAX_CREATE_INDEX_NESTING_DEPTH;
export const ALTER_TABLE_DROP_COLUMN_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN;

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export type AlterTableDropColumnInput = Readonly<{
  schema: string;
  table: string;
  column: string;
  reason: string;
  confirmation: typeof ALTER_TABLE_DROP_COLUMN_CONFIRMATION;
}>;

export type AlterTableDropColumnValidationCode =
  | 'additional_property'
  | 'confirmation_required'
  | 'control_character'
  | 'invalid_identifier'
  | 'invalid_payload'
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_property'
  | 'payload_too_large'
  | 'sparse_array'
  | 'string_too_long';

const SAFE_MESSAGES: Readonly<Record<AlterTableDropColumnValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  confirmation_required: 'The exact DROP_COLUMN confirmation is required.',
  control_character: 'Control characters are not accepted here.',
  invalid_identifier: 'Identifiers must be unquoted names.',
  invalid_payload: 'The payload must be a safe JSON value.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
};

export class AlterTableDropColumnInputValidationError extends Error {
  readonly code: AlterTableDropColumnValidationCode;
  readonly path: string;

  constructor(code: AlterTableDropColumnValidationCode, path: string) {
    super(`Invalid ALTER TABLE DROP COLUMN input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'AlterTableDropColumnInputValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: AlterTableDropColumnValidationCode, path: string): never {
  throw new AlterTableDropColumnInputValidationError(code, path);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_ALTER_TABLE_DROP_COLUMN_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (value.includes('`') || value.includes('"')) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_ALTER_TABLE_DROP_COLUMN_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function payloadSnapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, {
      maximumBytes: MAX_ALTER_TABLE_DROP_COLUMN_PAYLOAD_BYTES,
      maximumDepth: MAX_ALTER_TABLE_DROP_COLUMN_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof AlterTableDropColumnInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

/** Validates and snapshots the exact structured ALTER TABLE DROP COLUMN request. */
export function normalizeAlterTableDropColumnInput(value: unknown): AlterTableDropColumnInput {
  const payload = payloadSnapshot(value);
  if (!isRecord(payload)) fail('invalid_type', 'input');
  const required = ['schema', 'table', 'column', 'reason', 'confirmation'];
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(payload, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
  if (payload.confirmation !== ALTER_TABLE_DROP_COLUMN_CONFIRMATION) fail('confirmation_required', 'input.confirmation');
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    table: identifier(payload.table, 'input.table'),
    column: identifier(payload.column, 'input.column'),
    reason: reason(payload.reason),
    confirmation: ALTER_TABLE_DROP_COLUMN_CONFIRMATION,
  });
}

export function alterTableDropColumnInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_ALTER_TABLE_DROP_COLUMN_IDENTIFIER_LENGTH,
    pattern: ALTER_TABLE_DROP_COLUMN_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'column', 'reason', 'confirmation'],
    properties: {
      schema: identifier,
      table: identifier,
      column: identifier,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ALTER_TABLE_DROP_COLUMN_REASON_LENGTH,
        pattern: `^(?=.*\\S)${ALTER_TABLE_DROP_COLUMN_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      confirmation: { const: ALTER_TABLE_DROP_COLUMN_CONFIRMATION },
    },
  };
}
