export const MAX_DML_STRING_LENGTH = 8_192;
export const MAX_DML_IDENTIFIER_LENGTH = 64;
export const MAX_DML_REASON_LENGTH = 500;
export const MAX_DML_COLUMNS = 100;
export const MAX_DML_PARAMETERS = 1_000;
export const MAX_DML_ROWS = 100;
export const MAX_DML_PAYLOAD_BYTES = 262_144;
export const MAX_DML_NESTING_DEPTH = 100;

export type DmlScalar = string | number | boolean | null;
export type DmlValue = DmlScalar;
export type DmlRow = Readonly<Record<string, DmlScalar>>;
export type DmlTarget = Readonly<{
  schema: string;
  table: string;
  reason: string;
}>;

export type DmlValidationCode =
  | 'additional_property'
  | 'column_limit_exceeded'
  | 'control_character'
  | 'inconsistent_columns'
  | 'invalid_payload'
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_property'
  | 'parameter_limit_exceeded'
  | 'payload_too_large'
  | 'row_limit_exceeded'
  | 'sparse_array'
  | 'string_too_long'
  | 'unsafe_integer';

export interface DmlValidationIssue {
  readonly code: DmlValidationCode;
  readonly path: string;
  readonly message: string;
}

const SAFE_PATH_PATTERN =
  /^(?:input|value|identifier|reason|schema|table|row|rows|columns|parameters)(?:\[\d+\])?(?:\.(?:schema|table|reason|column|columns|parameters))?(?:\[\d+\])?$/;

const SAFE_MESSAGES: Readonly<Record<DmlValidationCode, string>> = {
  additional_property: 'Additional properties are not accepted.',
  column_limit_exceeded: 'The operation contains too many distinct columns.',
  control_character: 'Control characters are not accepted here.',
  inconsistent_columns: 'Rows must contain the same columns.',
  invalid_payload: 'The payload must be JSON-serializable.',
  invalid_type: 'The value has an unsupported type.',
  invalid_value: 'The value is invalid for this field.',
  missing_property: 'A required property is missing.',
  parameter_limit_exceeded: 'The operation contains too many prepared parameter values.',
  payload_too_large: 'The payload exceeds the 256 KiB limit.',
  row_limit_exceeded: 'The operation must contain between 1 and 100 rows.',
  sparse_array: 'Arrays must be dense and contain no gaps.',
  string_too_long: 'The string exceeds its configured length limit.',
  unsafe_integer: 'Integer precision is unsafe; provide the value as a string instead.',
};

export class DmlInputValidationError extends Error {
  readonly code: DmlValidationCode;
  readonly path: string;

  constructor(code: DmlValidationCode, path: unknown) {
    const safePath = typeof path === 'string' && SAFE_PATH_PATTERN.test(path) ? path : 'input';
    super(`Invalid DML input at ${safePath}: ${SAFE_MESSAGES[code]}`);
    this.name = 'DmlInputValidationError';
    this.code = code;
    this.path = safePath;
  }

  get issue(): DmlValidationIssue {
    return { code: this.code, path: this.path, message: this.message };
  }
}

export { DmlInputValidationError as DmlValidationError };

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function fail(code: DmlValidationCode, path: string): never {
  throw new DmlInputValidationError(code, path);
}

function propertyPath(path: string, property: string): string {
  return typeof path === 'string' && path.length > 0 ? `${path}.${property}` : property;
}

function containerPath(path: unknown): string {
  return typeof path === 'string' && path.length > 0 ? path : 'input';
}

function indexPath(path: unknown, index: number): string {
  return `${containerPath(path)}[${index}]`;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertDenseArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    fail('invalid_type', path);
  }

  const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    fail('sparse_array', path);
  }
}

function assertExactProperties(value: unknown, properties: readonly string[], path: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail('invalid_type', path);
  }

  const ownKeys = Reflect.ownKeys(value);
  const unknownKey = ownKeys.find((key) => typeof key !== 'string' || !properties.includes(key));
  if (unknownKey !== undefined) {
    fail('additional_property', containerPath(path));
  }

  const missingProperty = properties.find((property) => !Object.hasOwn(value, property));
  if (missingProperty !== undefined) {
    fail('missing_property', propertyPath(path, missingProperty));
  }
}

