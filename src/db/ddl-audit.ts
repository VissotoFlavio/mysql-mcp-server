import { createHash, randomUUID } from 'node:crypto';

import { CreateIndexInputValidationError, normalizeCreateIndexInput, type CreateIndexInput } from '../tools/create-index-input.js';
import { CreateTableInputValidationError, normalizeCreateTableInput, type CreateTableInput } from '../tools/create-table-input.js';

import { classifyDdlDriverCode } from './ddl-error-codes.js';
import { ConnectionError, DdlDisabledError, DdlDriverError, DdlResultError, QueryTimeoutError } from './pool.js';
import { DdlPolicyError } from './sql-policy.js';

export type DdlAuditResult = 'succeeded' | 'rejected' | 'failed' | 'indeterminate';
export type DdlAuditOperation = 'create_table' | 'create_index' | 'invalid';
export interface SafeDdlOutcome {
  readonly result: DdlAuditResult;
  readonly code:
    | 'MYSQL_DDL_INVALID_ARGUMENT'
    | 'MYSQL_DDL_DISABLED'
    | 'MYSQL_DDL_FAILED'
    | 'MYSQL_DDL_OUTCOME_UNKNOWN'
    | 'MYSQL_DDL_PERMISSION_DENIED'
    | 'MYSQL_DDL_TABLE_EXISTS'
    | 'MYSQL_DDL_LOCK_TIMEOUT'
    | 'MYSQL_DDL_DEADLOCK'
    | 'MYSQL_DDL_STRUCTURE_INVALID';
  readonly message: string;
  readonly retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING';
}
export interface DdlAuditEvent {
  readonly event: 'ddl_attempt';
  readonly phase: 'started' | 'completed';
  readonly timestamp: string;
  readonly operationId: string;
  readonly operation: DdlAuditOperation;
  readonly target: Readonly<{ schema: string; table: string; index?: string }>;
  readonly reason: string;
  readonly columnCount: number | null;
  readonly primaryKeyColumnCount: number | null;
  readonly durationMs: number | null;
  readonly result: DdlAuditResult | null;
  readonly code: SafeDdlOutcome['code'] | null;
  readonly retryAdvice: SafeDdlOutcome['retryAdvice'] | null;
  readonly requestHash: string;
}
export type DdlAuditWriter = (line: string) => void;
export class DdlAuditInputError extends Error {
  readonly code = 'MYSQL_DDL_INVALID_ARGUMENT';
  constructor() {
    super('The DDL audit metadata is invalid.');
    this.name = 'DdlAuditInputError';
  }
}
export interface DdlAuditAttempt {
  readonly operationId: string;
  readonly requestHash: string;
  markSubmitted(): void;
  emit(outcome?: Readonly<{ error?: unknown }>): DdlAuditEvent;
}

type NormalizedRequest = Readonly<{ operation: DdlAuditOperation; input: CreateTableInput | CreateIndexInput | null }>;
const INVALID_REQUEST: NormalizedRequest = Object.freeze({ operation: 'invalid', input: null });
const DEFAULT_WRITER: DdlAuditWriter = (line) => process.stderr.write(`${line}\n`);
const OUTCOMES = {
  invalid: { result: 'rejected', code: 'MYSQL_DDL_INVALID_ARGUMENT', message: 'The DDL request is invalid.' },
  disabled: { result: 'rejected', code: 'MYSQL_DDL_DISABLED', message: 'DDL execution is disabled.' },
  failed: { result: 'failed', code: 'MYSQL_DDL_FAILED', message: 'The DDL operation failed.' },
  unknown: {
    result: 'indeterminate',
    code: 'MYSQL_DDL_OUTCOME_UNKNOWN',
    message: 'The DDL outcome is unknown; verify state before retrying.',
    retryAdvice: 'VERIFY_STATE_BEFORE_RETRYING',
  },
  permission: { result: 'rejected', code: 'MYSQL_DDL_PERMISSION_DENIED', message: 'MySQL denied permission for this DDL operation.' },
  tableExists: { result: 'failed', code: 'MYSQL_DDL_TABLE_EXISTS', message: 'The target table already exists.' },
  lockTimeout: { result: 'failed', code: 'MYSQL_DDL_LOCK_TIMEOUT', message: 'The DDL operation exceeded its lock wait.' },
  deadlock: { result: 'failed', code: 'MYSQL_DDL_DEADLOCK', message: 'The DDL operation encountered a deadlock.' },
  structure: { result: 'failed', code: 'MYSQL_DDL_STRUCTURE_INVALID', message: 'MySQL rejected the table structure.' },
} as const satisfies Record<string, SafeDdlOutcome>;

