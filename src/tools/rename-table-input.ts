import {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_NESTING_DEPTH,
  MAX_CREATE_INDEX_PAYLOAD_BYTES,
  MAX_CREATE_INDEX_REASON_LENGTH,
} from './create-index-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const MAX_RENAME_TABLE_IDENTIFIER_LENGTH = MAX_CREATE_INDEX_IDENTIFIER_LENGTH;
export const MAX_RENAME_TABLE_REASON_LENGTH = MAX_CREATE_INDEX_REASON_LENGTH;
export const MAX_RENAME_TABLE_PAYLOAD_BYTES = MAX_CREATE_INDEX_PAYLOAD_BYTES;
export const MAX_RENAME_TABLE_NESTING_DEPTH = MAX_CREATE_INDEX_NESTING_DEPTH;
export const RENAME_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN;

export type RenameTableInput = Readonly<{ schema: string; table: string; newTable: string; reason: string }>;
export type RenameTableInputValidationCode =
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

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const QUOTE = /[`"]/u;
const MESSAGES: Readonly<Record<RenameTableInputValidationCode, string>> = {
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

export class RenameTableInputValidationError extends Error {
  constructor(
    readonly code: RenameTableInputValidationCode,
    readonly path: string,
  ) {
    super(`Invalid RENAME TABLE input at ${path}: ${MESSAGES[code]}`);
    this.name = 'RenameTableInputValidationError';
  }
}

function fail(code: RenameTableInputValidationCode, path: string): never {
  throw new RenameTableInputValidationError(code, path);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function length(value: string): number {
  return Array.from(value).length;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (length(value) > MAX_RENAME_TABLE_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL.test(value)) fail('control_character', path);
  if (QUOTE.test(value)) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (normalized.length === 0) fail('invalid_value', 'input.reason');
  if (length(normalized) > MAX_RENAME_TABLE_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

export function normalizeRenameTableInput(value: unknown): RenameTableInput {
  let payload: unknown;
  try {
    payload = snapshotDdlInput(value, {
      maximumBytes: MAX_RENAME_TABLE_PAYLOAD_BYTES,
      maximumDepth: MAX_RENAME_TABLE_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof RenameTableInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
  if (!record(payload)) fail('invalid_type', 'input');
  const required = ['schema', 'table', 'newTable', 'reason'];
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(payload, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
  const table = identifier(payload.table, 'input.table');
  const newTable = identifier(payload.newTable, 'input.newTable');
  if (table.toLocaleLowerCase('en-US') === newTable.toLocaleLowerCase('en-US')) fail('invalid_value', 'input.newTable');
  return Object.freeze({ schema: identifier(payload.schema, 'input.schema'), table, newTable, reason: reason(payload.reason) });
}

export function renameTableInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_RENAME_TABLE_IDENTIFIER_LENGTH,
    pattern: RENAME_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'newTable', 'reason'],
    properties: {
      schema: identifier,
      table: identifier,
      newTable: identifier,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RENAME_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${RENAME_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
  };
}
