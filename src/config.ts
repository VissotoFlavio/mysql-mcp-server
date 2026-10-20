import { readFileSync } from 'node:fs';

export const DEFAULTS = Object.freeze({
  port: 3306,
  poolLimit: 2,
  queueLimit: 10,
  connectTimeoutMs: 5_000,
  queryTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
});

export type Environment = Readonly<Record<string, string | undefined>>;
export type ReadFile = (path: string, encoding: BufferEncoding) => string;

export interface TlsConfig {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
}

export interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly dmlEnabled: boolean;
  readonly poolLimit: number;
  readonly queueLimit: number;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly tls?: TlsConfig;
}

export class ConfigurationError extends Error {
  readonly code = 'MYSQL_CONFIGURATION_ERROR';

  constructor(message: string) {
    super(`Invalid MySQL configuration: ${message}`);
    this.name = 'ConfigurationError';
  }
}

function configurationError(message: string): ConfigurationError {
  return new ConfigurationError(message);
}

function requiredValue(environment: Environment, name: string, secret = false): string {
  const value = environment[name];

  if (typeof value !== 'string' || (secret ? value.length === 0 : value.trim().length === 0)) {
    throw configurationError(`${name} must be set.`);
  }

  return secret ? value : value.trim();
}

function optionalValue(environment: Environment, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw configurationError(`${name} must not be empty when provided.`);
  }

  return value.trim();
}

function integerValue(environment: Environment, name: string, fallback: number, range: Readonly<{ min: number; max: number }>): number {
  const raw = optionalValue(environment, name);
  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw configurationError(`${name} must be an integer.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw configurationError(`${name} must be between ${range.min} and ${range.max}.`);
  }

  return value;
}

function booleanValue(environment: Environment, name: string, fallback: boolean): boolean {
  const raw = optionalValue(environment, name);
  if (raw === undefined) {
    return fallback;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw configurationError(`${name} must be true or false.`);
}

function validateHost(host: string): string {
  const hostname = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

  if (!hostname.test(host)) {
    throw configurationError('MYSQL_HOST must be a hostname or IPv4 address without a scheme, port, or path.');
  }

  return host;
}

function validateIdentifier(value: string, name: string): string {
  if (value.length > 64 || value.includes('\0') || /[\r\n]/.test(value)) {
    throw configurationError(`${name} contains unsupported characters.`);
  }

  return value;
}

function readTlsFile(readFile: ReadFile, environmentName: string, path: string): string {
  try {
    return readFile(path, 'utf8');
  } catch {
    throw configurationError(`unable to read TLS material specified by ${environmentName}.`);
  }
}

function loadTlsConfig(environment: Environment, readFile: ReadFile): TlsConfig | undefined {
  const enabled = booleanValue(environment, 'MYSQL_TLS', false);
  const requestedPeerVerification = optionalValue(environment, 'MYSQL_TLS_REJECT_UNAUTHORIZED');

  if (requestedPeerVerification !== undefined && requestedPeerVerification !== 'true') {
    throw configurationError('MYSQL_TLS_REJECT_UNAUTHORIZED must be true when provided.');
  }

  const certificates = [
    ['MYSQL_TLS_CA_FILE', 'ca'],
    ['MYSQL_TLS_CERT_FILE', 'cert'],
    ['MYSQL_TLS_KEY_FILE', 'key'],
  ] as const;
  const providedCertificates: Array<
    Readonly<{
      environmentName: string;
      driverName: 'ca' | 'cert' | 'key';
      path: string;
    }>
  > = [];

  for (const [environmentName, driverName] of certificates) {
    const path = optionalValue(environment, environmentName);
    if (path !== undefined) {
      providedCertificates.push({ environmentName, driverName, path });
    }
  }

  if (!enabled && providedCertificates.length > 0) {
    throw configurationError('MYSQL_TLS must be true when TLS certificate file variables are provided.');
  }

  if (!enabled) {
    return undefined;
  }

  const tls: { rejectUnauthorized: boolean; ca?: string; cert?: string; key?: string } = {
    rejectUnauthorized: true,
  };

  for (const certificate of providedCertificates) {
    tls[certificate.driverName] = readTlsFile(readFile, certificate.environmentName, certificate.path);
  }

  return Object.freeze(tls);
}

export function loadConnectionConfig(
  environment: Environment = process.env,
  { readFile = readFileSync as ReadFile }: Readonly<{ readFile?: ReadFile }> = {},
): ConnectionConfig {
  if (!environment || typeof environment !== 'object') {
    throw configurationError('environment must be an object.');
  }

  return Object.freeze({
    host: validateHost(requiredValue(environment, 'MYSQL_HOST')),
    port: integerValue(environment, 'MYSQL_PORT', DEFAULTS.port, { min: 1, max: 65_535 }),
    database: validateIdentifier(requiredValue(environment, 'MYSQL_DATABASE'), 'MYSQL_DATABASE'),
    user: validateIdentifier(requiredValue(environment, 'MYSQL_USER'), 'MYSQL_USER'),
    password: requiredValue(environment, 'MYSQL_PASSWORD', true),
    dmlEnabled: booleanValue(environment, 'MYSQL_DML_ENABLED', false),
    poolLimit: integerValue(environment, 'MYSQL_POOL_LIMIT', DEFAULTS.poolLimit, { min: 1, max: 2 }),
    queueLimit: integerValue(environment, 'MYSQL_QUEUE_LIMIT', DEFAULTS.queueLimit, { min: 1, max: 100 }),
    connectTimeoutMs: integerValue(environment, 'MYSQL_CONNECT_TIMEOUT_MS', DEFAULTS.connectTimeoutMs, { min: 100, max: 60_000 }),
    queryTimeoutMs: integerValue(environment, 'MYSQL_QUERY_TIMEOUT_MS', DEFAULTS.queryTimeoutMs, { min: 100, max: 60_000 }),
    idleTimeoutMs: integerValue(environment, 'MYSQL_IDLE_TIMEOUT_MS', DEFAULTS.idleTimeoutMs, { min: 1_000, max: 3_600_000 }),
    tls: loadTlsConfig(environment, readFile),
  });
}