function assertString(value: unknown, path: string, maximum: number): asserts value is string {
  if (typeof value !== 'string') {
    fail('invalid_type', path);
  }

  if (unicodeLength(value) > maximum) {
    fail('string_too_long', path);
  }
}

function assertNoControlCharacters(value: string, path: string): void {
  if (hasControlCharacters(value)) {
    fail('control_character', path);
  }
}

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

export function isDmlScalar(value: unknown): value is DmlScalar {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && unicodeLength(value) <= MAX_DML_STRING_LENGTH && !hasControlCharacters(value)) ||
    (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
  );
}

export const isDmlValue = isDmlScalar;

export function normalizeDmlValue(value: unknown, path = 'value'): DmlScalar {
  if (typeof value === 'string') {
    if (unicodeLength(value) > MAX_DML_STRING_LENGTH) {
      fail('string_too_long', path);
    }

    assertNoControlCharacters(value, path);

    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('invalid_value', path);
    }

    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('unsafe_integer', path);
    }

    return value;
  }

  if (value === null || typeof value === 'boolean') {
    return value;
  }

  fail('invalid_value', path);
}

export function normalizeDmlIdentifier(value: unknown, path = 'identifier'): string {
  assertString(value, path, MAX_DML_IDENTIFIER_LENGTH);
  if (value.length === 0) {
    fail('invalid_value', path);
  }

  assertNoControlCharacters(value, path);
  return value;
}

export function normalizeDmlReason(value: unknown, path = 'reason'): string {
  if (typeof value !== 'string') {
    fail(value === undefined ? 'missing_property' : 'invalid_type', path);
  }

  assertNoControlCharacters(value, path);
  const normalized = value.trim();
  if (unicodeLength(normalized) < 1) {
    fail('invalid_value', path);
  }

  if (unicodeLength(normalized) > MAX_DML_REASON_LENGTH) {
    fail('string_too_long', path);
  }

  return normalized;
}

function createJsonSnapshot(value: unknown, path: string, activeObjects: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('invalid_payload', containerPath(path));
    }

    return value;
  }

  if (typeof value !== 'object') {
    fail('invalid_payload', containerPath(path));
  }

  if (depth >= MAX_DML_NESTING_DEPTH) {
    fail('invalid_payload', containerPath(path));
  }

  if (activeObjects.has(value)) {
    fail('invalid_payload', containerPath(path));
  }

  activeObjects.add(value);
  try {
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (isArray) {
      if (prototype !== Array.prototype || Object.hasOwn(Array.prototype, 'toJSON') || Object.hasOwn(Object.prototype, 'toJSON')) {
        fail('invalid_payload', containerPath(path));
      }

      return createJsonArraySnapshot(value, path, activeObjects, depth);
    } else {
      if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(Object.prototype, 'toJSON')) {
        fail('invalid_payload', containerPath(path));
      }

      return createJsonObjectSnapshot(value, path, activeObjects, depth);
    }
  } finally {
    activeObjects.delete(value);
  }
}

function jsonValueDescriptor(descriptor: PropertyDescriptor | undefined, path: string): PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    fail('invalid_payload', containerPath(path));
  }

  return descriptor as PropertyDescriptor & { value: unknown };
}

function createJsonObjectSnapshot(value: object, path: string, activeObjects: WeakSet<object>, depth: number): Record<string, unknown> {
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail('invalid_payload', containerPath(path));
    }

    const descriptor = jsonValueDescriptor(Object.getOwnPropertyDescriptor(value, key), path);
    if (key === 'toJSON') {
      fail('invalid_payload', containerPath(path));
    }

    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: createJsonSnapshot(descriptor.value, path, activeObjects, depth + 1),
      writable: true,
    });
  }

  return snapshot;
}

function arrayIndex(key: string): number | undefined {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key ? index : undefined;
}

