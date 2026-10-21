import {
  DmlInputValidationError,
  MAX_DML_COLUMNS,
  assertDmlColumnCount,
  assertDmlParameterCount,
  normalizeDmlIdentifier,
  normalizeDmlReason,
  normalizeDmlValue,
  type DmlScalar,
  type DmlTarget,
} from '../tools/dml-input.js';

export type DmlComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
export type DmlNullOperator = 'is_null' | 'is_not_null';
export type DmlFilterOperator = DmlComparisonOperator | 'in' | DmlNullOperator;

export type DmlFilter =
  | Readonly<{ column: string; operator: DmlComparisonOperator; value: Exclude<DmlScalar, null> }>
  | Readonly<{ column: string; operator: 'in'; values: readonly Exclude<DmlScalar, null>[] }>
  | Readonly<{ column: string; operator: DmlNullOperator }>;

export interface DmlBuilderInput {
  readonly target: DmlTarget;
  readonly filters: readonly DmlFilter[];
  readonly limit: number;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
}

export interface UpdateDmlBuilderInput extends DmlBuilderInput {
  readonly values: Readonly<Record<string, DmlScalar>>;
}

export type DeleteDmlBuilderInput = DmlBuilderInput;

export interface BuiltDmlStatement {
  readonly sql: string;
  readonly values: readonly DmlScalar[];
}

/**
 * Bounded-DML policy: reject untrusted collection sizes before enumerating keys,
 * then enforce the shared prepared-parameter ceiling during normalization.
 */
export const MAX_DML_FILTERS = 100;
/** Bounds placeholders contributed by one `in` predicate before its values are materialized. */
export const MAX_DML_FILTER_IN_VALUES = 100;
/** Limits the number of rows an UPDATE or DELETE statement may affect. */
export const MAX_DML_LIMIT = 100;

type NormalizedFilter =
  | Readonly<{ column: string; operator: DmlComparisonOperator; values: readonly [Exclude<DmlScalar, null>] }>
  | Readonly<{ column: string; operator: 'in'; values: readonly Exclude<DmlScalar, null>[] }>
  | Readonly<{ column: string; operator: DmlNullOperator; values: readonly [] }>;

const COMPARISON_SQL: Readonly<Record<DmlComparisonOperator, string>> = Object.freeze({
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
});

function fail(code: DmlInputValidationError['code'], path = 'input'): never {
  throw new DmlInputValidationError(code, path);
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

function ownDataEntries(value: unknown, path: string): readonly (readonly [string, unknown])[] {
  if (!isPlainRecord(value)) {
    fail('invalid_type', path);
  }

  try {
    return Reflect.ownKeys(value).map((key) => {
      if (typeof key !== 'string') {
        fail('additional_property', path);
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('invalid_payload', path);
      }

      return [key, descriptor.value] as const;
    });
  } catch (error) {
    if (error instanceof DmlInputValidationError) {
      throw error;
    }
    fail('invalid_payload', path);
  }
}

function exactDataRecord(value: unknown, properties: readonly string[], path: string): Readonly<Record<string, unknown>> {
  const entries = ownDataEntries(value, path);
  const keys = entries.map(([key]) => key);
  if (keys.some((key) => !properties.includes(key))) {
    fail('additional_property', path);
  }
  const missingProperty = properties.find((property) => !keys.includes(property));
  if (missingProperty !== undefined) {
    fail('missing_property', path);
  }

  return Object.fromEntries(entries);
}

function denseArray(value: unknown, path: string, maximumLength?: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail('invalid_type', path);
  }

  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(length) || length < 0) {
      fail('sparse_array', path);
    }
    if (maximumLength !== undefined && length > maximumLength) {
      fail('invalid_value', path);
    }

    const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
    if (keys.length !== length || keys.some((key, index) => key !== String(index))) {
      fail('sparse_array', path);
    }

    return Array.from({ length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('invalid_payload', path);
      }
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof DmlInputValidationError) {
      throw error;
    }
    fail('invalid_payload', path);
  }
}

function normalizedColumns(value: unknown, path: string): readonly string[] {
  const columns = denseArray(value, path, MAX_DML_COLUMNS).map((column) => normalizeDmlIdentifier(column, path));
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    fail('invalid_value', path);
  }
  assertDmlColumnCount(columns.length, path);
  return columns;
}

function validateLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_DML_LIMIT) {
    fail('invalid_value', 'input');
  }
  return value;
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function escapeTarget(target: DmlTarget): string {
  const value = exactDataRecord(target, ['schema', 'table', 'reason'], 'input');
  normalizeDmlReason(value.reason, 'reason');
  return `${escapeIdentifier(normalizeDmlIdentifier(value.schema, 'identifier'))}.${escapeIdentifier(normalizeDmlIdentifier(value.table, 'identifier'))}`;
}

function assertKnownColumn(column: unknown, catalog: ReadonlySet<string>): string {
  const normalized = normalizeDmlIdentifier(column, 'identifier');
  if (!catalog.has(normalized)) {
    fail('invalid_value', 'input');
  }
  return normalized;
}

function normalizeNonNullScalar(value: unknown): Exclude<DmlScalar, null> {
  const normalized = normalizeDmlValue(value, 'value');
  if (normalized === null) {
    fail('invalid_value', 'input');
  }
  return normalized;
}

