export type DmlDriverClassification = 'permission' | 'duplicate' | 'foreignKey' | 'constraint';

/** MySQL codes safe to preserve across the controlled DML boundary. */
export const DML_DRIVER_CODE_CLASSIFICATIONS: Readonly<Record<string, DmlDriverClassification>> = Object.freeze({
  ER_ACCESS_DENIED_ERROR: 'permission',
  ER_DBACCESS_DENIED_ERROR: 'permission',
  ER_TABLEACCESS_DENIED_ERROR: 'permission',
  1044: 'permission',
  1045: 'permission',
  1142: 'permission',
  ER_DUP_ENTRY: 'duplicate',
  1062: 'duplicate',
  ER_NO_REFERENCED_ROW: 'foreignKey',
  ER_NO_REFERENCED_ROW_2: 'foreignKey',
  ER_ROW_IS_REFERENCED: 'foreignKey',
  ER_ROW_IS_REFERENCED_2: 'foreignKey',
  1216: 'foreignKey',
  1217: 'foreignKey',
  1451: 'foreignKey',
  1452: 'foreignKey',
  ER_CHECK_CONSTRAINT_VIOLATED: 'constraint',
  ER_CONSTRAINT_FAILED: 'constraint',
  ER_BAD_NULL_ERROR: 'constraint',
  1048: 'constraint',
  3819: 'constraint',
  4025: 'constraint',
});

export function classifyDmlDriverCode(value: unknown): DmlDriverClassification | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const code = String(value);
  if (!Object.hasOwn(DML_DRIVER_CODE_CLASSIFICATIONS, code)) {
    return undefined;
  }

  const classification = DML_DRIVER_CODE_CLASSIFICATIONS[code];
  return classification === 'permission' || classification === 'duplicate' || classification === 'foreignKey' || classification === 'constraint'
    ? classification
    : undefined;
}

export function sanitizeDmlDriverCode(value: unknown): string | undefined {
  return classifyDmlDriverCode(value) === undefined ? undefined : String(value);
}
