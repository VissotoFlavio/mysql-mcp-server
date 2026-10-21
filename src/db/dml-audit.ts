import { createHash, randomUUID } from 'node:crypto';

import {
  DmlInputValidationError,
  MAX_DML_COLUMNS,
  MAX_DML_PARAMETERS,
  MAX_DML_ROWS,
  normalizeDmlIdentifier,
  normalizeDmlReason,
  normalizeDmlValue,
} from '../tools/dml-input.js';

import { MAX_DML_FILTER_IN_VALUES, MAX_DML_FILTERS, MAX_DML_LIMIT } from './dml-builder.js';
import type { DeleteDmlBuilderInput, UpdateDmlBuilderInput } from './dml-builder.js';
import { classifyDmlDriverCode } from './dml-error-codes.js';
import { DmlMetadataError } from './metadata.js';
import { ConnectionError, DmlDisabledError, DmlDriverError, QueryTimeoutError } from './pool.js';
import { DmlPolicyError } from './sql-policy.js';

export type DmlOperation = 'insert' | 'update' | 'delete';
export type DmlAuditResult = 'succeeded' | 'rejected' | 'failed' | 'indeterminate';
export type DmlAuditOperation = DmlOperation | 'invalid';
type SafeScalarType = 'string' | 'number' | 'boolean' | 'null';
export interface DmlAuditFilterShape {
  readonly column: string;
  readonly operator: string;
  readonly value?: unknown;
  readonly values?: readonly unknown[];
}
interface DmlAuditRequestBase {
  readonly target: Readonly<{ schema: string; table: string }>;
  readonly reason: string;
  readonly suppliedCount: number;
  readonly columns?: readonly string[];
  readonly filters?: readonly DmlAuditFilterShape[];
  readonly values?: readonly unknown[];
  readonly rowCount?: number;
}
interface DmlAuditInsertRequest {
  readonly operation: 'insert';
  readonly target: Readonly<{ schema: string; table: string }>;
  readonly reason: string;
  readonly rowCount: number;
  readonly columns: readonly string[];
  /** Flattened row values, used only to derive redacted type markers. */
  readonly values: readonly unknown[];
  readonly limit?: null;
}
/** Values and filter values are reduced to type markers before hashing or logging. */
export type DmlAuditRequest =
  | (DmlAuditRequestBase & Readonly<{ operation: 'update' | 'delete'; limit: number }>)
  | DmlAuditInsertRequest
  | Readonly<{ operation: 'update'; input: UpdateDmlBuilderInput }>
  | Readonly<{ operation: 'delete'; input: DeleteDmlBuilderInput }>;
