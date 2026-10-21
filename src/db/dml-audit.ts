import { createHash, randomUUID } from 'node:crypto';

import { DmlInputValidationError, normalizeDmlIdentifier, normalizeDmlReason } from '../tools/dml-input.js';

import { classifyDmlDriverCode } from './dml-error-codes.js';
import { DmlMetadataError } from './metadata.js';
import { ConnectionError, DmlDisabledError, DmlDriverError, QueryTimeoutError } from './pool.js';
import { DmlPolicyError } from './sql-policy.js';

export type DmlOperation = 'insert' | 'update' | 'delete';
export type DmlAuditResult = 'succeeded' | 'rejected' | 'failed' | 'indeterminate';
export type DmlAuditOperation = DmlOperation | 'invalid';

export interface DmlAuditFilterShape {
  readonly column: string;
  readonly operator: string;
  readonly valueCount: number;
}
/** Values and filter values are intentionally absent from the audit contract. */
export interface DmlAuditRequest {
  readonly operation: DmlOperation;
  readonly target: Readonly<{ schema: string; table: string }>;
  readonly reason: string;
  readonly limit: number;
  readonly suppliedCount: number;
  readonly columns?: readonly string[];
  readonly filters?: readonly DmlAuditFilterShape[];
}
export interface SafeDmlOutcome {
  readonly result: DmlAuditResult;
  readonly code:
    | 'MYSQL_DML_INVALID_ARGUMENT'
    | 'MYSQL_DML_INCOMPATIBLE_OBJECT'
    | 'MYSQL_DML_DISABLED'
    | 'MYSQL_CONSTRAINT_VIOLATION'
    | 'MYSQL_DUPLICATE_KEY'
    | 'MYSQL_FOREIGN_KEY_VIOLATION'
    | 'MYSQL_QUERY_TIMEOUT'
    | 'MYSQL_CONNECTION_FAILED'
    | 'MYSQL_PERMISSION_DENIED';
  readonly message: string;
  readonly retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING';
}
export interface DmlAuditEvent {
  readonly event: 'dml_attempt';
  readonly operationId: string;
  readonly operation: DmlAuditOperation;
  readonly target: Readonly<{ schema: string; table: string }>;
  readonly reason: string;
  readonly requestedLimit: number | null;
  readonly suppliedCount: number | null;
  readonly affectedCount: number | null;
  readonly durationMs: number;
  readonly result: DmlAuditResult;
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
  suppliedCount: number | null;
  columns: readonly string[];
  filters: readonly Readonly<{ column: string; operator: string; valueCount: number }>[];
  invalid: boolean;
}>;

