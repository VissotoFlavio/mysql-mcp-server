export type DdlDriverClassification = 'permission' | 'tableExists' | 'lockTimeout' | 'deadlock' | 'structure';

/** MySQL codes that are safe to classify at the restricted CREATE TABLE boundary. */
export const DDL_DRIVER_CODE_CLASSIFICATIONS: Readonly<Record<string, DdlDriverClassification>> = Object.freeze({
  ER_ACCESS_DENIED_ERROR: 'permission',
  ER_DBACCESS_DENIED_ERROR: 'permission',
  ER_TABLEACCESS_DENIED_ERROR: 'permission',
  1044: 'permission',
  1045: 'permission',
  1142: 'permission',
  ER_TABLE_EXISTS_ERROR: 'tableExists',
  1050: 'tableExists',
  ER_LOCK_WAIT_TIMEOUT: 'lockTimeout',
  1205: 'lockTimeout',
  ER_LOCK_DEADLOCK: 'deadlock',
  1213: 'deadlock',
  ER_TOO_MANY_FIELDS: 'structure',
  1117: 'structure',
  ER_TOO_BIG_ROWSIZE: 'structure',
  1118: 'structure',
  ER_TOO_MANY_KEYS: 'structure',
  1069: 'structure',
  ER_TOO_LONG_KEY: 'structure',
  1071: 'structure',
});

export function classifyDdlDriverCode(value: unknown): DdlDriverClassification | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const code = String(value);
  if (!Object.hasOwn(DDL_DRIVER_CODE_CLASSIFICATIONS, code)) return undefined;
  const classification = DDL_DRIVER_CODE_CLASSIFICATIONS[code];
  return ['permission', 'tableExists', 'lockTimeout', 'deadlock', 'structure'].includes(classification) ? classification : undefined;
}

/** Returns only an allowlisted driver code; never preserve driver-provided text. */
export function sanitizeDdlDriverCode(value: unknown): string | undefined {
  return classifyDdlDriverCode(value) === undefined ? undefined : String(value);
}
