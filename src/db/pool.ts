import type { ExecuteValues } from 'mysql2';
import mysql, { type Pool, type PoolOptions, type QueryResult, type QueryValues } from 'mysql2/promise';

import { loadConnectionConfig, type ConnectionConfig, type Environment, type ReadFile } from '../config.js';
import { normalizeAlterTableAddColumnInput, type AlterTableAddColumnInput } from '../tools/alter-table-add-column-input.js';
import { normalizeAlterTableAddForeignKeyInput, type AlterTableAddForeignKeyInput } from '../tools/alter-table-add-foreign-key-input.js';
import { normalizeAlterTableRenameColumnInput, type AlterTableRenameColumnInput } from '../tools/alter-table-rename-column-input.js';
import { normalizeCreateIndexInput, type CreateIndexInput } from '../tools/create-index-input.js';
import { normalizeCreateTableInput, type CreateTableInput } from '../tools/create-table-input.js';
import { normalizeCreateUniqueIndexInput, type CreateUniqueIndexInput } from '../tools/create-unique-index-input.js';
import { MAX_DML_ROWS } from '../tools/dml-input.js';
import { normalizeRenameTableInput, type RenameTableInput } from '../tools/rename-table-input.js';

import type { DdlAuditAttempt, DdlAuditWriter } from './ddl-audit.js';
import {
  buildAlterTableAddColumnStatement,
  buildAlterTableAddForeignKeyStatement,
  buildAlterTableRenameColumnStatement,
  buildCreateIndexStatement,
  buildCreateTableStatement,
  buildCreateUniqueIndexStatement,
  buildRenameTableStatement,
} from './ddl-builder.js';
import { sanitizeDdlDriverCode } from './ddl-error-codes.js';
import type { DmlAuditAttempt, DmlAuditRequest, DmlAuditWriter } from './dml-audit.js';
import {
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement,
  MAX_DML_LIMIT,
  type DeleteDmlBuilderInput,
  type InsertDmlBuilderInput,
  type UpdateDmlBuilderInput,
} from './dml-builder.js';
import { sanitizeDmlDriverCode } from './dml-error-codes.js';
import {
  assertAlterTableAddColumnSql,
  assertAlterTableAddForeignKeySql,
  assertAlterTableRenameColumnSql,
  assertCreateIndexSql,
  assertCreateUniqueIndexSql,
  assertCreateTableSql,
  assertRenameTableSql,
  assertDmlSql,
  DdlPolicyError,
  DmlPolicyError,
  assertReadOnlySql,
} from './sql-policy.js';

export class ConnectionError extends Error {
  readonly code: string = 'MYSQL_CONNECTION_FAILED';
  readonly submitted: boolean;

  constructor(message: string, submitted = false) {
    super(message);
    this.name = 'ConnectionError';
    this.submitted = submitted;
  }
}

export class QueryTimeoutError extends ConnectionError {
  readonly code = 'MYSQL_QUERY_TIMEOUT';

  constructor(submitted = false) {
    super('MySQL query timed out.', submitted);
    this.name = 'QueryTimeoutError';
  }
}

export class DmlDisabledError extends ConnectionError {
  readonly code = 'MYSQL_DML_DISABLED';

  constructor() {
    super('DML execution is disabled.');
    this.name = 'DmlDisabledError';
  }
}

export class DdlDisabledError extends ConnectionError {
  readonly code = 'MYSQL_DDL_DISABLED';

  constructor() {
    super('DDL execution is disabled.');
    this.name = 'DdlDisabledError';
  }
}

/** @internal Carries only an allowlisted MySQL classification, never driver text. */
export class DmlDriverError extends ConnectionError {
  readonly driverCode: string | undefined;

  constructor(driverCode: string | undefined, submitted = false) {
    super('Unable to execute the DML statement.', submitted);
    this.name = 'DmlDriverError';
    this.driverCode = driverCode;
  }
}

/** @internal Carries only an allowlisted MySQL classification, never driver text. */
export class DdlDriverError extends ConnectionError {
  readonly driverCode: string | undefined;

  constructor(driverCode: string | undefined, submitted = false) {
    super('Unable to execute the CREATE TABLE statement.', submitted);
    this.name = 'DdlDriverError';
    this.driverCode = driverCode;
  }
}