const DEFAULT_WRITER: DmlAuditWriter = (line) => process.stderr.write(`${line}\n`);
const INVALID_REQUEST: NormalizedRequest = Object.freeze({
  operation: 'invalid',
  target: Object.freeze({ schema: '[invalid]', table: '[invalid]' }),
  reason: '[invalid]',
  limit: null,
  suppliedCount: null,
  columns: Object.freeze([]),
  filters: Object.freeze([]),
  invalid: true,
});
const OPERATION_SET = new Set<DmlOperation>(['insert', 'update', 'delete']);
const SAFE_FILTER_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'is_not_null']);

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function normalizeColumns(columns: unknown): readonly string[] {
  if (columns === undefined) return [];
  if (!Array.isArray(columns)) throw new DmlAuditInputError();
  return Object.freeze(columns.map((column) => normalizeDmlIdentifier(column, 'identifier')).sort());
}
function normalizeFilters(filters: unknown): readonly Readonly<{ column: string; operator: string; valueCount: number }>[] {
  if (filters === undefined) return [];
  if (!Array.isArray(filters)) throw new DmlAuditInputError();
  return Object.freeze(
    filters
      .map((filter) => {
        if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) throw new DmlAuditInputError();
        const { column, operator, valueCount } = filter as DmlAuditFilterShape;
        if (typeof operator !== 'string' || !SAFE_FILTER_OPERATORS.has(operator) || !safeInteger(valueCount)) throw new DmlAuditInputError();
        return Object.freeze({ column: normalizeDmlIdentifier(column, 'identifier'), operator, valueCount });
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}
function normalizeRequest(request: unknown): NormalizedRequest {
  try {
    if (typeof request !== 'object' || request === null) return INVALID_REQUEST;
    const value = request as DmlAuditRequest;
    if (
      !OPERATION_SET.has(value.operation) ||
      typeof value.target !== 'object' ||
      value.target === null ||
      !safeInteger(value.limit) ||
      !safeInteger(value.suppliedCount)
    )
      return INVALID_REQUEST;
    return Object.freeze({
      operation: value.operation,
      target: Object.freeze({
        schema: normalizeDmlIdentifier(value.target.schema, 'identifier'),
        table: normalizeDmlIdentifier(value.target.table, 'identifier'),
      }),
      reason: normalizeDmlReason(value.reason, 'reason'),
      limit: value.limit,
      suppliedCount: value.suppliedCount,
      columns: normalizeColumns(value.columns),
      filters: normalizeFilters(value.filters),
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
      .sort()
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
function safeProperty(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}
function driverCode(error: unknown): string | undefined {
  const code = safeProperty(error, 'driverCode');
  return typeof code === 'string' ? code : undefined;
}

function snapshotEmitOutcome(value: unknown): Readonly<{ affectedCount: unknown; error: unknown; invalid: boolean }> {
  if (value === undefined) {
    return { affectedCount: undefined, error: undefined, invalid: false };
  }

  try {
    if (typeof value !== 'object' || value === null) {
      return { affectedCount: undefined, error: undefined, invalid: true };
    }
    return { affectedCount: (value as { affectedCount?: unknown }).affectedCount, error: (value as { error?: unknown }).error, invalid: false };
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
  constraint: { result: 'failed', code: 'MYSQL_CONSTRAINT_VIOLATION', message: 'The DML operation violates a database constraint.' },
  duplicate: { result: 'failed', code: 'MYSQL_DUPLICATE_KEY', message: 'The DML operation conflicts with an existing key.' },
  foreignKey: { result: 'failed', code: 'MYSQL_FOREIGN_KEY_VIOLATION', message: 'The DML operation violates a foreign-key constraint.' },
  timeout: {
    result: 'indeterminate',
    code: 'MYSQL_QUERY_TIMEOUT',
    message: 'The DML attempt timed out after submission; verify state before retrying.',
    retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
  },
  connection: {
    result: 'indeterminate',
    code: 'MYSQL_CONNECTION_FAILED',
    message: 'The DML connection failed after submission; verify state before retrying.',
    retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
  },
  permission: { result: 'rejected', code: 'MYSQL_PERMISSION_DENIED', message: 'MySQL denied permission for this DML operation.' },
} as const satisfies Record<string, SafeDmlOutcome>;
function submittedConnectionOutcome(submitted: boolean, timeout: boolean): SafeDmlOutcome {
  const value = timeout ? OUTCOMES.timeout : OUTCOMES.connection;
  return submitted
    ? value
    : {
        ...value,
        result: 'failed',
        retryAdvice: undefined,
        message: timeout ? 'The DML attempt timed out.' : 'Unable to execute the DML operation.',
      };
}
/** Converts errors to stable outcomes without reading messages or unsafe prototypes. */
export function toSafeDmlOutcome(error: unknown, submitted = false): SafeDmlOutcome {
  try {
    if (safeInstanceOf(error, DmlInputValidationError) || safeInstanceOf(error, DmlPolicyError) || safeInstanceOf(error, DmlAuditInputError))
      return OUTCOMES.invalid;
    if (safeInstanceOf(error, DmlMetadataError)) return OUTCOMES.incompatible;
    if (safeInstanceOf(error, DmlDisabledError)) return OUTCOMES.disabled;
    if (safeInstanceOf(error, QueryTimeoutError)) return submittedConnectionOutcome(submitted, true);
    if (safeInstanceOf(error, DmlDriverError)) {
      const classification = classifyDmlDriverCode(driverCode(error));
      if (classification === 'permission' || classification === 'duplicate' || classification === 'foreignKey' || classification === 'constraint') {
        return OUTCOMES[classification];
      }
    }
    if (safeInstanceOf(error, ConnectionError)) return submittedConnectionOutcome(submitted, false);
  } catch {
    /* adversarial errors must not prevent a safe response */
  }
  return submittedConnectionOutcome(submitted, false);
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
  const startedAt = now();
  let submitted = false;
  let emitted = false;
  return Object.freeze({
    operationId,
    requestHash: hash,
    markSubmitted() {
      if (!emitted) submitted = true;
    },
    emit(outcome: Readonly<{ affectedCount?: number; error?: unknown }> = {}) {
      const snapshot = snapshotEmitOutcome(outcome);
      if (emitted) throw new DmlAuditInputError();
      emitted = true;
      const safeOutcome: SafeDmlOutcome | undefined =
        normalized.invalid || snapshot.invalid || (snapshot.affectedCount !== undefined && !safeInteger(snapshot.affectedCount))
          ? OUTCOMES.invalid
          : snapshot.error === undefined
            ? undefined
            : toSafeDmlOutcome(snapshot.error, submitted);
      const event: DmlAuditEvent = Object.freeze({
        event: 'dml_attempt',
        operationId,
        operation: normalized.operation,
        target: normalized.target,
        reason: normalized.reason,
        requestedLimit: normalized.limit,
        suppliedCount: normalized.suppliedCount,
        affectedCount: safeInteger(snapshot.affectedCount) ? snapshot.affectedCount : null,
        durationMs: Math.max(0, now() - startedAt),
        result: safeOutcome?.result ?? 'succeeded',
        code: safeOutcome?.code ?? null,
        retryAdvice: safeOutcome?.retryAdvice ?? null,
        requestHash: hash,
      });
      writer(JSON.stringify(event));
      return event;
    },
  });
}
