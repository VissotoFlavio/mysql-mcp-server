import { createHash, randomUUID } from 'node:crypto';

import {
  AlterTableAddColumnInputValidationError,
  normalizeAlterTableAddColumnInput,
  type AlterTableAddColumnInput,
} from '../tools/alter-table-add-column-input.js';
import {
  AlterTableAddForeignKeyInputValidationError,
  normalizeAlterTableAddForeignKeyInput,
  type AlterTableAddForeignKeyInput,
} from '../tools/alter-table-add-foreign-key-input.js';
import {
  AlterTableDropForeignKeyInputValidationError,
  normalizeAlterTableDropForeignKeyInput,
  type AlterTableDropForeignKeyInput,
} from '../tools/alter-table-drop-foreign-key-input.js';
import {
  AlterTableModifyColumnInputValidationError,
  normalizeAlterTableModifyColumnInput,
  type AlterTableModifyColumnInput,
} from '../tools/alter-table-modify-column-input.js';
import {
  AlterTableRenameColumnInputValidationError,
  normalizeAlterTableRenameColumnInput,
  type AlterTableRenameColumnInput,
} from '../tools/alter-table-rename-column-input.js';
import { CreateIndexInputValidationError, normalizeCreateIndexInput, type CreateIndexInput } from '../tools/create-index-input.js';
import { CreateTableInputValidationError, normalizeCreateTableInput, type CreateTableInput } from '../tools/create-table-input.js';
import { normalizeCreateUniqueIndexInput, type CreateUniqueIndexInput } from '../tools/create-unique-index-input.js';
import { CreateViewInputValidationError, normalizeCreateViewInput, type CreateViewInput } from '../tools/create-view-input.js';
import { DropIndexInputValidationError, normalizeDropIndexInput, type DropIndexInput } from '../tools/drop-index-input.js';
import { RenameTableInputValidationError, normalizeRenameTableInput, type RenameTableInput } from '../tools/rename-table-input.js';

import { classifyDdlDriverCode } from './ddl-error-codes.js';
import {
  AlterTableModifyColumnMetadataError,
  AlterTableModifyColumnVerificationError,
  DropIndexMetadataError,
  DropIndexVerificationError,
  RenameTableMetadataError,
  AlterTableDropForeignKeyMetadataError,
  CreateViewMetadataError,
} from './metadata.js';
import { ConnectionError, DdlDisabledError, DdlDriverError, DdlResultError, QueryTimeoutError } from './pool.js';
import { DdlPolicyError } from './sql-policy.js';

export type DdlAuditResult = 'succeeded' | 'rejected' | 'failed' | 'indeterminate';
export type DdlAuditOperation =
  | 'create_table'
  | 'create_view'
  | 'create_index'
  | 'create_unique_index'
  | 'drop_index'
  | 'alter_table_drop_foreign_key'
  | 'alter_table_add_column'
  | 'alter_table_add_foreign_key'
  | 'alter_table_modify_column'
  | 'alter_table_rename_column'
  | 'rename_table'
  | 'invalid';
