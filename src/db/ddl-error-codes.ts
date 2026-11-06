export type DdlDriverClassification =
  'permission' | 'tableExists' | 'indexExists' | 'duplicateData' | 'columnExists' | 'lockTimeout' | 'deadlock' | 'structure';

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
  ER_DUP_KEYNAME: 'indexExists',
  1061: 'indexExists',
  ER_DUP_ENTRY: 'duplicateData',
  1062: 'duplicateData',
  ER_DUP_FIELDNAME: 'columnExists',
  1060: 'columnExists',
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
  ER_CANNOT_ADD_FOREIGN: 'structure',
  1215: 'structure',
  ER_ROW_IS_REFERENCED_2: 'structure',
  1451: 'structure',
  ER_NO_REFERENCED_ROW_2: 'structure',
  1452: 'structure',
  ER_FK_CANNOT_OPEN_PARENT: 'structure',
  1824: 'structure',
  ER_FK_DUP_NAME: 'structure',
  1826: 'structure',
  ER_FK_INCOMPATIBLE_COLUMNS: 'structure',
  3780: 'structure',
});

export function classifyDdlDriverCode(value: unknown): DdlDriverClassification | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const code = String(value);
  if (!Object.hasOwn(DDL_DRIVER_CODE_CLASSIFICATIONS, code)) return undefined;
  const classification = DDL_DRIVER_CODE_CLASSIFICATIONS[code];
  return ['permission', 'tableExists', 'indexExists', 'duplicateData', 'columnExists', 'lockTimeout', 'deadlock', 'structure'].includes(
    classification,
  )
    ? classification
    : undefined;
}

/** Returns only an allowlisted driver code; never preserve driver-provided text. */
export function sanitizeDdlDriverCode(value: unknown): string | undefined {
  return classifyDdlDriverCode(value) === undefined ? undefined : String(value);
}
