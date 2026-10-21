import type { ExecuteValues } from 'mysql2';
import mysql, { type Pool, type PoolOptions, type QueryResult, type QueryValues } from 'mysql2/promise';

import { loadConnectionConfig, type ConnectionConfig, type Environment, type ReadFile } from '../config.js';

import { assertDmlSql, DmlPolicyError, assertReadOnlySql } from './sql-policy.js';

export class ConnectionError extends Error {
  readonly code: string = 'MYSQL_CONNECTION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export class QueryTimeoutError extends ConnectionError {
  readonly code = 'MYSQL_QUERY_TIMEOUT';

  constructor() {
    super('MySQL query timed out.');
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

export interface PoolFactory {
  createPool(options: PoolOptions): Pool;
}

function isQueryTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'PROTOCOL_SEQUENCE_TIMEOUT' || (error as { code?: unknown }).code === 'ETIMEDOUT')
  );
}

declare const dmlStatementBrand: unique symbol;

export interface DmlStatement {
  readonly [dmlStatementBrand]: true;
}

export interface DmlConnectionLayer {
  executeDml<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[]]>;
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

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
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

/** @internal Creates a capability-bearing statement for structured internal DML builders. */
export function createInternalDmlStatement(sql: string, values?: ExecuteValues): DmlStatement {
  const statement = Object.freeze({}) as DmlStatement;
  dmlStatementRegistry.set(
    statement,
    Object.freeze({
      sql,
      values: values === undefined ? undefined : (snapshotDmlValue(values) as ExecuteValues),
    }),
  );
  return statement;
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
}: Readonly<{ environment?: Environment; driver?: PoolFactory; readFile?: ReadFile }> = {}): ConnectionLayerBundle {
  const config = loadConnectionConfig(environment, { readFile });
  const pool = createPool(config, driver);
  const queryOptions = Object.freeze({ timeout: config.queryTimeoutMs });

  const dml: DmlConnectionLayer = Object.freeze({
    async executeDml<T extends QueryResult>(statement: DmlStatement): Promise<[T, import('mysql2').FieldPacket[]]> {
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
        if (error instanceof DmlPolicyError) {
          throw error;
        }

        throw new DmlPolicyError();
      }

      if (statementData === undefined) {
        throw new DmlPolicyError();
      }

      const { sql, values } = statementData;
      assertDmlSql(sql);

      try {
        return await pool.execute<T>({ sql, timeout: config.queryTimeoutMs }, values);
      } catch (error) {
        if (isQueryTimeout(error)) {
          throw new QueryTimeoutError();
        }

        throw new ConnectionError('Unable to execute the DML statement.');
      }
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
