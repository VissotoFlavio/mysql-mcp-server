import {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_NESTING_DEPTH,
  MAX_CREATE_INDEX_PAYLOAD_BYTES,
  MAX_CREATE_INDEX_REASON_LENGTH,
} from './create-index-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const DROP_SCHEMA_CONFIRMATION_PREFIX = 'DROP_SCHEMA:';
export const DROP_SCHEMA_METADATA_REVISION_LENGTH = 64;
export const MAX_DROP_SCHEMA_IDENTIFIER_LENGTH = MAX_CREATE_INDEX_IDENTIFIER_LENGTH;
export const MAX_DROP_SCHEMA_REASON_LENGTH = MAX_CREATE_INDEX_REASON_LENGTH;
export const MAX_DROP_SCHEMA_PAYLOAD_BYTES = MAX_CREATE_INDEX_PAYLOAD_BYTES;
export const MAX_DROP_SCHEMA_NESTING_DEPTH = MAX_CREATE_INDEX_NESTING_DEPTH;
export const DROP_SCHEMA_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN;

const CONFIRMATION_PATTERN = new RegExp(`^${DROP_SCHEMA_CONFIRMATION_PREFIX}[0-9a-f]{${DROP_SCHEMA_METADATA_REVISION_LENGTH}}$`, 'u');
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export type DropSchemaInput = Readonly<{
  schema: string;
  reason: string;
  confirmation?: string;
}>;

export type DropSchemaValidationCode =
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

const SAFE_MESSAGES: Readonly<Record<DropSchemaValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  confirmation_required: 'A target-bound DROP_SCHEMA confirmation is required.',
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

export class DropSchemaInputValidationError extends Error {
  constructor(
    readonly code: DropSchemaValidationCode,
    readonly path: string,
  ) {
    super(`Invalid DROP SCHEMA input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'DropSchemaInputValidationError';
  }
}

function fail(code: DropSchemaValidationCode, path: string): never {
  throw new DropSchemaInputValidationError(code, path);
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
  if (unicodeLength(value) > MAX_DROP_SCHEMA_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (value.includes('`') || value.includes('"')) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_DROP_SCHEMA_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function confirmation(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.confirmation');
  if (!CONFIRMATION_PATTERN.test(value)) fail('confirmation_required', 'input.confirmation');
  return value;
}

export function dropSchemaMetadataRevision(confirmationValue: string): string {
  if (!CONFIRMATION_PATTERN.test(confirmationValue)) throw new Error('Invalid DROP SCHEMA confirmation.');
  return confirmationValue.slice(DROP_SCHEMA_CONFIRMATION_PREFIX.length);
}

export function createDropSchemaConfirmation(metadataRevision: string): string {
  if (!/^[0-9a-f]{64}$/u.test(metadataRevision)) throw new Error('Invalid DROP SCHEMA metadata revision.');
  return `${DROP_SCHEMA_CONFIRMATION_PREFIX}${metadataRevision}`;
}

export function normalizeDropSchemaInput(value: unknown): DropSchemaInput {
  let payload: unknown;
  try {
    payload = snapshotDdlInput(value, {
      maximumBytes: MAX_DROP_SCHEMA_PAYLOAD_BYTES,
      maximumDepth: MAX_DROP_SCHEMA_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof DropSchemaInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
  if (!record(payload)) fail('invalid_type', 'input');
  const required = ['schema', 'reason'];
  const optional = ['confirmation'];
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !allowed.has(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(payload, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
  const normalizedConfirmation = Object.hasOwn(payload, 'confirmation') ? confirmation(payload.confirmation) : undefined;
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    reason: reason(payload.reason),
    ...(normalizedConfirmation === undefined ? {} : { confirmation: normalizedConfirmation }),
  });
}

export function dropSchemaInputJsonSchema(): Record<string, unknown> {
  const identifierSchema = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_DROP_SCHEMA_IDENTIFIER_LENGTH,
    pattern: DROP_SCHEMA_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'reason'],
    properties: {
      schema: identifierSchema,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_DROP_SCHEMA_REASON_LENGTH,
        pattern: `^(?=.*\\S)${DROP_SCHEMA_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      confirmation: { type: 'string', pattern: `^${DROP_SCHEMA_CONFIRMATION_PREFIX}[0-9a-f]{${DROP_SCHEMA_METADATA_REVISION_LENGTH}}$` },
    },
  };
}
