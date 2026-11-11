import {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_NESTING_DEPTH,
  MAX_CREATE_INDEX_PAYLOAD_BYTES,
  MAX_CREATE_INDEX_REASON_LENGTH,
} from './create-index-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const TRUNCATE_TABLE_CONFIRMATION_PREFIX = 'TRUNCATE_TABLE:';
export const TRUNCATE_TABLE_METADATA_REVISION_LENGTH = 64;
export const MAX_TRUNCATE_TABLE_IDENTIFIER_LENGTH = MAX_CREATE_INDEX_IDENTIFIER_LENGTH;
export const MAX_TRUNCATE_TABLE_REASON_LENGTH = MAX_CREATE_INDEX_REASON_LENGTH;
export const MAX_TRUNCATE_TABLE_PAYLOAD_BYTES = MAX_CREATE_INDEX_PAYLOAD_BYTES;
export const MAX_TRUNCATE_TABLE_NESTING_DEPTH = MAX_CREATE_INDEX_NESTING_DEPTH;
export const TRUNCATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN;

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const TRUNCATE_TABLE_CONFIRMATION_PATTERN = new RegExp(
  `^${TRUNCATE_TABLE_CONFIRMATION_PREFIX}[0-9a-f]{${TRUNCATE_TABLE_METADATA_REVISION_LENGTH}}$`,
  'u',
);

export type TruncateTableInput = Readonly<{
  schema: string;
  table: string;
  reason: string;
  confirmation: string;
}>;

export type TruncateTableValidationCode =
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

const SAFE_MESSAGES: Readonly<Record<TruncateTableValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  confirmation_required: 'A target-bound TRUNCATE_TABLE confirmation is required.',
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

export class TruncateTableInputValidationError extends Error {
  constructor(
    readonly code: TruncateTableValidationCode,
    readonly path: string,
  ) {
    super(`Invalid TRUNCATE TABLE input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'TruncateTableInputValidationError';
  }
}

function fail(code: TruncateTableValidationCode, path: string): never {
  throw new TruncateTableInputValidationError(code, path);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_TRUNCATE_TABLE_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (value.includes('`') || value.includes('"')) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_TRUNCATE_TABLE_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function confirmation(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.confirmation');
  if (!TRUNCATE_TABLE_CONFIRMATION_PATTERN.test(value)) fail('confirmation_required', 'input.confirmation');
  return value;
}

export function truncateTableMetadataRevision(confirmation: string): string {
  if (!TRUNCATE_TABLE_CONFIRMATION_PATTERN.test(confirmation)) throw new Error('Invalid TRUNCATE TABLE confirmation.');
  return confirmation.slice(TRUNCATE_TABLE_CONFIRMATION_PREFIX.length);
}

export function createTruncateTableConfirmation(metadataRevision: string): string {
  if (!/^[0-9a-f]{64}$/u.test(metadataRevision)) throw new Error('Invalid TRUNCATE TABLE metadata revision.');
  return `${TRUNCATE_TABLE_CONFIRMATION_PREFIX}${metadataRevision}`;
}

export function normalizeTruncateTableInput(value: unknown): TruncateTableInput {
  let payload: unknown;
  try {
    payload = snapshotDdlInput(value, {
      maximumBytes: MAX_TRUNCATE_TABLE_PAYLOAD_BYTES,
      maximumDepth: MAX_TRUNCATE_TABLE_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof TruncateTableInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
  if (!record(payload)) fail('invalid_type', 'input');
  const required = ['schema', 'table', 'reason', 'confirmation'];
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(payload, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    table: identifier(payload.table, 'input.table'),
    reason: reason(payload.reason),
    confirmation: confirmation(payload.confirmation),
  });
}

export function truncateTableInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TRUNCATE_TABLE_IDENTIFIER_LENGTH,
    pattern: TRUNCATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'reason', 'confirmation'],
    properties: {
      schema: identifier,
      table: identifier,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TRUNCATE_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${TRUNCATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      confirmation: {
        type: 'string',
        pattern: `^${TRUNCATE_TABLE_CONFIRMATION_PREFIX}[0-9a-f]{${TRUNCATE_TABLE_METADATA_REVISION_LENGTH}}$`,
      },
    },
  };
}
