import { snapshotDdlInput } from './ddl-input-snapshot.js';

/** Structured, bounded input for a future CREATE INDEX tool. This module neither emits SQL nor uses a driver. */
export const MAX_CREATE_INDEX_COLUMNS = 16;
export const MAX_CREATE_INDEX_IDENTIFIER_LENGTH = 64;
export const MAX_CREATE_INDEX_REASON_LENGTH = 500;
export const MAX_CREATE_INDEX_PAYLOAD_BYTES = 262_144;
export const MAX_CREATE_INDEX_NESTING_DEPTH = 100;
export const CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = '^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\u2028\\u2029])';

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const IDENTIFIER_QUOTE_PATTERN = /[`"]/u;

export type CreateIndexInput = Readonly<{
  schema: string;
  table: string;
  index: string;
  columns: readonly string[];
  reason: string;
}>;

export type CreateIndexValidationCode =
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

const SAFE_MESSAGES: Readonly<Record<CreateIndexValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  column_limit_exceeded: 'The index contains too many columns.',
  control_character: 'Control characters are not accepted here.',
  duplicate_column: 'Index columns must be distinct.',
  invalid_identifier: 'Identifiers must be unquoted names.',
  invalid_payload: 'The payload must be a safe JSON value.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
};

export class CreateIndexInputValidationError extends Error {
  readonly code: CreateIndexValidationCode;
  readonly path: string;

  constructor(code: CreateIndexValidationCode, path: string) {
    super(`Invalid CREATE INDEX input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'CreateIndexInputValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: CreateIndexValidationCode, path: string): never {
  throw new CreateIndexInputValidationError(code, path);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function indexPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

function payloadSnapshot(value: unknown): unknown {
  try {
    return snapshotDdlInput(value, {
      maximumBytes: MAX_CREATE_INDEX_PAYLOAD_BYTES,
      maximumDepth: MAX_CREATE_INDEX_NESTING_DEPTH,
      fail,
    });
  } catch (error) {
    if (error instanceof CreateIndexInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProperties(value: unknown, path: string): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('invalid_type', path);
  const required = ['schema', 'table', 'index', 'columns', 'reason'];
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !required.includes(key))) fail('additional_property', path);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', `${path}.${missing}`);
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_CREATE_INDEX_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (IDENTIFIER_QUOTE_PATTERN.test(value)) fail('invalid_identifier', path);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_CREATE_INDEX_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}

function columns(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail('invalid_type', 'input.columns');
  if (value.length === 0) fail('invalid_value', 'input.columns');
  if (value.length > MAX_CREATE_INDEX_COLUMNS) fail('column_limit_exceeded', 'input.columns');
  const names = new Set<string>();
  const output = value.map((item, index) => {
    const name = identifier(item, indexPath('input.columns', index));
    if (names.has(name)) fail('duplicate_column', 'input.columns');
    names.add(name);
    return name;
  });
  return Object.freeze(output);
}

function precheckColumnCardinality(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'columns');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) return;
    const length = Object.getOwnPropertyDescriptor(descriptor.value, 'length')?.value;
    if (typeof length === 'number' && Number.isSafeInteger(length) && length > MAX_CREATE_INDEX_COLUMNS)
      fail('column_limit_exceeded', 'input.columns');
  } catch (error) {
    if (error instanceof CreateIndexInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

/** Validates and snapshots a CREATE INDEX request into a deterministic, immutable normal form. */
export function normalizeCreateIndexInput(value: unknown): CreateIndexInput {
  precheckColumnCardinality(value);
  const payload = payloadSnapshot(value);
  assertProperties(payload, 'input');
  return Object.freeze({
    schema: identifier(payload.schema, 'input.schema'),
    table: identifier(payload.table, 'input.table'),
    index: identifier(payload.index, 'input.index'),
    columns: columns(payload.columns),
    reason: reason(payload.reason),
  });
}

/** JSON Schema for the deliberately small, structured MySQL 8.4 v1 index surface. */
export function createIndexInputJsonSchema(): Record<string, unknown> {
  const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_CREATE_INDEX_IDENTIFIER_LENGTH,
    pattern: CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'index', 'columns', 'reason'],
    properties: {
      schema: identifier,
      table: identifier,
      index: identifier,
      columns: { type: 'array', minItems: 1, maxItems: MAX_CREATE_INDEX_COLUMNS, uniqueItems: true, items: identifier },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CREATE_INDEX_REASON_LENGTH,
        pattern: `^(?=.*\\S)${CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
    },
  };
}