function createJsonArraySnapshot(value: object, path: string, activeObjects: WeakSet<object>, depth: number): unknown[] {
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_DML_PAYLOAD_BYTES
  ) {
    fail('invalid_payload', containerPath(path));
  }

  const arrayLength = lengthDescriptor.value;
  const snapshot: unknown[] = [];
  Object.setPrototypeOf(snapshot, null);

  for (const key of ownKeys) {
    const index = typeof key === 'string' ? arrayIndex(key) : undefined;
    if (key !== 'length' && (index === undefined || index >= arrayLength)) {
      fail('invalid_payload', containerPath(path));
    }
  }

  for (let index = 0; index < arrayLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      fail('sparse_array', containerPath(path));
    }

    const safeDescriptor = jsonValueDescriptor(descriptor, path);
    snapshot[index] = createJsonSnapshot(safeDescriptor.value, path, activeObjects, depth + 1);
  }

  if (snapshot.length !== arrayLength) {
    fail('sparse_array', containerPath(path));
  }

  return snapshot;
}

type SerializationHookState = Readonly<{
  arrayToJson: PropertyDescriptor | undefined;
  objectToJson: PropertyDescriptor | undefined;
}>;

function captureSerializationHookState(): SerializationHookState {
  return {
    arrayToJson: Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON'),
    objectToJson: Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'),
  };
}

function restoreSerializationHook(target: object, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, 'toJSON');
  } else {
    Object.defineProperty(target, 'toJSON', descriptor);
  }
}

function restoreSerializationHookState(state: SerializationHookState): void {
  restoreSerializationHook(Array.prototype, state.arrayToJson);
  restoreSerializationHook(Object.prototype, state.objectToJson);
}

function assertStructuredCloneable(value: unknown, path: string): void {
  try {
    structuredClone(value);
  } catch {
    fail('invalid_payload', path);
  }
}

function payloadSnapshot(value: unknown, path: string): Readonly<{ value: unknown; bytes: number }> {
  const safePath = containerPath(path);
  const hookState = captureSerializationHookState();

  try {
    const snapshot = createJsonSnapshot(value, safePath, new WeakSet<object>());
    assertStructuredCloneable(value, safePath);
    const serialized = JSON.stringify(snapshot);
    if (serialized === undefined) {
      fail('invalid_payload', safePath);
    }

    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_DML_PAYLOAD_BYTES) {
      fail('payload_too_large', safePath);
    }

    return Object.freeze({ value: snapshot, bytes });
  } catch (error) {
    if (error instanceof DmlInputValidationError) {
      throw error;
    }

    fail('invalid_payload', safePath);
  } finally {
    restoreSerializationHookState(hookState);
  }
}

export function assertDmlPayloadSize(value: unknown, path = ''): number {
  return payloadSnapshot(value, path).bytes;
}

export const validateDmlPayloadSize = assertDmlPayloadSize;

function denseArrayValues(value: unknown, path: string): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      fail('invalid_type', path);
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      fail('sparse_array', path);
    }

    const indexes = keys.map((key) => (typeof key === 'string' ? arrayIndex(key) : undefined));
    if (keys.length !== length || indexes.some((index) => index === undefined || index >= length)) {
      fail('sparse_array', path);
    }

    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('invalid_payload', path);
      }

      values.push(descriptor.value);
    }

    return values;
  } catch (error) {
    if (error instanceof DmlInputValidationError) {
      throw error;
    }

    fail('invalid_payload', path);
  }
}

export function countDmlColumns(...columnGroups: readonly (readonly string[])[]): number {
  const columns = new Set<string>();
  for (const [groupIndex, columnGroup] of columnGroups.entries()) {
    const values = denseArrayValues(columnGroup, `columns[${groupIndex}]`);
    for (const [columnIndex, column] of values.entries()) {
      if (typeof column !== 'string') {
        fail('invalid_type', `columns[${groupIndex}][${columnIndex}]`);
      }

      columns.add(column);
    }
  }

  return columns.size;
}

export function assertDmlColumnCount(columns: number | readonly string[], path = 'columns'): number {
  const count = typeof columns === 'number' ? columns : countDmlColumns(columns);
  if (!Number.isInteger(count) || count < 0) {
    fail('invalid_value', path);
  }

  if (count > MAX_DML_COLUMNS) {
    fail('column_limit_exceeded', path);
  }

  return count;
}