function safeInstanceOf(value: unknown, constructor: { [Symbol.hasInstance](value: unknown): boolean }): boolean {
  try {
    return constructor[Symbol.hasInstance](value);
  } catch {
    return false;
  }
}
function normalizeRequest(request: unknown): NormalizedRequest {
  try {
    return Object.freeze({ operation: 'create_table', input: normalizeCreateTableInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'create_index', input: normalizeCreateIndexInput(request) });
  } catch {
    return INVALID_REQUEST;
  }
}
function canonicalRequest(request: NormalizedRequest): object {
  if (request.input === null) return { operation: 'invalid' };
  const input = request.input;
  return {
    operation: request.operation,
    target: { schema: input.schema, table: input.table },
    reason: input.reason,
    columns: input.columns.map((column) =>
      typeof column === 'string'
        ? column
        : { name: column.name, type: column.type, nullable: column.nullable, autoIncrement: column.autoIncrement === true },
    ),
    ...(request.operation === 'create_table' ? { primaryKey: (input as CreateTableInput).primaryKey } : {}),
  };
}
export function createDdlRequestHash(request: unknown): string {
  const normalized = normalizeRequest(request);
  return createHash('sha256')
    .update(JSON.stringify(canonicalRequest(normalized)), 'utf8')
    .digest('hex');
}
/** Converts internal errors to a restricted DDL outcome without inspecting messages. */
export function toSafeDdlOutcome(error: unknown, submitted = false): SafeDdlOutcome {
  try {
    if (
      safeInstanceOf(error, CreateTableInputValidationError) ||
      safeInstanceOf(error, CreateIndexInputValidationError) ||
      safeInstanceOf(error, DdlPolicyError) ||
      safeInstanceOf(error, DdlAuditInputError)
    )
      return OUTCOMES.invalid;
    if (safeInstanceOf(error, DdlDisabledError)) return OUTCOMES.disabled;
    if (safeInstanceOf(error, DdlDriverError)) {
      const classification = classifyDdlDriverCode((error as DdlDriverError).driverCode);
      return classification === undefined ? OUTCOMES.failed : OUTCOMES[classification];
    }
    if (safeInstanceOf(error, DdlResultError)) return OUTCOMES.failed;
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
  requestHash: string,
): Omit<DdlAuditEvent, 'phase' | 'timestamp' | 'durationMs' | 'result' | 'code' | 'retryAdvice'> {
  const input = normalized.input;
  return {
    event: 'ddl_attempt',
    operationId,
    operation: normalized.operation,
    target:
      input === null
        ? Object.freeze({ schema: '[invalid]', table: '[invalid]' })
        : Object.freeze(
            normalized.operation === 'create_index'
              ? { schema: input.schema, table: input.table, index: (input as CreateIndexInput).index }
              : { schema: input.schema, table: input.table },
          ),
    reason: input?.reason ?? '[invalid]',
    columnCount: input?.columns.length ?? null,
    primaryKeyColumnCount: input !== null && normalized.operation === 'create_table' ? (input as CreateTableInput).primaryKey.length : null,
    requestHash,
  };
}
export function createDdlAuditAttempt(
  request: unknown,
  options: Readonly<{ writer?: DdlAuditWriter; operationId?: () => string; now?: () => number }> = {},
): DdlAuditAttempt {
  const operationId = (() => {
    try {
      const value = (options.operationId ?? randomUUID)();
      return typeof value === 'string' && value.length > 0 ? value : randomUUID();
    } catch {
      return randomUUID();
    }
  })();
  const normalized = normalizeRequest(request);
  const requestHash = createHash('sha256')
    .update(JSON.stringify(canonicalRequest(normalized)), 'utf8')
    .digest('hex');
  const writer = options.writer ?? DEFAULT_WRITER;
  const now = options.now ?? Date.now;
  const startedAt = safeNow(now);
  writer(
    JSON.stringify({
      ...baseEvent(normalized, operationId, requestHash),
      phase: 'started',
      timestamp: safeTimestamp(startedAt),
      durationMs: null,
      result: null,
      code: null,
      retryAdvice: null,
    } satisfies DdlAuditEvent),
  );
  let submitted = false;
  let emitted = false;
  return Object.freeze({
    operationId,
    requestHash,
    markSubmitted() {
      if (emitted) throw new DdlAuditInputError();
      submitted = true;
    },
    emit(outcome: Readonly<{ error?: unknown }> = {}) {
      if (emitted) throw new DdlAuditInputError();
      emitted = true;
      const safeOutcome =
        normalized.input === null
          ? OUTCOMES.invalid
          : outcome.error !== undefined
            ? toSafeDdlOutcome(outcome.error, submitted)
            : submitted
              ? undefined
              : OUTCOMES.invalid;
      const finishedAt = safeNow(now);
      const event: DdlAuditEvent = Object.freeze({
        ...baseEvent(normalized, operationId, requestHash),
        phase: 'completed',
        timestamp: safeTimestamp(finishedAt),
        durationMs: Math.max(0, finishedAt - startedAt),
        result: safeOutcome?.result ?? 'succeeded',
        code: safeOutcome?.code ?? null,
        retryAdvice: safeOutcome !== undefined && 'retryAdvice' in safeOutcome ? (safeOutcome.retryAdvice ?? null) : null,
      });
      try {
        writer(JSON.stringify(event));
      } catch {
        /* the execution outcome remains intact after audit completion failure */
      }
      return event;
    },
  });
}
