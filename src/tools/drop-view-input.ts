import {
  CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_TABLE_IDENTIFIER_LENGTH,
  MAX_CREATE_TABLE_NESTING_DEPTH,
  MAX_CREATE_TABLE_PAYLOAD_BYTES,
  MAX_CREATE_TABLE_REASON_LENGTH,
} from './create-table-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

export const DROP_VIEW_CONFIRMATION = 'DROP_VIEW';
export const MAX_DROP_VIEW_IDENTIFIER_LENGTH = MAX_CREATE_TABLE_IDENTIFIER_LENGTH;
export const MAX_DROP_VIEW_REASON_LENGTH = MAX_CREATE_TABLE_REASON_LENGTH;
export const MAX_DROP_VIEW_PAYLOAD_BYTES = MAX_CREATE_TABLE_PAYLOAD_BYTES;
export const MAX_DROP_VIEW_NESTING_DEPTH = MAX_CREATE_TABLE_NESTING_DEPTH;
export const DROP_VIEW_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN;

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export type DropViewInput = Readonly<{
  schema: string;
  view: string;
  reason: string;
  confirmation: typeof DROP_VIEW_CONFIRMATION;
}>;

export type DropViewValidationCode =
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

const SAFE_MESSAGES: Readonly<Record<DropViewValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  confirmation_required: 'The exact DROP_VIEW confirmation is required.',
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

export class DropViewInputValidationError extends Error {
  readonly code: DropViewValidationCode;
  readonly path: string;

  constructor(code: DropViewValidationCode, path: string) {
    super(`Invalid DROP VIEW input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'DropViewInputValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: DropViewValidationCode, path: string): never {
  throw new DropViewInputValidationError(code, path);
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
  if (unicodeLength(value) > MAX_DROP_VIEW_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (value.includes('`') || value.includes('"')) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_DROP_VIEW_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function payloadSnapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, {
      maximumBytes: MAX_DROP_VIEW_PAYLOAD_BYTES,
      maximumDepth: MAX_DROP_VIEW_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof DropViewInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

/** Validates and snapshots the exact structured DROP VIEW request. */
export function normalizeDropViewInput(value: unknown): DropViewInput {
  const payload = payloadSnapshot(value);
  if (!isRecord(payload)) fail('invalid_type', 'input');
  const required = ['schema', 'view', 'reason', 'confirmation'];
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', 'input');
  const missing = required.find((key) => !Object.hasOwn(payload, key));
  if (missing !== undefined) fail('missing_property', `input.${missing}`);
  if (payload.confirmation !== DROP_VIEW_CONFIRMATION) fail('confirmation_required', 'input.confirmation');
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    view: identifier(payload.view, 'input.view'),
    reason: reason(payload.reason),
    confirmation: DROP_VIEW_CONFIRMATION,
  });
}

export function dropViewInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_DROP_VIEW_IDENTIFIER_LENGTH,
    pattern: DROP_VIEW_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'view', 'reason', 'confirmation'],
    properties: {
      schema: identifier,
      view: identifier,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_DROP_VIEW_REASON_LENGTH,
        pattern: `^(?=.*\\S)${DROP_VIEW_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      confirmation: { const: DROP_VIEW_CONFIRMATION },
    },
  };
}
