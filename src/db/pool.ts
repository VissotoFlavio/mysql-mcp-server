import type { ExecuteValues } from 'mysql2';
import mysql, { type Pool, type PoolOptions, type QueryResult, type QueryValues } from 'mysql2/promise';

import { loadConnectionConfig, type ConnectionConfig, type Environment, type ReadFile } from '../config.js';
import { MAX_DML_ROWS } from '../tools/dml-input.js';

import type { DmlAuditAttempt, DmlAuditRequest, DmlAuditWriter } from './dml-audit.js';
import {
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement,
  type DeleteDmlBuilderInput,
  type InsertDmlBuilderInput,
  type UpdateDmlBuilderInput,
} from './dml-builder.js';
import { sanitizeDmlDriverCode } from './dml-error-codes.js';
import { assertDmlSql, DmlPolicyError, assertReadOnlySql } from './sql-policy.js';

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

/** @internal Carries only an allowlisted MySQL classification, never driver text. */
export class DmlDriverError extends ConnectionError {
  readonly driverCode: string | undefined;

  constructor(driverCode: string | undefined, submitted = false) {
    super('Unable to execute the DML statement.', submitted);
    this.name = 'DmlDriverError';
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

function safeAffectedCount(result: unknown): number | undefined {
  try {
    if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'affectedRows')) return undefined;
    const value = (result as Record<string, unknown>).affectedRows;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
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

declare const dmlStatementBrand: unique symbol;

export interface DmlStatement {
  readonly [dmlStatementBrand]: true;
}

export interface DmlConnectionLayer {
  executeDml<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[]]>;
  executeDmlWithOperationId<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[], string]>;
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
  readonly dml: DmlConnectionLayer;
}

interface DmlStatementData {
  readonly sql: string;
  readonly values?: ExecuteValues;
  readonly auditRequest?: DmlAuditRequest;
}

const dmlStatementRegistry = new WeakMap<DmlStatement, DmlStatementData>();

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
}: Readonly<{ environment?: Environment; driver?: PoolFactory; readFile?: ReadFile; dmlAuditWriter?: DmlAuditWriter }> = {}): ConnectionLayerBundle {
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
        affectedCount = safeAffectedCount(result);
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

  return Object.freeze({
    dmlEnabled: config.dmlEnabled,
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