export interface SafeDdlOutcome {
  readonly result: DdlAuditResult;
  readonly code:
    | 'MYSQL_DDL_INVALID_ARGUMENT'
    | 'MYSQL_DDL_DISABLED'
    | 'MYSQL_DDL_FAILED'
    | 'MYSQL_DDL_OUTCOME_UNKNOWN'
    | 'MYSQL_DDL_PERMISSION_DENIED'
    | 'MYSQL_DDL_TABLE_EXISTS'
    | 'MYSQL_DDL_INDEX_EXISTS'
    | 'MYSQL_DDL_DUPLICATE_DATA'
    | 'MYSQL_DDL_COLUMN_EXISTS'
    | 'MYSQL_DDL_LOCK_TIMEOUT'
    | 'MYSQL_DDL_DEADLOCK'
    | 'MYSQL_DDL_STRUCTURE_INVALID'
    | 'MYSQL_DDL_METADATA_INVALID'
    | 'MYSQL_DDL_TABLE_INVALID';
  readonly message: string;
  readonly retryAdvice?: 'VERIFY_STATE_BEFORE_RETRYING';
}
export interface DdlAuditEvent {
  readonly event: 'ddl_attempt';
  readonly phase: 'started' | 'completed';
  readonly timestamp: string;
  readonly operationId: string;
  readonly operation: DdlAuditOperation;
  readonly target: Readonly<{
    schema: string;
    table?: string;
    index?: string;
    constraint?: string;
    column?: string;
    newColumn?: string;
    newTable?: string;
    view?: string;
    sourceTable?: string;
  }>;
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

type NormalizedRequest = Readonly<{
  operation: DdlAuditOperation;
  input:
    | CreateTableInput
    | CreateViewInput
    | CreateIndexInput
    | CreateUniqueIndexInput
    | DropIndexInput
    | AlterTableDropForeignKeyInput
    | AlterTableAddColumnInput
    | AlterTableAddForeignKeyInput
    | AlterTableModifyColumnInput
    | AlterTableRenameColumnInput
    | RenameTableInput
    | null;
}>;
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
  indexExists: { result: 'failed', code: 'MYSQL_DDL_INDEX_EXISTS', message: 'The requested index name or definition already exists.' },
  duplicateData: {
    result: 'failed',
    code: 'MYSQL_DDL_DUPLICATE_DATA',
    message: 'The requested unique index conflicts with existing duplicate data.',
  },
  columnExists: { result: 'failed', code: 'MYSQL_DDL_COLUMN_EXISTS', message: 'The requested column already exists.' },
  metadata: { result: 'failed', code: 'MYSQL_DDL_METADATA_INVALID', message: 'Unable to validate the requested table metadata.' },
  tableInvalid: { result: 'failed', code: 'MYSQL_DDL_TABLE_INVALID', message: 'The source must be an existing base table.' },
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
function hasSafeCode(value: unknown, code: string): boolean {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.value === code;
  } catch {
    return false;
  }
}
function normalizeRequest(request: unknown, expectedOperation?: DdlAuditOperation): NormalizedRequest {
  if (expectedOperation === 'create_view') {
    try {
      return Object.freeze({ operation: 'create_view', input: normalizeCreateViewInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
  if (expectedOperation === 'create_unique_index') {
    try {
      return Object.freeze({ operation: 'create_unique_index', input: normalizeCreateUniqueIndexInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
  if (expectedOperation === 'rename_table') {
    try {
      return Object.freeze({ operation: 'rename_table', input: normalizeRenameTableInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
  if (expectedOperation === 'alter_table_modify_column') {
    try {
      return Object.freeze({ operation: 'alter_table_modify_column', input: normalizeAlterTableModifyColumnInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
  if (expectedOperation === 'alter_table_drop_foreign_key') {
    try {
      return Object.freeze({ operation: 'alter_table_drop_foreign_key', input: normalizeAlterTableDropForeignKeyInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
  if (expectedOperation === 'drop_index') {
    try {
      return Object.freeze({ operation: 'drop_index', input: normalizeDropIndexInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
  try {
    return Object.freeze({ operation: 'create_table', input: normalizeCreateTableInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'create_view', input: normalizeCreateViewInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'create_index', input: normalizeCreateIndexInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'create_unique_index', input: normalizeCreateUniqueIndexInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'drop_index', input: normalizeDropIndexInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'alter_table_drop_foreign_key', input: normalizeAlterTableDropForeignKeyInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'alter_table_add_column', input: normalizeAlterTableAddColumnInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'alter_table_add_foreign_key', input: normalizeAlterTableAddForeignKeyInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'alter_table_modify_column', input: normalizeAlterTableModifyColumnInput(request) });
  } catch {
    /* try the other supported DDL contract */
  }
  try {
    return Object.freeze({ operation: 'alter_table_rename_column', input: normalizeAlterTableRenameColumnInput(request) });
  } catch {
    try {
      return Object.freeze({ operation: 'rename_table', input: normalizeRenameTableInput(request) });
    } catch {
      return INVALID_REQUEST;
    }
  }
}
function canonicalRequest(request: NormalizedRequest): object {
  if (request.input === null) return { operation: 'invalid' };
  const input = request.input;
  const inputWithColumns = input as CreateTableInput | CreateIndexInput | CreateUniqueIndexInput | AlterTableAddForeignKeyInput;
  return {
    operation: request.operation,
    target:
      request.operation === 'create_view'
        ? { schema: input.schema, view: (input as CreateViewInput).view, sourceTable: (input as CreateViewInput).definition.table }
        : { schema: input.schema, table: (input as { table: string }).table },
    reason: input.reason,
    ...(request.operation === 'alter_table_add_column'
      ? { column: (input as AlterTableAddColumnInput).column }
      : request.operation === 'alter_table_rename_column'
        ? { column: (input as AlterTableRenameColumnInput).column, newColumn: (input as AlterTableRenameColumnInput).newColumn }
        : request.operation === 'rename_table'
          ? { newTable: (input as RenameTableInput).newTable }
          : request.operation === 'alter_table_add_foreign_key'
            ? {
                constraint: (input as AlterTableAddForeignKeyInput).constraint,
                columns: (input as AlterTableAddForeignKeyInput).columns,
                referencedTable: (input as AlterTableAddForeignKeyInput).referencedTable,
                referencedColumns: (input as AlterTableAddForeignKeyInput).referencedColumns,
                onDelete: (input as AlterTableAddForeignKeyInput).onDelete,
                onUpdate: (input as AlterTableAddForeignKeyInput).onUpdate,
              }
            : request.operation === 'alter_table_drop_foreign_key'
              ? { constraint: (input as AlterTableDropForeignKeyInput).constraint }
              : request.operation === 'alter_table_modify_column'
                ? {
                    column: (input as AlterTableModifyColumnInput).column,
                    definition: (input as AlterTableModifyColumnInput).definition,
                  }
                : request.operation === 'drop_index'
                  ? { index: (input as DropIndexInput).index }
                  : {
                      columns:
                        request.operation === 'create_view'
                          ? (input as CreateViewInput).definition.columns
                          : inputWithColumns.columns.map((column) =>
                              typeof column === 'string'
                                ? column
                                : { name: column.name, type: column.type, nullable: column.nullable, autoIncrement: column.autoIncrement === true },
                            ),
                    }),
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
      safeInstanceOf(error, CreateViewInputValidationError) ||
      safeInstanceOf(error, CreateIndexInputValidationError) ||
      safeInstanceOf(error, DropIndexInputValidationError) ||
      safeInstanceOf(error, AlterTableAddColumnInputValidationError) ||
      safeInstanceOf(error, AlterTableAddForeignKeyInputValidationError) ||
      safeInstanceOf(error, AlterTableModifyColumnInputValidationError) ||
      safeInstanceOf(error, AlterTableRenameColumnInputValidationError) ||
      safeInstanceOf(error, RenameTableInputValidationError) ||
      safeInstanceOf(error, AlterTableDropForeignKeyInputValidationError) ||
      safeInstanceOf(error, DdlPolicyError) ||
      safeInstanceOf(error, DdlAuditInputError)
    )
      return OUTCOMES.invalid;
    if (safeInstanceOf(error, DdlDisabledError)) return OUTCOMES.disabled;
    if (safeInstanceOf(error, AlterTableModifyColumnVerificationError)) return OUTCOMES.unknown;
    if (safeInstanceOf(error, DropIndexVerificationError)) return OUTCOMES.unknown;
    if (safeInstanceOf(error, DropIndexMetadataError)) {
      const code = (error as DropIndexMetadataError).code;
      return code === 'MYSQL_DDL_METADATA_INVALID'
        ? OUTCOMES.metadata
        : code === 'MYSQL_DDL_TABLE_INVALID'
          ? OUTCOMES.tableInvalid
          : OUTCOMES.structure;
    }
    if (safeInstanceOf(error, AlterTableModifyColumnMetadataError)) {
      const code = (error as AlterTableModifyColumnMetadataError).code;
      return code === 'MYSQL_DDL_METADATA_INVALID'
        ? OUTCOMES.metadata
        : code === 'MYSQL_DDL_TABLE_INVALID'
          ? OUTCOMES.tableInvalid
          : OUTCOMES.structure;
    }
    if (safeInstanceOf(error, RenameTableMetadataError)) {
      const code = (error as RenameTableMetadataError).code;
      return code === 'MYSQL_DDL_METADATA_INVALID'
        ? OUTCOMES.metadata
        : code === 'MYSQL_DDL_TABLE_INVALID'
          ? OUTCOMES.tableInvalid
          : OUTCOMES.tableExists;
    }
    if (safeInstanceOf(error, CreateViewMetadataError)) {
      const code = (error as CreateViewMetadataError).code;
      return code === 'MYSQL_DDL_METADATA_INVALID'
        ? OUTCOMES.metadata
        : code === 'MYSQL_DDL_TABLE_INVALID'
          ? OUTCOMES.tableInvalid
          : code === 'MYSQL_DDL_TABLE_EXISTS'
            ? OUTCOMES.tableExists
            : OUTCOMES.structure;
    }
    if (hasSafeCode(error, 'MYSQL_DDL_TABLE_EXISTS')) return OUTCOMES.tableExists;
    if (safeInstanceOf(error, AlterTableDropForeignKeyMetadataError)) {
      const code = (error as AlterTableDropForeignKeyMetadataError).code;
      return code === 'MYSQL_DDL_METADATA_INVALID'
        ? OUTCOMES.metadata
        : code === 'MYSQL_DDL_TABLE_INVALID'
          ? OUTCOMES.tableInvalid
          : OUTCOMES.structure;
    }
    if (hasSafeCode(error, 'MYSQL_DDL_INDEX_EXISTS')) return OUTCOMES.indexExists;
    if (hasSafeCode(error, 'MYSQL_DDL_DUPLICATE_DATA')) return OUTCOMES.duplicateData;
    if (hasSafeCode(error, 'MYSQL_DDL_COLUMN_EXISTS')) return OUTCOMES.columnExists;
    if (
      hasSafeCode(error, 'MYSQL_DDL_METADATA_INVALID') ||
      hasSafeCode(error, 'MYSQL_DDL_TABLE_INVALID') ||
      hasSafeCode(error, 'MYSQL_DDL_COLUMN_INVALID') ||
      hasSafeCode(error, 'MYSQL_DDL_FOREIGN_KEY_EXISTS') ||
      hasSafeCode(error, 'MYSQL_DDL_FOREIGN_KEY_ORPHANS')
    )
      return OUTCOMES.structure;
    if (safeInstanceOf(error, DdlDriverError)) {
      const classification = classifyDdlDriverCode((error as DdlDriverError).driverCode);
      return classification === 'duplicateData' ? OUTCOMES.duplicateData : classification === undefined ? OUTCOMES.failed : OUTCOMES[classification];
    }
    if (safeInstanceOf(error, DdlResultError)) return submitted ? OUTCOMES.unknown : OUTCOMES.failed;
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
            normalized.operation === 'create_view'
              ? { schema: input.schema, view: (input as CreateViewInput).view, sourceTable: (input as CreateViewInput).definition.table }
              : normalized.operation === 'create_index' || normalized.operation === 'create_unique_index' || normalized.operation === 'drop_index'
                ? {
                    schema: input.schema,
                    table: (input as { table: string }).table,
                    index: (input as CreateIndexInput | CreateUniqueIndexInput | DropIndexInput).index,
                  }
                : normalized.operation === 'rename_table'
                  ? { schema: input.schema, table: (input as { table: string }).table, newTable: (input as RenameTableInput).newTable }
                  : normalized.operation === 'alter_table_drop_foreign_key'
                    ? {
                        schema: input.schema,
                        table: (input as { table: string }).table,
                        constraint: (input as AlterTableDropForeignKeyInput).constraint,
                      }
                    : normalized.operation === 'alter_table_modify_column'
                      ? { schema: input.schema, table: (input as { table: string }).table, column: (input as AlterTableModifyColumnInput).column }
                      : { schema: input.schema, table: (input as { table: string }).table },
          ),
    reason: input?.reason ?? '[invalid]',
    columnCount:
      input === null
        ? null
        : normalized.operation === 'create_view'
          ? (input as CreateViewInput).definition.columns.length
          : normalized.operation === 'alter_table_add_column'
            ? 1
            : normalized.operation === 'alter_table_rename_column'
              ? 1
              : normalized.operation === 'alter_table_modify_column'
                ? 1
                : normalized.operation === 'rename_table'
                  ? null
                  : normalized.operation === 'drop_index'
                    ? null
                    : normalized.operation === 'alter_table_drop_foreign_key'
                      ? null
                      : (input as CreateTableInput | CreateIndexInput | CreateUniqueIndexInput | AlterTableAddForeignKeyInput).columns.length,
    primaryKeyColumnCount: input !== null && normalized.operation === 'create_table' ? (input as CreateTableInput).primaryKey.length : null,
    requestHash,
  };
}
export function createDdlAuditAttempt(
  request: unknown,
  options: Readonly<{ writer?: DdlAuditWriter; operationId?: () => string; now?: () => number; operation?: DdlAuditOperation }> = {},
): DdlAuditAttempt {
  const operationId = (() => {
    try {
      const value = (options.operationId ?? randomUUID)();
      return typeof value === 'string' && value.length > 0 ? value : randomUUID();
    } catch {
      return randomUUID();
    }
  })();
  const normalized = normalizeRequest(request, options.operation);
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
