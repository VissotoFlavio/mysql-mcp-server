/** Structured, bounded input for a future CREATE TABLE tool. This module neither emits SQL nor uses a driver. */
export const MAX_CREATE_TABLE_COLUMNS = 100;
export const MAX_CREATE_TABLE_IDENTIFIER_LENGTH = 64;
export const MAX_CREATE_TABLE_REASON_LENGTH = 500;
export const MAX_CREATE_TABLE_PAYLOAD_BYTES = 262_144;
export const MAX_CREATE_TABLE_NESTING_DEPTH = 100;
export const CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN = '^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\u2028\\u2029])';

const INTEGER_TYPES = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'] as const;
const TEXT_TYPES = ['char', 'varchar'] as const;
const TEMPORAL_TYPES = ['time', 'datetime', 'timestamp'] as const;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const IDENTIFIER_QUOTE_PATTERN = /[`"]/u;

export type CreateTableIntegerType = (typeof INTEGER_TYPES)[number];
export type CreateTableTextType = (typeof TEXT_TYPES)[number];
export type CreateTableTemporalType = (typeof TEMPORAL_TYPES)[number];
export type CreateTableColumnType =
  | Readonly<{ kind: 'integer'; integerType: CreateTableIntegerType; unsigned?: boolean }>
  | Readonly<{ kind: 'decimal'; precision: number; scale: number }>
  | Readonly<{ kind: CreateTableTextType; length: number }>
  | Readonly<{ kind: 'text' | 'date' | 'boolean' | 'json' }>
  | Readonly<{ kind: CreateTableTemporalType; fractionalSecondsPrecision?: number }>;
export type CreateTableColumn = Readonly<{ name: string; type: CreateTableColumnType; nullable: boolean; autoIncrement?: boolean }>;
export type CreateTableInput = Readonly<{
  schema: string;
  table: string;
  columns: readonly CreateTableColumn[];
  primaryKey: readonly string[];
  reason: string;
}>;

export type CreateTableValidationCode =
  | 'additional_property'
  | 'auto_increment_invalid'
  | 'column_limit_exceeded'
  | 'control_character'
  | 'duplicate_column'
  | 'duplicate_primary_key'
  | 'invalid_identifier'
  | 'invalid_payload'
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_property'
  | 'payload_too_large'
  | 'primary_key_invalid'
  | 'sparse_array'
  | 'string_too_long';
export interface CreateTableValidationIssue {
  readonly code: CreateTableValidationCode;
  readonly path: string;
  readonly message: string;
}

const SAFE_MESSAGES: Readonly<Record<CreateTableValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  auto_increment_invalid: 'AUTO_INCREMENT is only permitted for the first primary-key integer column and must be non-nullable.',
  column_limit_exceeded: 'The table contains too many columns.',
  control_character: 'Control characters are not accepted here.',
  duplicate_column: 'Column names must be distinct.',
  duplicate_primary_key: 'Primary-key columns must be distinct.',
  invalid_identifier: 'Identifiers must be unquoted names.',
  invalid_payload: 'The payload must be a safe JSON value.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  primary_key_invalid: 'Primary-key columns must name declared columns.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
};
export class CreateTableInputValidationError extends Error {
  readonly code: CreateTableValidationCode;
  readonly path: string;
  constructor(code: CreateTableValidationCode, path: string) {
    super(`Invalid CREATE TABLE input at ${path}: ${SAFE_MESSAGES[code]}`);
    this.name = 'CreateTableInputValidationError';
    this.code = code;
    this.path = path;
  }
  get issue(): CreateTableValidationIssue {
    return { code: this.code, path: this.path, message: this.message };
  }
}
function fail(code: CreateTableValidationCode, path: string): never {
  throw new CreateTableInputValidationError(code, path);
}
function propertyPath(path: string, property: string): string {
  return `${path}.${property}`;
}
function indexPath(path: string, index: number): string {
  return `${path}[${index}]`;
}
function unicodeLength(value: string): number {
  return Array.from(value).length;
}

/** Takes only enumerable data descriptors from ordinary JSON-shaped objects, with an early byte budget. */
class PayloadSnapshot {
  private bytes = 0;
  private readonly active = new WeakSet<object>();
  private reserve(bytes: number, path: string): void {
    this.bytes += bytes;
    if (this.bytes > MAX_CREATE_TABLE_PAYLOAD_BYTES) fail('payload_too_large', path);
  }
  private string(value: string, path: string): void {
    this.reserve(1, path);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) this.reserve(2, path);
      else if (unit < 0x20) this.reserve(6, path);
      else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        this.reserve(4, path);
        index += 1;
      } else if (unit >= 0xd800 && unit <= 0xdfff) this.reserve(6, path);
      else this.reserve(unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3, path);
    }
    this.reserve(1, path);
  }
  private descriptor(value: object, key: PropertyKey, path: string): PropertyDescriptor & { value: unknown } {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_payload', path);
    return descriptor as PropertyDescriptor & { value: unknown };
  }
  private index(key: string): number | undefined {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key ? index : undefined;
  }
  snapshot(value: unknown, path = 'input', depth = 0): unknown {
    if (value === null) {
      this.reserve(4, path);
      return null;
    }
    if (typeof value === 'string') {
      this.string(value, path);
      return value;
    }
    if (typeof value === 'boolean') {
      this.reserve(value ? 4 : 5, path);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('invalid_payload', path);
      this.reserve(Buffer.byteLength(JSON.stringify(value), 'utf8'), path);
      return value;
    }
    if (typeof value !== 'object' || depth >= MAX_CREATE_TABLE_NESTING_DEPTH || this.active.has(value)) fail('invalid_payload', path);
    this.active.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || Object.hasOwn(Array.prototype, 'toJSON') || Object.hasOwn(Object.prototype, 'toJSON'))
          fail('invalid_payload', path);
        return this.array(value, path, depth);
      }
      if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(Object.prototype, 'toJSON')) fail('invalid_payload', path);
      return this.object(value, path, depth);
    } finally {
      this.active.delete(value);
    }
  }
  private object(value: object, path: string, depth: number): Readonly<Record<string, unknown>> {
    const output = Object.create(null) as Record<string, unknown>;
    this.reserve(1, path);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('invalid_payload', path);
      if (count > 0) this.reserve(1, path);
      this.string(key, path);
      this.reserve(1, path);
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: this.snapshot(this.descriptor(value, key, path).value, path, depth + 1),
      });
      count += 1;
    }
    this.reserve(1, path);
    return Object.freeze(output);
  }
  private array(value: object, path: string, depth: number): readonly unknown[] {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    )
      fail('invalid_payload', path);
    const length = lengthDescriptor.value as number;
    if (
      Reflect.ownKeys(value).some(
        (key) => key !== 'length' && (typeof key !== 'string' || this.index(key) === undefined || (this.index(key) as number) >= length),
      )
    )
      fail('sparse_array', path);
    const output: unknown[] = [];
    this.reserve(1, path);
    for (let index = 0; index < length; index += 1) {
      if (index > 0) this.reserve(1, path);
      output.push(this.snapshot(this.descriptor(value, String(index), path).value, indexPath(path, index), depth + 1));
    }
    this.reserve(1, path);
    return Object.freeze(output);
  }
}
function payloadSnapshot(value: unknown): unknown {
  try {
    return new PayloadSnapshot().snapshot(value);
  } catch (error) {
    if (error instanceof CreateTableInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertProperties(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('invalid_type', path);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) fail('additional_property', path);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('missing_property', propertyPath(path, missing));
}
function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('invalid_type', path);
  if (value.length === 0) fail('invalid_value', path);
  if (unicodeLength(value) > MAX_CREATE_TABLE_IDENTIFIER_LENGTH) fail('string_too_long', path);
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', path);
  if (IDENTIFIER_QUOTE_PATTERN.test(value)) fail('invalid_identifier', path);
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_type', 'input.reason');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail('control_character', 'input.reason');
  const normalized = value.trim();
  if (unicodeLength(normalized) === 0) fail('invalid_value', 'input.reason');
  if (unicodeLength(normalized) > MAX_CREATE_TABLE_REASON_LENGTH) fail('string_too_long', 'input.reason');
  return normalized;
}
function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('invalid_type', path);
  if (value < min || value > max) fail('invalid_value', path);
  return value === 0 ? 0 : value;
}

function columnType(value: unknown, path: string): CreateTableColumnType {
  assertProperties(value, ['kind'], ['integerType', 'unsigned', 'precision', 'scale', 'length', 'fractionalSecondsPrecision'], path);
  const source = value;
  if (typeof source.kind !== 'string') fail('invalid_type', propertyPath(path, 'kind'));
  if (source.kind === 'integer') {
    assertProperties(source, ['kind', 'integerType'], ['unsigned'], path);
    if (!INTEGER_TYPES.includes(source.integerType as CreateTableIntegerType)) fail('invalid_value', propertyPath(path, 'integerType'));
    if (source.unsigned !== undefined && typeof source.unsigned !== 'boolean') fail('invalid_type', propertyPath(path, 'unsigned'));
    return Object.freeze(
      source.unsigned === true
        ? { kind: 'integer', integerType: source.integerType as CreateTableIntegerType, unsigned: true }
        : { kind: 'integer', integerType: source.integerType as CreateTableIntegerType },
    );
  }
  if (source.kind === 'decimal') {
    assertProperties(source, ['kind', 'precision', 'scale'], [], path);
    const precision = integer(source.precision, propertyPath(path, 'precision'), 1, 65);
    return Object.freeze({ kind: 'decimal', precision, scale: integer(source.scale, propertyPath(path, 'scale'), 0, Math.min(30, precision)) });
  }
  if ((TEXT_TYPES as readonly string[]).includes(source.kind)) {
    assertProperties(source, ['kind', 'length'], [], path);
    return Object.freeze({ kind: source.kind as CreateTableTextType, length: integer(source.length, propertyPath(path, 'length'), 1, 255) });
  }
  if (source.kind === 'text' || source.kind === 'date' || source.kind === 'boolean' || source.kind === 'json') {
    assertProperties(source, ['kind'], [], path);
    return Object.freeze({ kind: source.kind });
  }
  if ((TEMPORAL_TYPES as readonly string[]).includes(source.kind)) {
    assertProperties(source, ['kind'], ['fractionalSecondsPrecision'], path);
    return Object.freeze(
      source.fractionalSecondsPrecision === undefined
        ? { kind: source.kind as CreateTableTemporalType }
        : {
            kind: source.kind as CreateTableTemporalType,
            fractionalSecondsPrecision: integer(source.fractionalSecondsPrecision, propertyPath(path, 'fractionalSecondsPrecision'), 0, 6),
          },
    );
  }
  fail('invalid_value', propertyPath(path, 'kind'));
}
function column(value: unknown, path: string): CreateTableColumn {
  assertProperties(value, ['name', 'type', 'nullable'], ['autoIncrement'], path);
  const source = value;
  if (typeof source.nullable !== 'boolean') fail('invalid_type', propertyPath(path, 'nullable'));
  if (source.autoIncrement !== undefined && typeof source.autoIncrement !== 'boolean') fail('invalid_type', propertyPath(path, 'autoIncrement'));
  const output: { name: string; type: CreateTableColumnType; nullable: boolean; autoIncrement?: boolean } = {
    name: identifier(source.name, propertyPath(path, 'name')),
    type: columnType(source.type, propertyPath(path, 'type')),
    nullable: source.nullable,
  };
  if (source.autoIncrement === true) output.autoIncrement = true;
  return Object.freeze(output);
}
function columns(value: unknown): readonly CreateTableColumn[] {
  if (!Array.isArray(value)) fail('invalid_type', 'input.columns');
  if (value.length === 0) fail('invalid_value', 'input.columns');
  if (value.length > MAX_CREATE_TABLE_COLUMNS) fail('column_limit_exceeded', 'input.columns');
  const output = value.map((item, index) => column(item, indexPath('input.columns', index)));
  const names = new Set<string>();
  for (const item of output) {
    if (names.has(item.name)) fail('duplicate_column', 'input.columns');
    names.add(item.name);
  }
  return Object.freeze(output);
}
function primaryKey(value: unknown, declaredColumns: readonly CreateTableColumn[]): readonly string[] {
  if (!Array.isArray(value)) fail('invalid_type', 'input.primaryKey');
  if (value.length === 0) fail('invalid_value', 'input.primaryKey');
  if (value.length > MAX_CREATE_TABLE_COLUMNS) fail('column_limit_exceeded', 'input.primaryKey');
  const declared = new Set(declaredColumns.map((item) => item.name));
  const used = new Set<string>();
  const output = value.map((item, index) => {
    const name = identifier(item, indexPath('input.primaryKey', index));
    if (used.has(name)) fail('duplicate_primary_key', 'input.primaryKey');
    if (!declared.has(name)) fail('primary_key_invalid', indexPath('input.primaryKey', index));
    used.add(name);
    return name;
  });
  return Object.freeze(output);
}
function validateAutoIncrement(columns: readonly CreateTableColumn[], primaryKey: readonly string[]): void {
  const found = columns.filter((item) => item.autoIncrement === true);
  if (found.length > 1) fail('auto_increment_invalid', 'input.columns');
  const item = found[0];
  if (
    item !== undefined &&
    (item.type.kind !== 'integer' || item.nullable || !primaryKey.includes(item.name) || (primaryKey.length > 1 && primaryKey[0] !== item.name))
  )
    fail('auto_increment_invalid', 'input.columns');
}
function precheckColumnCardinality(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'columns');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) return;
    const length = Object.getOwnPropertyDescriptor(descriptor.value, 'length')?.value;
    if (typeof length === 'number' && Number.isSafeInteger(length) && length > MAX_CREATE_TABLE_COLUMNS)
      fail('column_limit_exceeded', 'input.columns');
  } catch (error) {
    if (error instanceof CreateTableInputValidationError) throw error;
    fail('invalid_payload', 'input');
  }
}

/** Validates and snapshots a CREATE TABLE request into a deterministic, immutable normal form. */
export function normalizeCreateTableInput(value: unknown): CreateTableInput {
  precheckColumnCardinality(value);
  const payload = payloadSnapshot(value);
  assertProperties(payload, ['schema', 'table', 'columns', 'primaryKey', 'reason'], [], 'input');
  const source = payload;
  const normalizedColumns = columns(source.columns);
  const normalizedPrimaryKey = primaryKey(source.primaryKey, normalizedColumns);
  validateAutoIncrement(normalizedColumns, normalizedPrimaryKey);
  return Object.freeze({
    schema: identifier(source.schema, 'input.schema'),
    table: identifier(source.table, 'input.table'),
    columns: normalizedColumns,
    primaryKey: normalizedPrimaryKey,
    reason: reason(source.reason),
  });
}

/** JSON Schema for the deliberately small, structured MySQL 8.4 v1 surface. */
export function createTableInputJsonSchema(): Record<string, unknown> {
  const id = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_CREATE_TABLE_IDENTIFIER_LENGTH,
    pattern: CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
    not: { pattern: '[`\\"]' },
  };
  const integerType = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'integerType'],
    properties: { kind: { const: 'integer' }, integerType: { enum: INTEGER_TYPES }, unsigned: { type: 'boolean' } },
  };
  const decimalScale = {
    oneOf: Array.from({ length: 65 }, (_, index) => {
      const precision = index + 1;
      return {
        properties: {
          precision: { const: precision },
          scale: { type: 'integer', minimum: 0, maximum: Math.min(30, precision) },
        },
      };
    }),
  };
  const type = {
    oneOf: [
      integerType,
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'precision', 'scale'],
        properties: {
          kind: { const: 'decimal' },
          precision: { type: 'integer', minimum: 1, maximum: 65 },
          scale: { type: 'integer', minimum: 0, maximum: 30 },
        },
        allOf: [decimalScale],
      },
      ...TEXT_TYPES.map((kind) => ({
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'length'],
        properties: { kind: { const: kind }, length: { type: 'integer', minimum: 1, maximum: 255 } },
      })),
      ...(['text', 'date', 'boolean', 'json'] as const).map((kind) => ({
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { const: kind } },
      })),
      ...TEMPORAL_TYPES.map((kind) => ({
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { const: kind }, fractionalSecondsPrecision: { type: 'integer', minimum: 0, maximum: 6 } },
      })),
    ],
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'table', 'columns', 'primaryKey', 'reason'],
    properties: {
      schema: id,
      table: id,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CREATE_TABLE_REASON_LENGTH,
        pattern: `^(?=.*\\S)${CREATE_TABLE_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN.slice(1)}`,
      },
      columns: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CREATE_TABLE_COLUMNS,
        contains: {
          type: 'object',
          required: ['autoIncrement'],
          properties: { autoIncrement: { const: true } },
        },
        minContains: 0,
        maxContains: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type', 'nullable'],
          properties: { name: id, type, nullable: { type: 'boolean' }, autoIncrement: { type: 'boolean' } },
          allOf: [
            {
              if: { required: ['autoIncrement'], properties: { autoIncrement: { const: true } } },
              then: { properties: { nullable: { const: false }, type: integerType } },
            },
          ],
        },
      },
      primaryKey: { type: 'array', minItems: 1, maxItems: MAX_CREATE_TABLE_COLUMNS, uniqueItems: true, items: id },
    },
  };
}
export const CREATE_TABLE_INPUT_JSON_SCHEMA = createTableInputJsonSchema;