export function countDmlParameters(...parameterGroups: readonly (readonly unknown[])[]): number {
  return parameterGroups.reduce((count, parameterGroup, groupIndex) => {
    return count + denseArrayValues(parameterGroup, `parameters[${groupIndex}]`).length;
  }, 0);
}

export function assertDmlParameterCount(parameters: number | readonly unknown[], path = 'parameters'): number {
  const count = typeof parameters === 'number' ? parameters : denseArrayValues(parameters, path).length;
  if (!Number.isInteger(count) || count < 0) {
    fail('invalid_value', path);
  }

  if (count > MAX_DML_PARAMETERS) {
    fail('parameter_limit_exceeded', path);
  }

  return count;
}

export function normalizeDmlRow(value: unknown, path = 'row'): DmlRow {
  const safePath = containerPath(path);
  const payload = payloadSnapshot(value, safePath);
  const row = normalizeDmlRowWithoutPayloadCheck(payload.value, safePath);
  if (Object.keys(row).length === 0) {
    fail('row_limit_exceeded', propertyPath(safePath, 'columns'));
  }
  assertDmlColumnCount(Object.keys(row), propertyPath(safePath, 'columns'));
  assertDmlParameterCount(Object.values(row), propertyPath(safePath, 'parameters'));
  return row;
}

function normalizeDmlRowWithoutPayloadCheck(value: unknown, path: string): DmlRow {
  if (!isPlainRecord(value)) {
    fail('invalid_type', path);
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    fail('additional_property', path);
  }

  const entries = (keys as string[]).map((column) => {
    const columnPath = propertyPath(path, 'column');
    normalizeDmlIdentifier(column, columnPath);
    return [column, normalizeDmlValue(value[column], columnPath)] as const;
  });

  return Object.fromEntries(entries);
}

export function normalizeDmlRows(value: unknown, path = 'rows'): readonly DmlRow[] {
  const safePath = containerPath(path);
  const payload = payloadSnapshot(value, safePath);
  assertDenseArray(payload.value, safePath);

  const rows = Array.prototype.map.call(payload.value, (row: unknown, index: number) =>
    normalizeDmlRowWithoutPayloadCheck(row, indexPath(safePath, index)),
  ) as DmlRow[];
  if (rows.length === 0 || rows.length > MAX_DML_ROWS) {
    fail('row_limit_exceeded', safePath);
  }
  if (rows.some((row) => Object.keys(row).length === 0)) {
    fail('row_limit_exceeded', propertyPath(safePath, 'columns'));
  }
  const columnGroups = rows.map((row) => Object.keys(row));
  assertDmlColumnCount(countDmlColumns(...columnGroups), propertyPath(safePath, 'columns'));
  assertDmlParameterCount(countDmlParameters(...rows.map((row) => Object.values(row))), propertyPath(safePath, 'parameters'));

  if (rows.length > 0) {
    const firstColumns = Object.keys(rows[0]);
    const firstColumnSet = new Set(firstColumns);
    if (rows.some((row) => Object.keys(row).length !== firstColumns.length || Object.keys(row).some((column) => !firstColumnSet.has(column)))) {
      fail('inconsistent_columns', safePath);
    }
  }

  return rows;
}

export function normalizeDmlTarget(value: unknown, path = ''): DmlTarget {
  const safePath = typeof path === 'string' && path.length > 0 ? path : '';
  const payload = payloadSnapshot(value, safePath);
  assertExactProperties(payload.value, ['schema', 'table', 'reason'], safePath);

  return {
    schema: normalizeDmlIdentifier((payload.value as Record<string, unknown>).schema, propertyPath(safePath, 'schema')),
    table: normalizeDmlIdentifier((payload.value as Record<string, unknown>).table, propertyPath(safePath, 'table')),
    reason: normalizeDmlReason((payload.value as Record<string, unknown>).reason, propertyPath(safePath, 'reason')),
  };
}

export const normalizeDmlInput = normalizeDmlTarget;