export class DmlResultError extends ConnectionError {
  readonly code = 'MYSQL_DML_RESULT_INVALID';

  constructor() {
    super('The DML result was invalid.', true);
    this.name = 'DmlResultError';
  }
}

export class DdlResultError extends ConnectionError {
  readonly code = 'MYSQL_DDL_RESULT_INVALID';

  constructor() {
    super('The CREATE TABLE result was invalid.', true);
    this.name = 'DdlResultError';
  }
}

function safeInstanceOf(value: unknown, constructor: { [Symbol.hasInstance](value: unknown): boolean }): boolean {
  try {
    return constructor[Symbol.hasInstance](value);
  } catch {
    return false;
  }
}

export function wasDmlSubmitted(error: unknown): boolean {
  try {
    return safeInstanceOf(error, ConnectionError) && (error as ConnectionError).submitted === true;
  } catch {
    return false;
  }
}

/** Indicates whether a controlled DDL request may have reached MySQL. */
export function wasDdlSubmitted(error: unknown): boolean {
  return wasDmlSubmitted(error);
}

const MYSQL_BIGINT_UNSIGNED_MAX = 18446744073709551615n;
const MYSQL_BIGINT_SIGNED_MIN = -9223372036854775808n;

function safeDriverCode(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }
    for (const key of ['code', 'errno']) {
      try {
        if (!Object.hasOwn(error, key)) continue;
        const sanitized = sanitizeDmlDriverCode((error as Record<string, unknown>)[key]);
        if (sanitized !== undefined) return sanitized;
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeDdlDriverCode(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    for (const key of ['code', 'errno']) {
      try {
        if (!Object.hasOwn(error, key)) continue;
        const sanitized = sanitizeDdlDriverCode((error as Record<string, unknown>)[key]);
        if (sanitized !== undefined) return sanitized;
      } catch {
        continue;
      }
    }
  } catch {
    /* safe fallback */
  }
  return undefined;
}

export interface PoolFactory {
  createPool(options: PoolOptions): Pool;
}

function isQueryTimeout(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return false;
    const code = (error as Record<string, unknown>).code;
    return code === 'PROTOCOL_SEQUENCE_TIMEOUT' || code === 'ETIMEDOUT';
  } catch {
    return false;
  }
}

function isTransportLoss(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return false;
    const code = (error as Record<string, unknown>).code;
    return (
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'EPIPE' ||
      code === 'ENETUNREACH' ||
      code === 'EHOSTUNREACH'
    );
  } catch {
    return false;
  }
}

function normalizeDmlCount(value: unknown, maximum: number | bigint = BigInt(Number.MAX_SAFE_INTEGER)): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number(maximum)) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(maximum)) return Number(value);
  throw new DmlResultError();
}

export function normalizeDmlInsertId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n && value <= MYSQL_BIGINT_UNSIGNED_MAX) return value.toString();
  if (typeof value === 'string') {
    if (value.length > 20) throw new DmlResultError();
    if (/^(0|[1-9][0-9]*)$/.test(value)) {
      const normalized = BigInt(value);
      if (normalized <= MYSQL_BIGINT_UNSIGNED_MAX) return value;
    } else if (/^-[1-9][0-9]*$/.test(value)) {
      const normalized = BigInt(value);
      if (normalized >= MYSQL_BIGINT_SIGNED_MIN) return ((1n << 64n) + normalized).toString();
    }
  }
  throw new DmlResultError();
}

type NormalizedInsertResult = Readonly<{
  affectedRows: number;
  warningStatus: number;
  insertId: string | null;
}>;

function normalizeInsertResult(result: unknown): NormalizedInsertResult {
  try {
    if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'affectedRows') || !Object.hasOwn(result, 'warningStatus')) {
      throw new DmlResultError();
    }
    const affectedRows = (result as Record<string, unknown>).affectedRows;
    const warningStatus = (result as Record<string, unknown>).warningStatus;
    if (
      typeof affectedRows !== 'number' ||
      !Number.isSafeInteger(affectedRows) ||
      affectedRows < 0 ||
      affectedRows > MAX_DML_ROWS ||
      typeof warningStatus !== 'number' ||
      !Number.isSafeInteger(warningStatus) ||
      warningStatus < 0
    ) {
      throw new DmlResultError();
    }
    return Object.freeze({
      affectedRows,
      warningStatus,
      insertId: normalizeDmlInsertId((result as Record<string, unknown>).insertId),
    });
  } catch (error) {
    if (safeInstanceOf(error, DmlResultError)) throw error;
    throw new DmlResultError();
  }
}

