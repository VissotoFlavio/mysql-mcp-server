import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const MAX_ALTER_TABLE_DROP_FOREIGN_KEY_IDENTIFIER_LENGTH = 64;
export const MAX_ALTER_TABLE_DROP_FOREIGN_KEY_REASON_LENGTH = 500;
export const MAX_ALTER_TABLE_DROP_FOREIGN_KEY_PAYLOAD_BYTES = 262_144;
export const MAX_ALTER_TABLE_DROP_FOREIGN_KEY_NESTING_DEPTH = 100;
export const ALTER_TABLE_DROP_FOREIGN_KEY_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = '^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\u2028\\u2029])';

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const IDENTIFIER_QUOTE_PATTERN = /[\x60\x22]/u;

export type AlterTableDropForeignKeyInput = Readonly<{ schema: string; table: string; constraint: string; reason: string }>;
export type AlterTableDropForeignKeyValidationCode =
  | 'additional_property'
  | 'control_character'
  | 'invalid_identifier'
  | 'invalid_payload'
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_property'
  | 'payload_too_large'
  | 'sparse_array'
  | 'string_too_long';

const SAFE_MESSAGES: Readonly<Record<AlterTableDropForeignKeyValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
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

export class AlterTableDropForeignKeyInputValidationError extends Error {
  readonly code: AlterTableDropForeignKeyValidationCode;
  readonly path: string;
  constructor(code: AlterTableDropForeignKeyValidationCode, path: string) {
    super(`Invalid ALTER TABLE DROP FOREIGN KEY input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'AlterTableDropForeignKeyInputValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: AlterTableDropForeignKeyValidationCode, path: string): never {
  throw new AlterTableDropForeignKeyInputValidationError(code, path);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unicodeLength(value: string): number {
  return Array.from(value).length;
}
function payloadSnapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, {
      maximumBytes: MAX_ALTER_TABLE_DROP_FOREIGN_KEY_PAYLOAD_BYTES,
      maximumDepth: MAX_ALTER_TABLE_DROP_FOREIGN_KEY_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof AlterTableDropForeignKeyInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}
function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_ALTER_TABLE_DROP_FOREIGN_KEY_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (IDENTIFIER_QUOTE_PATTERN.test(value)) fail('invalid_identifier', path);
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_ALTER_TABLE_DROP_FOREIGN_KEY_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

export function normalizeAlterTableDropForeignKeyInput(value: unknown): AlterTableDropForeignKeyInput {
  const payload = payloadSnapshot(value);
  if (!isRecord(payload)) fail('invalid_type', 'input');
  const required = ['schema', 'table', 'constraint', 'reason'];
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(payload, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    table: identifier(payload.table, 'input.table'),
    constraint: identifier(payload.constraint, 'input.constraint'),
    reason: reason(payload.reason),
  });
}

export function alterTableDropForeignKeyInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_ALTER_TABLE_DROP_FOREIGN_KEY_IDENTIFIER_LENGTH,
    pattern: ALTER_TABLE_DROP_FOREIGN_KEY_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'constraint', 'reason'],
    properties: {
      schema: identifier,
      table: identifier,
      constraint: identifier,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ALTER_TABLE_DROP_FOREIGN_KEY_REASON_LENGTH,
        pattern: `^(?=.*\\S)${ALTER_TABLE_DROP_FOREIGN_KEY_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
  };
}
