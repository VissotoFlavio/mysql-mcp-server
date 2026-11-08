import {
  CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  MAX_CREATE_TABLE_IDENTIFIER_LENGTH,
  MAX_CREATE_TABLE_NESTING_DEPTH,
  MAX_CREATE_TABLE_PAYLOAD_BYTES,
  MAX_CREATE_TABLE_REASON_LENGTH,
} from './create-table-input.js';
import { snapshotDdlInput } from './ddl-input-snapshot.js';

/** The intentionally small charset/collation surface for controlled CREATE SCHEMA. */
export const CREATE_SCHEMA_CHARACTER_SETS = Object.freeze(['ascii', 'latin1', 'utf8', 'utf8mb4'] as const);
export const CREATE_SCHEMA_COLLATIONS = Object.freeze([
  'ascii_bin',
  'ascii_general_ci',
  'latin1_bin',
  'latin1_general_ci',
  'latin1_swedish_ci',
  'utf8_bin',
  'utf8_general_ci',
  'utf8_unicode_ci',
  'utf8mb4_0900_ai_ci',
  'utf8mb4_0900_as_cs',
  'utf8mb4_0900_bin',
  'utf8mb4_bin',
  'utf8mb4_general_ci',
  'utf8mb4_unicode_ci',
] as const);

const COLLATION_CHARACTER_SETS: Readonly<Record<CreateSchemaCollation, CreateSchemaCharacterSet>> = Object.freeze({
  ascii_bin: 'ascii',
  ascii_general_ci: 'ascii',
  latin1_bin: 'latin1',
  latin1_general_ci: 'latin1',
  latin1_swedish_ci: 'latin1',
  utf8_bin: 'utf8',
  utf8_general_ci: 'utf8',
  utf8_unicode_ci: 'utf8',
  utf8mb4_0900_ai_ci: 'utf8mb4',
  utf8mb4_0900_as_cs: 'utf8mb4',
  utf8mb4_0900_bin: 'utf8mb4',
  utf8mb4_bin: 'utf8mb4',
  utf8mb4_general_ci: 'utf8mb4',
  utf8mb4_unicode_ci: 'utf8mb4',
});

export type CreateSchemaCharacterSet = (typeof CREATE_SCHEMA_CHARACTER_SETS)[number];
export type CreateSchemaCollation = (typeof CREATE_SCHEMA_COLLATIONS)[number];
export type CreateSchemaInput = Readonly<{
  schema: string;
  charset?: CreateSchemaCharacterSet;
  collation?: CreateSchemaCollation;
  reason: string;
}>;

export function isCreateSchemaCharacterSet(value: string): value is CreateSchemaCharacterSet {
  return (CREATE_SCHEMA_CHARACTER_SETS as readonly string[]).includes(value);
}

export function isCreateSchemaCollation(value: string): value is CreateSchemaCollation {
  return (CREATE_SCHEMA_COLLATIONS as readonly string[]).includes(value);
}

export function isCreateSchemaCollationForCharacterSet(collation: CreateSchemaCollation, charset: CreateSchemaCharacterSet): boolean {
  return COLLATION_CHARACTER_SETS[collation] === charset;
}

export type CreateSchemaValidationCode =
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

const MESSAGES: Readonly<Record<CreateSchemaValidationCode, string>> = {
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

export class CreateSchemaInputValidationError extends Error {
  constructor(
    readonly code: CreateSchemaValidationCode,
    readonly path: string,
  ) {
    super(`Invalid CREATE SCHEMA input at ${path}: ${MESSAGES[code]}`);
    this.name = 'CreateSchemaInputValidationError';
  }
}

function fail(code: CreateSchemaValidationCode, path: string): never {
  throw new CreateSchemaInputValidationError(code, path);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function properties(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!record(value)) fail('invalid_type', path);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) fail('additional_property', path);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', `${path}.${missing}`);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_CREATE_TABLE_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) fail('control_character', path);
  if (/[`"]/u.test(value)) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_CREATE_TABLE_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function charset(value: unknown): CreateSchemaCharacterSet {
  if (typeof value !== 'string') fail('invalid_type', 'input.charset');
  if (!isCreateSchemaCharacterSet(value)) fail('invalid_value', 'input.charset');
  return value as CreateSchemaCharacterSet;
}

function collation(value: unknown): CreateSchemaCollation {
  if (typeof value !== 'string') fail('invalid_type', 'input.collation');
  if (!isCreateSchemaCollation(value)) fail('invalid_value', 'input.collation');
  return value as CreateSchemaCollation;
}

/** Validates and snapshots the strict CREATE SCHEMA contract. */
export function normalizeCreateSchemaInput(value: unknown): CreateSchemaInput {
  let payload: unknown;
  try {
    payload = snapshotDdlInput(value, { maximumBytes: MAX_CREATE_TABLE_PAYLOAD_BYTES, maximumDepth: MAX_CREATE_TABLE_NESTING_DEPTH, fail });
  } catch (error) {
    if (error instanceof CreateSchemaInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
  properties(payload, ['schema', 'reason'], ['charset', 'collation'], 'input');
  const normalizedCharset = Object.hasOwn(payload, 'charset') ? charset(payload.charset) : undefined;
  const normalizedCollation = Object.hasOwn(payload, 'collation') ? collation(payload.collation) : undefined;
  if (normalizedCollation !== undefined && normalizedCharset === undefined) fail('invalid_value', 'input.collation');
  if (
    normalizedCharset !== undefined &&
    normalizedCollation !== undefined &&
    !isCreateSchemaCollationForCharacterSet(normalizedCollation, normalizedCharset)
  )
    fail('invalid_value', 'input.collation');
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    ...(normalizedCharset === undefined ? {} : { charset: normalizedCharset }),
    ...(normalizedCollation === undefined ? {} : { collation: normalizedCollation }),
    reason: reason(payload.reason),
  });
}

export function createSchemaInputJsonSchema(): Record<string, unknown> {
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
    required: ['schema', 'reason'],
    properties: {
      schema: identifierSchema,
      charset: { enum: CREATE_SCHEMA_CHARACTER_SETS },
      collation: { enum: CREATE_SCHEMA_COLLATIONS },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CREATE_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
    allOf: [{ if: { required: ['collation'] }, then: { required: ['charset'] } }],
  };
}

export const CREATE_SCHEMA_INPUT_JSON_SCHEMA = createSchemaInputJsonSchema;