type NormalizedUpdateResult = Readonly<{
  affectedRows: number;
  changedRows: number;
  warningStatus: number;
}>;

function normalizeUpdateResult(result: unknown): NormalizedUpdateResult {
  try {
    if (
      typeof result !== 'object' ||
      result === null ||
      !Object.hasOwn(result, 'affectedRows') ||
      !Object.hasOwn(result, 'changedRows') ||
      !Object.hasOwn(result, 'warningStatus')
    ) {
      throw new DmlResultError();
    }
    const record = result as Record<string, unknown>;
    const affectedRows = normalizeDmlCount(record.affectedRows, MAX_DML_LIMIT);
    const changedRows = normalizeDmlCount(record.changedRows, MAX_DML_LIMIT);
    const warningStatus = normalizeDmlCount(record.warningStatus);
    if (changedRows > affectedRows) throw new DmlResultError();
    return Object.freeze({ affectedRows, changedRows, warningStatus });
  } catch (error) {
    if (safeInstanceOf(error, DmlResultError)) throw error;
    throw new DmlResultError();
  }
}

export type CreateTableExecutionResult = Readonly<{
  warningStatus: number;
}>;

function normalizeCreateTableResult(result: unknown): CreateTableExecutionResult {
  try {
    if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'affectedRows') || !Object.hasOwn(result, 'warningStatus')) {
      throw new DdlResultError();
    }
    const record = result as Record<string, unknown>;
    if (
      record.affectedRows !== 0 ||
      typeof record.warningStatus !== 'number' ||
      !Number.isSafeInteger(record.warningStatus) ||
      record.warningStatus < 0
    ) {
      throw new DdlResultError();
    }
    return Object.freeze({ warningStatus: record.warningStatus });
  } catch (error) {
    if (safeInstanceOf(error, DdlResultError)) throw error;
    throw new DdlResultError();
  }
}

declare const dmlStatementBrand: unique symbol;
declare const createTableStatementBrand: unique symbol;
declare const createIndexStatementBrand: unique symbol;
declare const createUniqueIndexStatementBrand: unique symbol;
declare const alterTableAddColumnStatementBrand: unique symbol;
declare const alterTableAddForeignKeyStatementBrand: unique symbol;
declare const alterTableRenameColumnStatementBrand: unique symbol;
declare const renameTableStatementBrand: unique symbol;

export interface DmlStatement {
  readonly [dmlStatementBrand]: true;
}

export interface CreateTableStatement {
  readonly [createTableStatementBrand]: true;
}
export interface CreateIndexStatement {
  readonly [createIndexStatementBrand]: true;
}
export interface CreateUniqueIndexStatement {
  readonly [createUniqueIndexStatementBrand]: true;
}
export interface AlterTableAddColumnStatement {
  readonly [alterTableAddColumnStatementBrand]: true;
}
export interface AlterTableAddForeignKeyStatement {
  readonly [alterTableAddForeignKeyStatementBrand]: true;
}
export interface AlterTableRenameColumnStatement {
  readonly [alterTableRenameColumnStatementBrand]: true;
}
export interface RenameTableStatement {
  readonly [renameTableStatementBrand]: true;
}

export interface DmlConnectionLayer {
  executeDml<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[]]>;
  executeDmlWithOperationId<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[], string]>;
}

