import {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_NESTING_DEPTH,
  MAX_CREATE_INDEX_PAYLOAD_BYTES,
  MAX_CREATE_INDEX_REASON_LENGTH,
} from './create-index-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const DROP_TABLE_CONFIRMATION_PREFIX = 'DROP_TABLE:';
export const DROP_TABLE_METADATA_REVISION_LENGTH = 64;
export const MAX_DROP_TABLE_IDENTIFIER_LENGTH = MAX_CREATE_INDEX_IDENTIFIER_LENGTH;
export const MAX_DROP_TABLE_REASON_LENGTH = MAX_CREATE_INDEX_REASON_LENGTH;
export const MAX_DROP_TABLE_PAYLOAD_BYTES = MAX_CREATE_INDEX_PAYLOAD_BYTES;
export const MAX_DROP_TABLE_NESTING_DEPTH = MAX_CREATE_INDEX_NESTING_DEPTH;
export const DROP_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN;

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const DROP_TABLE_CONFIRMATION_PATTERN = new RegExp(`^${DROP_TABLE_CONFIRMATION_PREFIX}[0-9a-f]{${DROP_TABLE_METADATA_REVISION_LENGTH}}$`, 'u');

export type DropTableInput = Readonly<{
  schema: string;
  table: string;
  reason: string;
  confirmation: string;
}>;

export type DropTableValidationCode =
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

const SAFE_MESSAGES: Readonly<Record<DropTableValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  confirmation_required: 'A target-bound DROP_TABLE confirmation is required.',
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

export class DropTableInputValidationError extends Error {
  constructor(
    readonly code: DropTableValidationCode,
    readonly path: string,
  ) {
    super(`Invalid DROP TABLE input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'DropTableInputValidationError';
  }
}

function fail(code: DropTableValidationCode, path: string): never {
  throw new DropTableInputValidationError(code, path);
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
  if (unicodeLength(value) > MAX_DROP_TABLE_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (value.includes('`') || value.includes('"')) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_DROP_TABLE_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function confirmation(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.confirmation');
  if (!DROP_TABLE_CONFIRMATION_PATTERN.test(value)) fail('confirmation_required', 'input.confirmation');
  return value;
}

/** Returns the revision carried by a normalized DROP TABLE confirmation. */
export function dropTableMetadataRevision(confirmation: string): string {
  if (!DROP_TABLE_CONFIRMATION_PATTERN.test(confirmation)) throw new Error('Invalid DROP TABLE confirmation.');
  return confirmation.slice(DROP_TABLE_CONFIRMATION_PREFIX.length);
}

/** Builds the target-bound confirmation token from a read-only metadata revision. */
export function createDropTableConfirmation(metadataRevision: string): string {
  if (!/^[0-9a-f]{64}$/u.test(metadataRevision)) throw new Error('Invalid DROP TABLE metadata revision.');
  return `${DROP_TABLE_CONFIRMATION_PREFIX}${metadataRevision}`;
}

export function normalizeDropTableInput(value: unknown): DropTableInput {
  let payload: unknown;
  try {
    payload = snapshotDdlInput(value, {
      maximumBytes: MAX_DROP_TABLE_PAYLOAD_BYTES,
      maximumDepth: MAX_DROP_TABLE_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof DropTableInputValidationError) throw error;
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

export function dropTableInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_DROP_TABLE_IDENTIFIER_LENGTH,
    pattern: DROP_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
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
        maxLength: MAX_DROP_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${DROP_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      confirmation: { type: 'string', pattern: `^${DROP_TABLE_CONFIRMATION_PREFIX}[0-9a-f]{${DROP_TABLE_METADATA_REVISION_LENGTH}}$` },
    },
  };
}