export interface SafeDmlOutcome {
  readonly result: DmlAuditResult;
  readonly code:
    | 'MYSQL_DML_INVALID_ARGUMENT'
    | 'MYSQL_DML_INCOMPATIBLE_OBJECT'
    | 'MYSQL_DML_DISABLED'
    | 'MYSQL_DML_FAILED'
    | 'MYSQL_DML_OUTCOME_UNKNOWN'
    | 'MYSQL_CONSTRAINT_VIOLATION'
    | 'MYSQL_DUPLICATE_KEY'
    | 'MYSQL_FOREIGN_KEY_VIOLATION'
    | 'MYSQL_PERMISSION_DENIED';
  readonly message: string;
  readonly retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING';
}
export interface DmlAuditEvent {
  readonly event: 'dml_attempt';
  readonly phase: 'started' | 'completed';
  readonly timestamp: string;
  readonly operationId: string;
  readonly operation: DmlAuditOperation;
  readonly target: Readonly<{ schema: string; table: string }>;
  readonly reason: string;
  readonly requestedLimit: number | null;
  readonly rowCount: number | null;
  readonly columnCount: number | null;
  readonly filterCount: number | null;
  readonly parameterCount: number | null;
  readonly affectedCount: number | null;
  readonly durationMs: number | null;
  readonly result: DmlAuditResult | null;
  readonly code: SafeDmlOutcome['code'] | null;
  readonly retryAdvice: SafeDmlOutcome['retryAdvice'] | null;
  readonly requestHash: string;
}
export type DmlAuditWriter = (line: string) => void;
export class DmlAuditInputError extends Error {
  readonly code = 'MYSQL_DML_INVALID_ARGUMENT';
  constructor() {
    super('The DML audit metadata is invalid.');
    this.name = 'DmlAuditInputError';
  }
}
export interface DmlAuditAttempt {
  readonly operationId: string;
  readonly requestHash: string;
  markSubmitted(): void;
  emit(outcome?: Readonly<{ affectedCount?: number; error?: unknown }>): DmlAuditEvent;
}
type NormalizedRequest = Readonly<{
  operation: DmlAuditOperation;
  target: Readonly<{ schema: string; table: string }>;
  reason: string;
  limit: number | null;
  rowCount: number | null;
  parameterCount: number | null;
  columns: readonly string[];
  primaryKey: readonly string[];
  assignmentColumns: readonly string[];
  filters: readonly Readonly<{ column: string; operator: string; valueCount: number; valueTypes: readonly SafeScalarType[] }>[];
  valueTypes: readonly SafeScalarType[];
  invalid: boolean;
}>;
const DEFAULT_WRITER: DmlAuditWriter = (line) => process.stderr.write(`${line}\n`);
const INVALID_REQUEST: NormalizedRequest = Object.freeze({
  operation: 'invalid',
  target: Object.freeze({ schema: '[invalid]', table: '[invalid]' }),
  reason: '[invalid]',
  limit: null,
  rowCount: null,
  parameterCount: null,
  columns: Object.freeze([]),
  primaryKey: Object.freeze([]),
  assignmentColumns: Object.freeze([]),
  filters: Object.freeze([]),
  valueTypes: Object.freeze([]),
  invalid: true,
});
const OPERATION_SET = new Set<DmlOperation>(['insert', 'update', 'delete']);
const SAFE_FILTER_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'is_not_null']);
function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function scalarType(value: unknown): SafeScalarType {
  const normalized = normalizeDmlValue(value, 'value');
  return normalized === null ? 'null' : (typeof normalized as Exclude<SafeScalarType, 'null'>);
}
function nonNullScalarType(value: unknown): SafeScalarType {
  const type = scalarType(value);
  if (type === 'null') throw new DmlAuditInputError();
  return type;
}
type OwnData = Readonly<{ present: boolean; value: unknown }>;
function ownData(value: object, key: string, required = false): OwnData {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) throw new DmlAuditInputError();
    return { present: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, 'value')) throw new DmlAuditInputError();
  return { present: true, value: descriptor.value };
}
function snapshotArray(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new DmlAuditInputError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.enumerable ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximumLength
  )
    throw new DmlAuditInputError();
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new DmlAuditInputError();
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}
function builderAuditRequest(request: object): object | undefined {
  const inputField = ownData(request, 'input');
  if (!inputField.present || typeof inputField.value !== 'object' || inputField.value === null || Array.isArray(inputField.value)) return undefined;
  const operation = ownData(request, 'operation', true).value;
  if (operation !== 'update' && operation !== 'delete') throw new DmlAuditInputError();
  const input = inputField.value;
  const target = ownData(input, 'target', true).value;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) throw new DmlAuditInputError();
  const schema = ownData(target, 'schema', true).value;
  const table = ownData(target, 'table', true).value;
  const reason = ownData(target, 'reason', true).value;
  const columns = snapshotArray(ownData(input, 'columns', true).value, MAX_DML_COLUMNS);
  const normalizedColumns = normalizeColumns(columns);
  const catalog = new Set(normalizedColumns);
  const primaryKey = snapshotArray(ownData(input, 'primaryKey', true).value, MAX_DML_COLUMNS);
  if (primaryKey.length === 0) throw new DmlAuditInputError();
  const normalizedPrimaryKey: string[] = [];
  for (const key of primaryKey) {
    const normalizedKey = normalizeDmlIdentifier(key, 'identifier');
    if (!catalog.has(normalizedKey)) throw new DmlAuditInputError();
    normalizedPrimaryKey.push(normalizedKey);
  }
  const filters = ownData(input, 'filters', true).value;
  const limit = ownData(input, 'limit', true).value;
  if (operation === 'delete')
    return Object.freeze({
      operation,
      target: Object.freeze({ schema, table }),
      reason,
      limit,
      suppliedCount: 0,
      columns,
      primaryKey: Object.freeze(normalizedPrimaryKey),
      assignmentColumns: Object.freeze([]),
      filters,
    });
  const values = ownData(input, 'values', true).value;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new DmlAuditInputError();
  const keys = Object.keys(values);
  if (keys.length === 0 || keys.length > MAX_DML_COLUMNS) throw new DmlAuditInputError();
  const assignments: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      !catalog.has(normalizeDmlIdentifier(key, 'identifier'))
    )
      throw new DmlAuditInputError();
    assignments.push([key, descriptor.value]);
  }
  assignments.sort(([left], [right]) => ordinalCompare(left, right));
  const assignmentValues = Object.freeze(assignments.map(([, value]) => value));
  return Object.freeze({
    operation,
    target: Object.freeze({ schema, table }),
    reason,
    limit,
    suppliedCount: assignmentValues.length,
    columns,
    primaryKey: Object.freeze(normalizedPrimaryKey),
    assignmentColumns: Object.freeze(assignments.map(([key]) => normalizeDmlIdentifier(key, 'identifier'))),
    filters,
    values: assignmentValues,
  });
}
function normalizeValueTypes(values: unknown): readonly SafeScalarType[] {
  if (values === undefined) return Object.freeze([]);
  const source = snapshotArray(values, MAX_DML_PARAMETERS);
  const result: SafeScalarType[] = [];
  for (let index = 0; index < source.length; index += 1) result.push(scalarType(source[index]));
  return Object.freeze(result);
}
function normalizeNonNullValueTypes(values: unknown): readonly SafeScalarType[] {
  const source = snapshotArray(values, MAX_DML_PARAMETERS);
  const result: SafeScalarType[] = [];
  for (let index = 0; index < source.length; index += 1) result.push(nonNullScalarType(source[index]));
  return Object.freeze(result);
}
function normalizeColumns(columns: unknown): readonly string[] {
  if (columns === undefined) return Object.freeze([]);
  const source = snapshotArray(columns, MAX_DML_COLUMNS);
  const normalized: string[] = [];
  for (let index = 0; index < source.length; index += 1) normalized.push(normalizeDmlIdentifier(source[index], 'identifier'));
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) throw new DmlAuditInputError();
  return Object.freeze(normalized.sort(ordinalCompare));
}
function normalizeColumnSequence(columns: unknown): readonly string[] {
  const source = snapshotArray(columns, MAX_DML_COLUMNS);
  const normalized: string[] = [];
  for (let index = 0; index < source.length; index += 1) normalized.push(normalizeDmlIdentifier(source[index], 'identifier'));
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) throw new DmlAuditInputError();
  return Object.freeze(normalized);
}
function normalizeFilters(filters: unknown, catalog: ReadonlySet<string>): NormalizedRequest['filters'] {
  if (filters === undefined) return Object.freeze([]);
  const source = snapshotArray(filters, MAX_DML_FILTERS);
  const normalized: Array<NormalizedRequest['filters'][number]> = [];
  for (let index = 0; index < source.length; index += 1) {
    const filter = source[index];
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) throw new DmlAuditInputError();
    const column = ownData(filter, 'column', true).value;
    const operator = ownData(filter, 'operator', true).value;
    if (typeof operator !== 'string' || !SAFE_FILTER_OPERATORS.has(operator)) throw new DmlAuditInputError();
    const value = ownData(filter, 'value');
    const values = ownData(filter, 'values');
    const hasValue = value.present;
    const hasValues = values.present;
    if (hasValue && hasValues) throw new DmlAuditInputError();
    const valueTypes = hasValue
      ? Object.freeze([nonNullScalarType(value.value)])
      : hasValues
        ? normalizeNonNullValueTypes(values.value)
        : Object.freeze([]);
    if (
      (['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(operator) && (!hasValue || valueTypes.length !== 1)) ||
      (operator === 'in' && (!hasValues || valueTypes.length < 1 || valueTypes.length > MAX_DML_FILTER_IN_VALUES)) ||
      ((operator === 'is_null' || operator === 'is_not_null') && (hasValue || hasValues))
    )
      throw new DmlAuditInputError();
    const normalizedColumn = normalizeDmlIdentifier(column, 'identifier');
    if (!catalog.has(normalizedColumn)) throw new DmlAuditInputError();
    normalized.push(Object.freeze({ column: normalizedColumn, operator, valueCount: valueTypes.length, valueTypes }));
  }
  return Object.freeze(normalized);
}
function normalizeRequest(request: unknown): NormalizedRequest {
  try {
    if (typeof request !== 'object' || request === null) return INVALID_REQUEST;
    const builderRequest = builderAuditRequest(request);
    if (builderRequest !== undefined) return normalizeRequest(builderRequest);
    const operation = ownData(request, 'operation', true).value;
    const target = ownData(request, 'target', true).value;
    const reason = ownData(request, 'reason', true).value;
    const limitField = ownData(request, 'limit');
    const columnsField = ownData(request, 'columns', true);
    const filtersField = ownData(request, 'filters');
    const valuesField = ownData(request, 'values');
    const rowCountField = ownData(request, 'rowCount');
    const primaryKeyField = ownData(request, 'primaryKey');
    const assignmentColumnsField = ownData(request, 'assignmentColumns');
    if (!OPERATION_SET.has(operation as DmlOperation) || typeof target !== 'object' || target === null || Array.isArray(target))
      return INVALID_REQUEST;
    const schema = ownData(target, 'schema', true).value;
    const table = ownData(target, 'table', true).value;
    const columns = normalizeColumns(columnsField.value);
    if (operation === 'insert') {
      if (
        (limitField.present && limitField.value !== null) ||
        filtersField.present ||
        !valuesField.present ||
        !rowCountField.present ||
        !safeInteger(rowCountField.value) ||
        rowCountField.value < 1 ||
        rowCountField.value > MAX_DML_ROWS
      )
        return INVALID_REQUEST;
      const valueTypes = normalizeValueTypes(valuesField.value);
      const parameterCount = valueTypes.length;
      if (parameterCount > MAX_DML_PARAMETERS || parameterCount !== rowCountField.value * columns.length) return INVALID_REQUEST;
      return Object.freeze({
        operation: 'insert',
        target: Object.freeze({
          schema: normalizeDmlIdentifier(schema, 'identifier'),
          table: normalizeDmlIdentifier(table, 'identifier'),
        }),
        reason: normalizeDmlReason(reason, 'reason'),
        limit: null,
        rowCount: rowCountField.value,
        parameterCount,
        columns,
        primaryKey: Object.freeze([]),
        assignmentColumns: Object.freeze([]),
        filters: Object.freeze([]),
        valueTypes,
        invalid: false,
      });
    }
    const suppliedCount = ownData(request, 'suppliedCount', true).value;
    const limit = limitField.value;
    if (
      !safeInteger(suppliedCount) ||
      suppliedCount > MAX_DML_PARAMETERS ||
      !limitField.present ||
      !safeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DML_LIMIT
    )
      return INVALID_REQUEST;
    if (rowCountField.present && !safeInteger(rowCountField.value)) return INVALID_REQUEST;
    const primaryKey = primaryKeyField.present ? normalizeColumnSequence(primaryKeyField.value) : Object.freeze([]);
    const assignmentColumns = assignmentColumnsField.present
      ? snapshotArray(assignmentColumnsField.value, MAX_DML_COLUMNS).length === 0
        ? Object.freeze([])
        : normalizeColumns(assignmentColumnsField.value)
      : Object.freeze([]);
    const filters = filtersField.present ? normalizeFilters(filtersField.value, new Set(columns)) : Object.freeze([]);
    const valueTypes = valuesField.present ? normalizeValueTypes(valuesField.value) : Object.freeze([]);
    if (operation === 'update' && (!valuesField.present || valueTypes.length !== suppliedCount)) return INVALID_REQUEST;
    const filterParameterCount = filters.reduce((total, filter) => total + filter.valueCount, 0);
    const parameterCount = suppliedCount + filterParameterCount;
    if (parameterCount > MAX_DML_PARAMETERS) return INVALID_REQUEST;
    const rowCount = null;
    if (
      (operation === 'update' && (suppliedCount < 1 || !filtersField.present || filters.length === 0)) ||
      (operation === 'delete' &&
        (suppliedCount !== 0 || valuesField.present || !filtersField.present || filters.length === 0 || rowCountField.present)) ||
      rowCountField.present
    )
      return INVALID_REQUEST;
    return Object.freeze({
      operation: operation as DmlOperation,
      target: Object.freeze({
        schema: normalizeDmlIdentifier(schema, 'identifier'),
        table: normalizeDmlIdentifier(table, 'identifier'),
      }),
      reason: normalizeDmlReason(reason, 'reason'),
      limit: limit as number | null,
      rowCount: rowCount as number | null,
      parameterCount,
      columns,
      primaryKey,
      assignmentColumns,
      filters,
      valueTypes,
      invalid: false,
    });
  } catch {
    return INVALID_REQUEST;
  }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort(ordinalCompare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function requestHash(request: NormalizedRequest): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}
export function createDmlRequestHash(request: unknown): string {
  return requestHash(normalizeRequest(request));
}
function safeInstanceOf(value: unknown, constructor: { [Symbol.hasInstance](value: unknown): boolean }): boolean {
  try {
    return constructor[Symbol.hasInstance](value);
  } catch {
    return false;
  }
}
function snapshotEmitOutcome(value: unknown): Readonly<{ affectedCount: unknown; error: unknown; invalid: boolean }> {
  if (value === undefined) return { affectedCount: undefined, error: undefined, invalid: false };
  try {
    if (typeof value !== 'object' || value === null) return { affectedCount: undefined, error: undefined, invalid: true };
    return { affectedCount: ownData(value, 'affectedCount').value, error: ownData(value, 'error').value, invalid: false };
  } catch {
    return { affectedCount: undefined, error: undefined, invalid: true };
  }
}
const OUTCOMES = {
  invalid: { result: 'rejected', code: 'MYSQL_DML_INVALID_ARGUMENT', message: 'The DML request is invalid.' },
  incompatible: {
    result: 'rejected',
    code: 'MYSQL_DML_INCOMPATIBLE_OBJECT',
    message: 'The requested object is incompatible with this DML operation.',
  },
  disabled: { result: 'rejected', code: 'MYSQL_DML_DISABLED', message: 'DML execution is disabled.' },
  failed: { result: 'failed', code: 'MYSQL_DML_FAILED', message: 'The DML operation failed.' },
  unknown: {
    result: 'indeterminate',
    code: 'MYSQL_DML_OUTCOME_UNKNOWN',
    message: 'The DML outcome is unknown; verify state before retrying.',
    retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
  },
  constraint: { result: 'failed', code: 'MYSQL_CONSTRAINT_VIOLATION', message: 'The DML operation violates a database constraint.' },
  duplicate: { result: 'failed', code: 'MYSQL_DUPLICATE_KEY', message: 'The DML operation conflicts with an existing key.' },
  foreignKey: { result: 'failed', code: 'MYSQL_FOREIGN_KEY_VIOLATION', message: 'The DML operation violates a foreign-key constraint.' },
  permission: { result: 'rejected', code: 'MYSQL_PERMISSION_DENIED', message: 'MySQL denied permission for this DML operation.' },
} as const satisfies Record<string, SafeDmlOutcome>;
/** Converts errors to stable outcomes without reading messages or unsafe prototypes. */
export function toSafeDmlOutcome(error: unknown, submitted = false): SafeDmlOutcome {
  try {
    if (safeInstanceOf(error, DmlInputValidationError) || safeInstanceOf(error, DmlPolicyError) || safeInstanceOf(error, DmlAuditInputError))
      return OUTCOMES.invalid;
    if (safeInstanceOf(error, DmlMetadataError)) return OUTCOMES.incompatible;
    if (safeInstanceOf(error, DmlDisabledError)) return OUTCOMES.disabled;
    if (safeInstanceOf(error, DmlDriverError)) {
      const classification = classifyDmlDriverCode((error as DmlDriverError).driverCode);
      return classification === undefined ? OUTCOMES.failed : OUTCOMES[classification];
    }
    if (safeInstanceOf(error, QueryTimeoutError) || safeInstanceOf(error, ConnectionError)) return submitted ? OUTCOMES.unknown : OUTCOMES.failed;
  } catch {
    /* safe fallback */
  }
  return OUTCOMES.failed;
}
function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : Date.now();
  } catch {
    return Date.now();
  }
}
function safeTimestamp(time: number): string {
  try {
    return new Date(time).toISOString();
  } catch {
    return new Date(Date.now()).toISOString();
  }
}
function baseEvent(
  normalized: NormalizedRequest,
  operationId: string,
  hash: string,
): Omit<DmlAuditEvent, 'phase' | 'timestamp' | 'affectedCount' | 'durationMs' | 'result' | 'code' | 'retryAdvice'> {
  return {
    event: 'dml_attempt',
    operationId,
    operation: normalized.operation,
    target: normalized.target,
    reason: normalized.reason,
    requestedLimit: normalized.limit,
    rowCount: normalized.rowCount,
    columnCount: normalized.invalid ? null : normalized.columns.length,
    filterCount: normalized.invalid ? null : normalized.filters.length,
    parameterCount: normalized.parameterCount,
    requestHash: hash,
  };
}
export function createDmlAuditAttempt(
  request: unknown,
  options: Readonly<{ writer?: DmlAuditWriter; operationId?: () => string; now?: () => number }> = {},
): DmlAuditAttempt {
  const operationId = (() => {
    try {
      const value = (options.operationId ?? randomUUID)();
      return typeof value === 'string' && value.length > 0 ? value : randomUUID();
    } catch {
      return randomUUID();
    }
  })();
  const normalized = normalizeRequest(request);
  const hash = requestHash(normalized);
  const writer = options.writer ?? DEFAULT_WRITER;
  const now = options.now ?? Date.now;
  const startedAt = safeNow(now);
  const start: DmlAuditEvent = Object.freeze({
    ...baseEvent(normalized, operationId, hash),
    phase: 'started',
    timestamp: safeTimestamp(startedAt),
    affectedCount: null,
    durationMs: null,
    result: null,
    code: null,
    retryAdvice: null,
  });
  writer(JSON.stringify(start));
  let submitted = false;
  let emitted = false;
  return Object.freeze({
    operationId,
    requestHash: hash,
    markSubmitted() {
      if (emitted) throw new DmlAuditInputError();
      submitted = true;
    },
    emit(outcome: Readonly<{ affectedCount?: number; error?: unknown }> = {}) {
      if (emitted) throw new DmlAuditInputError();
      emitted = true;
      const snapshot = snapshotEmitOutcome(outcome);
      const safeOutcome: SafeDmlOutcome | undefined =
        normalized.invalid || snapshot.invalid || !submitted || (snapshot.affectedCount !== undefined && !safeInteger(snapshot.affectedCount))
          ? OUTCOMES.invalid
          : snapshot.error === undefined
            ? undefined
            : toSafeDmlOutcome(snapshot.error, submitted);
      const finishedAt = safeNow(now);
      const event: DmlAuditEvent = Object.freeze({
        ...baseEvent(normalized, operationId, hash),
        phase: 'completed',
        timestamp: safeTimestamp(finishedAt),
        affectedCount: safeInteger(snapshot.affectedCount) ? snapshot.affectedCount : null,
        durationMs: Math.max(0, finishedAt - startedAt),
        result: safeOutcome?.result ?? 'succeeded',
        code: safeOutcome?.code ?? null,
        retryAdvice: safeOutcome?.retryAdvice ?? null,
      });
      try {
        writer(JSON.stringify(event));
      } catch {
        /* preserve computed outcome */
      }
      return event;
    },
  });
}