function normalizeFilter(value: unknown, catalog: ReadonlySet<string>): NormalizedFilter {
  const base = Object.fromEntries(ownDataEntries(value, 'input'));
  const operator = base.operator;
  if (typeof operator !== 'string') {
    fail('invalid_value', 'input');
  }

  const column = assertKnownColumn(base.column, catalog);
  if (Object.hasOwn(COMPARISON_SQL, operator)) {
    const filter = exactDataRecord(value, ['column', 'operator', 'value'], 'input');
    const values = Object.freeze([normalizeNonNullScalar(filter.value)]) as readonly [Exclude<DmlScalar, null>];
    return Object.freeze({ column, operator: operator as DmlComparisonOperator, values });
  }

  if (operator === 'in') {
    const filter = exactDataRecord(value, ['column', 'operator', 'values'], 'input');
    const values = denseArray(filter.values, 'input', MAX_DML_FILTER_IN_VALUES).map(normalizeNonNullScalar);
    if (values.length === 0) {
      fail('invalid_value', 'input');
    }
    return Object.freeze({ column, operator, values: Object.freeze(values) });
  }

  if (operator === 'is_null' || operator === 'is_not_null') {
    exactDataRecord(value, ['column', 'operator'], 'input');
    return Object.freeze({ column, operator, values: Object.freeze([]) as readonly [] });
  }

  fail('invalid_value', 'input');
}

function normalizeFilters(value: unknown, catalog: ReadonlySet<string>, startingParameterCount = 0): readonly NormalizedFilter[] {
  const rawFilters = denseArray(value, 'input', MAX_DML_FILTERS);
  if (rawFilters.length === 0) {
    fail('invalid_value', 'input');
  }

  let parameterCount = startingParameterCount;
  assertDmlParameterCount(parameterCount);
  const filters: NormalizedFilter[] = [];
  for (const rawFilter of rawFilters) {
    const filter = normalizeFilter(rawFilter, catalog);
    parameterCount += filter.values.length;
    assertDmlParameterCount(parameterCount);
    filters.push(filter);
  }
  return filters;
}

function compileFilters(filters: readonly NormalizedFilter[]): Readonly<{ sql: string; values: readonly DmlScalar[] }> {
  const values: DmlScalar[] = [];
  const predicates = filters.map((filter) => {
    const column = escapeIdentifier(filter.column);
    if (filter.operator === 'in') {
      values.push(...filter.values);
      return `${column} IN (${filter.values.map(() => '?').join(', ')})`;
    }
    if (filter.operator === 'is_null') {
      return `${column} IS NULL`;
    }
    if (filter.operator === 'is_not_null') {
      return `${column} IS NOT NULL`;
    }
    const comparison = filter as Extract<NormalizedFilter, Readonly<{ operator: DmlComparisonOperator }>>;
    values.push(comparison.values[0]);
    return `${column} ${COMPARISON_SQL[comparison.operator]} ?`;
  });

  return Object.freeze({ sql: predicates.join(' AND '), values: Object.freeze(values) });
}

function orderByPrimaryKey(value: unknown, catalog: ReadonlySet<string>): string {
  const primaryKey = normalizedColumns(value, 'input').map((column) => assertKnownColumn(column, catalog));
  return primaryKey.map((column) => `${escapeIdentifier(column)} ASC`).join(', ');
}

function immutableStatement(sql: string, values: readonly DmlScalar[]): BuiltDmlStatement {
  assertDmlParameterCount(values);
  return Object.freeze({ sql, values: Object.freeze([...values]) });
}

export function buildUpdateStatement(input: UpdateDmlBuilderInput): BuiltDmlStatement {
  const request = exactDataRecord(input, ['target', 'values', 'filters', 'limit', 'columns', 'primaryKey'], 'input');
  const columns = normalizedColumns(request.columns, 'input');
  const catalog = new Set(columns);
  const assignments = ownDataEntries(request.values, 'input')
    .map(([column, value]) => [assertKnownColumn(column, catalog), normalizeDmlValue(value, 'value')] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (assignments.length === 0) {
    fail('invalid_value', 'input');
  }

  const normalizedFilters = normalizeFilters(request.filters, catalog, assignments.length);
  const filters = compileFilters(normalizedFilters);
  const limit = validateLimit(request.limit);
  const orderBy = orderByPrimaryKey(request.primaryKey, catalog);
  const values = [...assignments.map(([, value]) => value), ...filters.values];
  const setClause = assignments.map(([column]) => `${escapeIdentifier(column)} = ?`).join(', ');

  return immutableStatement(
    `UPDATE ${escapeTarget(request.target as DmlTarget)} SET ${setClause} WHERE ${filters.sql} ORDER BY ${orderBy} LIMIT ${limit}`,
    values,
  );
}

export function buildDeleteStatement(input: DeleteDmlBuilderInput): BuiltDmlStatement {
  const request = exactDataRecord(input, ['target', 'filters', 'limit', 'columns', 'primaryKey'], 'input');
  const columns = normalizedColumns(request.columns, 'input');
  const catalog = new Set(columns);
  const filters = compileFilters(normalizeFilters(request.filters, catalog));
  const limit = validateLimit(request.limit);
  const orderBy = orderByPrimaryKey(request.primaryKey, catalog);

  return immutableStatement(
    `DELETE FROM ${escapeTarget(request.target as DmlTarget)} WHERE ${filters.sql} ORDER BY ${orderBy} LIMIT ${limit}`,
    filters.values,
  );
}