export interface DdlConnectionLayer {
  executeCreateTable(statement: CreateTableStatement): Promise<CreateTableExecutionResult>;
  executeCreateTableWithOperationId(statement: CreateTableStatement): Promise<readonly [CreateTableExecutionResult, string]>;
  executeCreateIndex(statement: CreateIndexStatement): Promise<CreateTableExecutionResult>;
  executeCreateIndexWithOperationId(statement: CreateIndexStatement): Promise<readonly [CreateTableExecutionResult, string]>;
  executeCreateUniqueIndex(statement: CreateUniqueIndexStatement): Promise<CreateTableExecutionResult>;
  executeCreateUniqueIndexWithOperationId(statement: CreateUniqueIndexStatement): Promise<readonly [CreateTableExecutionResult, string]>;
  executeAlterTableAddColumn(statement: AlterTableAddColumnStatement): Promise<CreateTableExecutionResult>;
  executeAlterTableAddColumnWithOperationId(statement: AlterTableAddColumnStatement): Promise<readonly [CreateTableExecutionResult, string]>;
  executeAlterTableAddForeignKey(statement: AlterTableAddForeignKeyStatement): Promise<CreateTableExecutionResult>;
  executeAlterTableAddForeignKeyWithOperationId(statement: AlterTableAddForeignKeyStatement): Promise<readonly [CreateTableExecutionResult, string]>;
  executeAlterTableRenameColumn(statement: AlterTableRenameColumnStatement): Promise<CreateTableExecutionResult>;
  executeAlterTableRenameColumnWithOperationId(statement: AlterTableRenameColumnStatement): Promise<readonly [CreateTableExecutionResult, string]>;
  executeRenameTable(statement: RenameTableStatement): Promise<CreateTableExecutionResult>;
  executeRenameTableWithOperationId(statement: RenameTableStatement): Promise<readonly [CreateTableExecutionResult, string]>;
}

export interface ConnectionLayer {
  readonly queryTimeoutMs: number;
  queryOptions(): Readonly<{ timeout: number }>;
  query<T extends QueryResult>(
    options: Readonly<{ sql: string; timeout: number }>,
    values?: QueryValues,
  ): Promise<[T, import('mysql2').FieldPacket[]]>;
  verifyConnection(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectionLayerBundle extends ConnectionLayer {
  readonly dmlEnabled: boolean;
  readonly ddlEnabled: boolean;
  readonly dml: DmlConnectionLayer;
  readonly ddl: DdlConnectionLayer;
}

interface DmlStatementData {
  readonly sql: string;
  readonly values?: ExecuteValues;
  readonly auditRequest?: DmlAuditRequest;
}

const dmlStatementRegistry = new WeakMap<DmlStatement, DmlStatementData>();
type DdlStatement =
  | CreateTableStatement
  | CreateIndexStatement
  | CreateUniqueIndexStatement
  | AlterTableAddColumnStatement
  | AlterTableAddForeignKeyStatement
  | AlterTableRenameColumnStatement
  | RenameTableStatement;
type DdlStatementData =
  | Readonly<{ operation: 'create_table'; sql: string; input: CreateTableInput }>
  | Readonly<{ operation: 'create_index'; sql: string; input: CreateIndexInput }>
  | Readonly<{ operation: 'create_unique_index'; sql: string; input: CreateUniqueIndexInput }>
  | Readonly<{ operation: 'alter_table_add_column'; sql: string; input: AlterTableAddColumnInput }>
  | Readonly<{ operation: 'alter_table_add_foreign_key'; sql: string; input: AlterTableAddForeignKeyInput }>
  | Readonly<{ operation: 'alter_table_rename_column'; sql: string; input: AlterTableRenameColumnInput }>
  | Readonly<{ operation: 'rename_table'; sql: string; input: RenameTableInput }>;
const ddlStatementRegistry = new WeakMap<DdlStatement, DdlStatementData>();

/** Creates the only executable DDL capability, from a freshly normalized structured input. */
export function createCreateTableStatement(input: CreateTableInput): CreateTableStatement {
  let sql: string;
  let normalized: CreateTableInput;
  try {
    normalized = normalizeCreateTableInput(input);
    sql = buildCreateTableStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as CreateTableStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'create_table', sql, input: normalized }));
  return statement;
}

/** Creates the capability-bound form of the supported plain CREATE INDEX statement. */
export function createCreateIndexStatement(input: CreateIndexInput): CreateIndexStatement {
  let sql: string;
  let normalized: CreateIndexInput;
  try {
    normalized = normalizeCreateIndexInput(input);
    sql = buildCreateIndexStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as CreateIndexStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'create_index', sql, input: normalized }));
  return statement;
}

/** Creates the capability-bound form of the supported plain CREATE UNIQUE INDEX statement. */
export function createCreateUniqueIndexStatement(input: CreateUniqueIndexInput): CreateUniqueIndexStatement {
  let sql: string;
  let normalized: CreateUniqueIndexInput;
  try {
    normalized = normalizeCreateUniqueIndexInput(input);
    sql = buildCreateUniqueIndexStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as CreateUniqueIndexStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'create_unique_index', sql, input: normalized }));
  return statement;
}

