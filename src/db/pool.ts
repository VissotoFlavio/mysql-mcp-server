import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';

import { loadConnectionConfig, type ConnectionConfig, type Environment, type ReadFile } from '../config.js';

export class ConnectionError extends Error {
  readonly code = 'MYSQL_CONNECTION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface PoolFactory {
  createPool(options: PoolOptions): Pool;
}

export interface ConnectionLayer {
  readonly pool: Pool;
  readonly queryTimeoutMs: number;
  queryOptions(): Readonly<{ timeout: number }>;
  close(): Promise<void>;
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
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };
}

export function createPool(config: ConnectionConfig, driver: PoolFactory = mysql): Pool {
  if (!driver || typeof driver.createPool !== 'function') {
    throw new TypeError('A MySQL driver with createPool(options) is required.');
  }

  try {
    return driver.createPool(toPoolOptions(config));
  } catch {
    throw new ConnectionError('MySQL pool could not be initialized. Verify the installed driver is compatible with this server.');
  }
}

export function createConnectionLayer(
  {
    environment = process.env,
    driver = mysql,
    readFile,
  }: Readonly<{ environment?: Environment; driver?: PoolFactory; readFile?: ReadFile }> = {},
): ConnectionLayer {
  const config = loadConnectionConfig(environment, { readFile });
  const pool = createPool(config, driver);
  const queryOptions = Object.freeze({ timeout: config.queryTimeoutMs });

  return Object.freeze({
    pool,
    queryTimeoutMs: config.queryTimeoutMs,
    queryOptions: () => queryOptions,
    async close(): Promise<void> {
      try {
        await pool.end();
      } catch {
        throw new ConnectionError('MySQL connections could not be closed cleanly.');
      }
    },
  });
}

export async function verifyConnection(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  let connection: Awaited<ReturnType<Pool['getConnection']>> | undefined;

  try {
    connection = await pool.getConnection();
  } catch {
    throw new ConnectionError('Unable to connect to MySQL. Check the externally supplied MySQL configuration and network access.');
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch {
        throw new ConnectionError('MySQL connection cleanup failed.');
      }
    }
  }
}