/** Creates the capability-bound form of the supported nullable ALTER TABLE ADD COLUMN statement. */
export function createAlterTableAddColumnStatement(input: AlterTableAddColumnInput): AlterTableAddColumnStatement {
  let sql: string;
  let normalized: AlterTableAddColumnInput;
  try {
    normalized = normalizeAlterTableAddColumnInput(input);
    sql = buildAlterTableAddColumnStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as AlterTableAddColumnStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'alter_table_add_column', sql, input: normalized }));
  return statement;
}

/** Creates the capability-bound form of the supported intra-schema foreign key statement. */
export function createAlterTableAddForeignKeyStatement(input: AlterTableAddForeignKeyInput): AlterTableAddForeignKeyStatement {
  let sql: string;
  let normalized: AlterTableAddForeignKeyInput;
  try {
    normalized = normalizeAlterTableAddForeignKeyInput(input);
    sql = buildAlterTableAddForeignKeyStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as AlterTableAddForeignKeyStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'alter_table_add_foreign_key', sql, input: normalized }));
  return statement;
}

/** Creates the capability-bound form of the supported one-column RENAME COLUMN statement. */
export function createAlterTableRenameColumnStatement(input: AlterTableRenameColumnInput): AlterTableRenameColumnStatement {
  let sql: string;
  let normalized: AlterTableRenameColumnInput;
  try {
    normalized = normalizeAlterTableRenameColumnInput(input);
    sql = buildAlterTableRenameColumnStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as AlterTableRenameColumnStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'alter_table_rename_column', sql, input: normalized }));
  return statement;
}

/** Creates the capability-bound form of the supported intra-schema RENAME TABLE statement. */
export function createRenameTableStatement(input: RenameTableInput): RenameTableStatement {
  let sql: string;
  let normalized: RenameTableInput;
  try {
    normalized = normalizeRenameTableInput(input);
    sql = buildRenameTableStatement(normalized).sql;
  } catch {
    throw new DdlPolicyError();
  }
  const statement = Object.freeze({}) as RenameTableStatement;
  ddlStatementRegistry.set(statement, Object.freeze({ operation: 'rename_table', sql, input: normalized }));
  return statement;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotDmlValue(value: unknown, activeObjects = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (activeObjects.has(value)) {
      throw new DmlPolicyError();
    }

    activeObjects.add(value);
    try {
      return Object.freeze(value.map((nestedValue) => snapshotDmlValue(nestedValue, activeObjects)));
    } finally {
      activeObjects.delete(value);
    }
  }

  if (safeInstanceOf(value, Date)) {
    return new Date((value as Date).getTime());
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (safeInstanceOf(value, Uint8Array)) {
    return new Uint8Array(value as Uint8Array);
  }

  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    if (activeObjects.has(value)) {
      throw new DmlPolicyError();
    }

    activeObjects.add(value);
    const snapshot: Record<string, unknown> = {};
    try {
      for (const [key, nestedValue] of Object.entries(value)) {
        snapshot[key] = snapshotDmlValue(nestedValue, activeObjects);
      }
      return Object.freeze(snapshot);
    } finally {
      activeObjects.delete(value);
    }
  }

  return value;
}

function freezeAuditInput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nestedValue of Object.values(value)) freezeAuditInput(nestedValue);
  return Object.freeze(value);
}

function assertDmlOperationInput(operation: 'insert' | 'update' | 'delete', input: unknown): void {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new DmlPolicyError();
    }

    if (operation === 'insert' && (!Object.hasOwn(input, 'rows') || Object.hasOwn(input, 'values'))) {
      throw new DmlPolicyError();
    }

    if ((operation === 'update' || operation === 'delete') && Object.hasOwn(input, 'rows')) {
      throw new DmlPolicyError();
    }
  } catch (error) {
    if (safeInstanceOf(error, DmlPolicyError)) throw error;
    throw new DmlPolicyError();
  }
}

/** Creates the only capability-bearing DML statement form, atomically bound to its validated builder input. */
export function createAuditedDmlStatement(
  operation: 'insert' | 'update' | 'delete',
  input: InsertDmlBuilderInput | UpdateDmlBuilderInput | DeleteDmlBuilderInput,
): DmlStatement {
  if (operation !== 'insert' && operation !== 'update' && operation !== 'delete') throw new DmlPolicyError();
  assertDmlOperationInput(operation, input);
  let auditInput: InsertDmlBuilderInput | UpdateDmlBuilderInput | DeleteDmlBuilderInput;
  try {
    auditInput = freezeAuditInput(structuredClone(input)) as InsertDmlBuilderInput | UpdateDmlBuilderInput | DeleteDmlBuilderInput;
  } catch {
    throw new DmlPolicyError();
  }
  const built =
    operation === 'insert'
      ? buildInsertStatement(auditInput as InsertDmlBuilderInput)
      : operation === 'update'
        ? buildUpdateStatement(auditInput as UpdateDmlBuilderInput)
        : buildDeleteStatement(auditInput as DeleteDmlBuilderInput);
  const auditRequest: DmlAuditRequest =
    operation === 'insert'
      ? Object.freeze({
          operation: 'insert',
          target: Object.freeze({
            schema: (auditInput as InsertDmlBuilderInput).target.schema,
            table: (auditInput as InsertDmlBuilderInput).target.table,
          }),
          reason: (auditInput as InsertDmlBuilderInput).target.reason,
          rowCount: (auditInput as InsertDmlBuilderInput).rows.length,
          columns: (auditInput as InsertDmlBuilderInput).columns,
          values: (auditInput as InsertDmlBuilderInput).rows.flatMap((row) =>
            (auditInput as InsertDmlBuilderInput).columns.map((column) => row[column]),
          ),
        })
      : operation === 'update'
        ? Object.freeze({ operation: 'update', input: auditInput as UpdateDmlBuilderInput })
        : Object.freeze({ operation: 'delete', input: auditInput as DeleteDmlBuilderInput });
  const statement = Object.freeze({}) as DmlStatement;
  dmlStatementRegistry.set(
    statement,
    Object.freeze({
      sql: built.sql,
      values: snapshotDmlValue(built.values) as ExecuteValues,
      auditRequest,
    }),
  );
  return statement;
}

/** @deprecated Raw SQL cannot create an executable DML capability. */
export function createInternalDmlStatement(_sql: string, _values?: ExecuteValues, _auditRequest?: DmlAuditRequest): DmlStatement {
  return Object.freeze({}) as DmlStatement;
}

function toPoolOptions(config: ConnectionConfig): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.tls ? { ...config.tls } : undefined,
    waitForConnections: true,
    connectionLimit: config.poolLimit,
    maxIdle: config.poolLimit,
    idleTimeout: config.idleTimeoutMs,
    queueLimit: config.queueLimit,
    connectTimeout: config.connectTimeoutMs,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };
}

function createPool(config: ConnectionConfig, driver: PoolFactory = mysql): Pool {
  if (!driver || typeof driver.createPool !== 'function') {
    throw new TypeError('A MySQL driver with createPool(options) is required.');
  }

  try {
    return driver.createPool(toPoolOptions(config));
  } catch {
    throw new ConnectionError('MySQL pool could not be initialized. Verify the installed driver is compatible with this server.');
  }
}

export function createConnectionLayer({
  environment = process.env,
  driver = mysql,
  readFile,
  dmlAuditWriter,
  ddlAuditWriter,
}: Readonly<{
  environment?: Environment;
  driver?: PoolFactory;
  readFile?: ReadFile;
  dmlAuditWriter?: DmlAuditWriter;
  ddlAuditWriter?: DdlAuditWriter;
}> = {}): ConnectionLayerBundle {
  const config = loadConnectionConfig(environment, { readFile });
  const pool = createPool(config, driver);
  const queryOptions = Object.freeze({ timeout: config.queryTimeoutMs });

  const executeDmlInternal = async <T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[], string]> => {
    if (!config.dmlEnabled) {
      throw new DmlDisabledError();
    }

    let statementData: DmlStatementData | undefined;
    try {
      if (typeof statement !== 'object' || statement === null || !dmlStatementRegistry.has(statement)) {
        throw new DmlPolicyError();
      }

      statementData = dmlStatementRegistry.get(statement);
      if (statementData === undefined) {
        throw new DmlPolicyError();
      }
    } catch (error) {
      if (safeInstanceOf(error, DmlPolicyError)) {
        throw error;
      }

      throw new DmlPolicyError();
    }

    if (statementData === undefined) {
      throw new DmlPolicyError();
    }

    const { sql, values } = statementData;
    if (statementData.auditRequest === undefined) throw new DmlPolicyError();
    let audit: DmlAuditAttempt;
    try {
      audit = (await import('./dml-audit.js')).createDmlAuditAttempt(statementData.auditRequest, { writer: dmlAuditWriter });
    } catch {
      throw new ConnectionError('The DML audit could not be started.');
    }

    let submitted = false;
    try {
      assertDmlSql(sql);
      audit.markSubmitted();
      submitted = true;
      const [result, fields] = await pool.execute<T>({ sql, timeout: config.queryTimeoutMs }, values);
      let normalizedResult = result;
      let affectedCount: number | undefined;
      if (statementData.auditRequest.operation === 'insert') {
        const normalizedInsertResult = normalizeInsertResult(result);
        normalizedResult = normalizedInsertResult as unknown as T;
        affectedCount = normalizedInsertResult.affectedRows;
      } else {
        const normalizedUpdateResult = normalizeUpdateResult(result);
        normalizedResult = normalizedUpdateResult as unknown as T;
        affectedCount = normalizedUpdateResult.affectedRows;
      }
      audit.emit({ affectedCount });
      return [normalizedResult as T, fields, audit.operationId];
    } catch (error) {
      let safeError: unknown;
      if (isQueryTimeout(error)) {
        safeError = new QueryTimeoutError(submitted);
      } else if (isTransportLoss(error)) {
        safeError = new ConnectionError('Unable to execute the DML statement.', submitted);
      } else if (safeInstanceOf(error, DmlResultError)) {
        safeError = error;
      } else if (safeInstanceOf(error, DmlPolicyError)) {
        safeError = error;
      } else {
        safeError = new DmlDriverError(safeDriverCode(error), submitted);
      }
      audit.emit({ error: safeError });
      throw safeError;
    }
  };

  const dml: DmlConnectionLayer = Object.freeze({
    async executeDml<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[]]> {
      const [result, fields] = await executeDmlInternal<T>(statement);
      return [result, fields];
    },
    async executeDmlWithOperationId<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[], string]> {
      return executeDmlInternal<T>(statement);
    },
  });

  async function executeDdlWithOperationId(
    statement: DdlStatement,
    expected: DdlStatementData['operation'],
  ): Promise<readonly [CreateTableExecutionResult, string]> {
    let statementData: DdlStatementData | undefined;
    let auditRequest: unknown;
    try {
      if (typeof statement === 'object' && statement !== null && ddlStatementRegistry.has(statement))
        statementData = ddlStatementRegistry.get(statement);
      if (statementData !== undefined) auditRequest = statementData.input;
    } catch {
      statementData = undefined;
      auditRequest = undefined;
    }

    let audit: DdlAuditAttempt;
    try {
      audit = (await import('./ddl-audit.js')).createDdlAuditAttempt(auditRequest, { writer: ddlAuditWriter, operation: statementData?.operation });
    } catch {
      throw new ConnectionError('The DDL audit could not be started.');
    }

    let submitted = false;
    try {
      if (!config.ddlEnabled) throw new DdlDisabledError();
      if (statementData === undefined || statementData.operation !== expected) throw new DdlPolicyError();
      if (statementData.operation === 'create_table') assertCreateTableSql(statementData.sql);
      else if (statementData.operation === 'create_index') assertCreateIndexSql(statementData.sql);
      else if (statementData.operation === 'create_unique_index') assertCreateUniqueIndexSql(statementData.sql);
      else if (statementData.operation === 'alter_table_add_column') assertAlterTableAddColumnSql(statementData.sql);
      else if (statementData.operation === 'alter_table_add_foreign_key') assertAlterTableAddForeignKeySql(statementData.sql);
      else if (statementData.operation === 'alter_table_rename_column') assertAlterTableRenameColumnSql(statementData.sql);
      else assertRenameTableSql(statementData.sql);
      audit.markSubmitted();
      submitted = true;
      const [result] = await pool.execute({ sql: statementData.sql, timeout: config.queryTimeoutMs });
      const normalizedResult = normalizeCreateTableResult(result);
      audit.emit();
      return [normalizedResult, audit.operationId];
    } catch (error) {
      let safeError: unknown;
      if (isQueryTimeout(error)) safeError = new QueryTimeoutError(submitted);
      else if (isTransportLoss(error)) safeError = new ConnectionError('Unable to execute the DDL statement.', submitted);
      else if (safeInstanceOf(error, DdlResultError) || safeInstanceOf(error, DdlPolicyError) || safeInstanceOf(error, DdlDisabledError))
        safeError = error;
      else safeError = new DdlDriverError(safeDdlDriverCode(error), submitted);
      audit.emit({ error: safeError });
      throw safeError;
    }
  }

  const ddl: DdlConnectionLayer = Object.freeze({
    async executeCreateTable(statement: CreateTableStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'create_table');
      return result;
    },
    executeCreateTableWithOperationId: (statement: CreateTableStatement) => executeDdlWithOperationId(statement, 'create_table'),
    async executeCreateIndex(statement: CreateIndexStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'create_index');
      return result;
    },
    executeCreateIndexWithOperationId: (statement: CreateIndexStatement) => executeDdlWithOperationId(statement, 'create_index'),
    async executeCreateUniqueIndex(statement: CreateUniqueIndexStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'create_unique_index');
      return result;
    },
    executeCreateUniqueIndexWithOperationId: (statement: CreateUniqueIndexStatement) => executeDdlWithOperationId(statement, 'create_unique_index'),
    async executeAlterTableAddColumn(statement: AlterTableAddColumnStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'alter_table_add_column');
      return result;
    },
    executeAlterTableAddColumnWithOperationId: (statement: AlterTableAddColumnStatement) =>
      executeDdlWithOperationId(statement, 'alter_table_add_column'),
    async executeAlterTableAddForeignKey(statement: AlterTableAddForeignKeyStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'alter_table_add_foreign_key');
      return result;
    },
    executeAlterTableAddForeignKeyWithOperationId: (statement: AlterTableAddForeignKeyStatement) =>
      executeDdlWithOperationId(statement, 'alter_table_add_foreign_key'),
    async executeAlterTableRenameColumn(statement: AlterTableRenameColumnStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'alter_table_rename_column');
      return result;
    },
    executeAlterTableRenameColumnWithOperationId: (statement: AlterTableRenameColumnStatement) =>
      executeDdlWithOperationId(statement, 'alter_table_rename_column'),
    async executeRenameTable(statement: RenameTableStatement): Promise<CreateTableExecutionResult> {
      const [result] = await executeDdlWithOperationId(statement, 'rename_table');
      return result;
    },
    executeRenameTableWithOperationId: (statement: RenameTableStatement) => executeDdlWithOperationId(statement, 'rename_table'),
  });

  return Object.freeze({
    dmlEnabled: config.dmlEnabled,
    ddlEnabled: config.ddlEnabled,
    queryTimeoutMs: config.queryTimeoutMs,
    queryOptions: () => queryOptions,
    async query<T extends QueryResult>(
      options: Readonly<{ sql: string; timeout: number }>,
      values?: QueryValues,
    ): Promise<[T, import('mysql2').FieldPacket[]]> {
      assertReadOnlySql(options.sql);

      try {
        return await pool.query<T>(options, values);
      } catch (error) {
        if (isQueryTimeout(error)) {
          throw new QueryTimeoutError();
        }

        throw new ConnectionError('Unable to execute the read-only query.');
      }
    },
    dml,
    ddl,
    async verifyConnection(): Promise<void> {
      await verifyConnection(pool);
    },
    async close(): Promise<void> {
      try {
        await pool.end();
      } catch {
        throw new ConnectionError('MySQL connections could not be closed cleanly.');
      }
    },
  }) as ConnectionLayerBundle;
}

export async function verifyConnection(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  let connection: Awaited<ReturnType<Pool['getConnection']>>;

  try {
    connection = await pool.getConnection();
  } catch {
    throw new ConnectionError('Unable to connect to MySQL. Check the externally supplied MySQL configuration and network access.');
  }

  try {
    connection.release();
  } catch {
    throw new ConnectionError('MySQL connection cleanup failed.');
  }
}
