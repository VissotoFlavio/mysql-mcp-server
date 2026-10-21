import type { RowDataPacket } from 'mysql2';

import type { ConnectionLayer } from './pool.js';

export const MAX_METADATA_RESULTS = 100;

const LIST_SCHEMAS_SQL = `
  SELECT SCHEMA_NAME AS schemaName
  FROM information_schema.SCHEMATA
  ORDER BY SCHEMA_NAME ASC
  LIMIT ?
`;

const LIST_TABLES_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_SCHEMA ASC, TABLE_NAME ASC
  LIMIT ?
`;

const DESCRIBE_TABLE_SQL = `
  SELECT
    tables.TABLE_SCHEMA AS schemaName,
    tables.TABLE_NAME AS tableName,
    tables.TABLE_TYPE AS tableType,
    columns.COLUMN_NAME AS columnName,
    columns.DATA_TYPE AS dataType,
    columns.IS_NULLABLE AS isNullable,
    columns.COLUMN_KEY AS columnKey
  FROM information_schema.TABLES AS tables
  INNER JOIN information_schema.COLUMNS AS columns
    ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
    AND columns.TABLE_NAME = tables.TABLE_NAME
  WHERE tables.TABLE_SCHEMA = ?
    AND tables.TABLE_NAME = ?
  ORDER BY columns.ORDINAL_POSITION ASC
  LIMIT ?
`;

const VALIDATE_DML_METADATA_SQL = `
  SELECT
    tables.TABLE_SCHEMA AS schemaName,
    tables.TABLE_NAME AS tableName,
    tables.TABLE_TYPE AS tableType,
    columns.COLUMN_NAME AS columnName,
    columns.DATA_TYPE AS dataType,
    columns.IS_NULLABLE AS isNullable,
    columns.COLUMN_KEY AS columnKey,
    columns.ORDINAL_POSITION AS ordinalPosition,
    columns.EXTRA AS extra
  FROM information_schema.TABLES AS tables
  INNER JOIN information_schema.COLUMNS AS columns
    ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
    AND columns.TABLE_NAME = tables.TABLE_NAME
  WHERE tables.TABLE_SCHEMA = ?
    AND tables.TABLE_NAME = ?
  ORDER BY columns.ORDINAL_POSITION ASC
  LIMIT ?
`;

const VALIDATE_DML_PRIMARY_KEY_SQL = `
  SELECT
    KEY_COLUMN_USAGE.TABLE_SCHEMA AS schemaName,
    KEY_COLUMN_USAGE.TABLE_NAME AS tableName,
    KEY_COLUMN_USAGE.CONSTRAINT_NAME AS constraintName,
    KEY_COLUMN_USAGE.COLUMN_NAME AS columnName,
    KEY_COLUMN_USAGE.ORDINAL_POSITION AS ordinalPosition
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE KEY_COLUMN_USAGE.TABLE_SCHEMA = ?
    AND KEY_COLUMN_USAGE.TABLE_NAME = ?
    AND KEY_COLUMN_USAGE.CONSTRAINT_NAME = 'PRIMARY'
  ORDER BY KEY_COLUMN_USAGE.ORDINAL_POSITION ASC
`;

interface SchemaRow extends RowDataPacket {
  readonly schemaName: string;
}

interface TableRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
}

interface TableDescriptionRow extends TableRow {
  readonly columnName: string;
  readonly dataType: string;
  readonly isNullable: 'YES' | 'NO';
  readonly columnKey: string;
}

interface DmlMetadataRow extends TableDescriptionRow {
  readonly ordinalPosition: number;
  readonly extra: string;
}

interface DmlPrimaryKeyRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly constraintName: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
}

export interface SchemaMetadata {
  readonly schemaName: string;
}

export interface TableMetadata {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
}

export interface ColumnMetadata {
  readonly columnName: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly columnKey: string;
}

export interface TableDescription {
  readonly table: TableMetadata;
  readonly columns: readonly ColumnMetadata[];
}

export interface DmlColumnMetadata extends ColumnMetadata {
  readonly ordinalPosition: number;
  readonly isGenerated: boolean;
  readonly isAutoIncrement: boolean;
  readonly isVisible: boolean;
}

export interface DmlTableMetadata {
  readonly table: TableMetadata;
  readonly columns: readonly DmlColumnMetadata[];
  readonly primaryKey: readonly string[];
}

export class DmlMetadataError extends Error {
  readonly code = 'MYSQL_DML_METADATA_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DmlMetadataError';
  }
}

const DML_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const DML_METADATA_BASE_TABLE_ONLY = 'DML metadata is supported for base tables only.';
const DML_METADATA_UNKNOWN_COLUMN = 'One or more supplied DML columns are unknown or inaccessible.';
const DML_METADATA_GENERATED_COLUMN = 'Generated columns cannot be supplied for DML.';
const DML_METADATA_AUTO_INCREMENT_COLUMN = 'AUTO_INCREMENT columns cannot be supplied for DML.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function queryOptions(mysql: ConnectionLayer, sql: string): Readonly<{ sql: string; timeout: number }> {
  return Object.freeze({ ...mysql.queryOptions(), sql });
}

export async function listAccessibleSchemas(mysql: ConnectionLayer): Promise<readonly SchemaMetadata[]> {
  const [rows] = await mysql.query<SchemaRow[]>(queryOptions(mysql, LIST_SCHEMAS_SQL), [MAX_METADATA_RESULTS]);
  return rows.slice(0, MAX_METADATA_RESULTS).map(({ schemaName }) => ({ schemaName }));
}

export async function listAccessibleTables(mysql: ConnectionLayer, schema: string): Promise<readonly TableMetadata[]> {
  const [rows] = await mysql.query<TableRow[]>(queryOptions(mysql, LIST_TABLES_SQL), [schema, MAX_METADATA_RESULTS]);
  return rows.slice(0, MAX_METADATA_RESULTS).map(({ schemaName, tableName, tableType }) => ({ schemaName, tableName, tableType }));
}

export async function describeAccessibleTable(mysql: ConnectionLayer, schema: string, table: string): Promise<TableDescription | undefined> {
  const [rows] = await mysql.query<TableDescriptionRow[]>(queryOptions(mysql, DESCRIBE_TABLE_SQL), [schema, table, MAX_METADATA_RESULTS]);
  const boundedRows = rows.slice(0, MAX_METADATA_RESULTS);
  const firstRow = boundedRows[0];

  if (firstRow === undefined) {
    return undefined;
  }

  return {
    table: {
      schemaName: firstRow.schemaName,
      tableName: firstRow.tableName,
      tableType: firstRow.tableType,
    },
    columns: boundedRows.map(({ columnName, dataType, isNullable, columnKey }) => ({
      columnName,
      dataType,
      isNullable: isNullable === 'YES',
      columnKey,
    })),
  };
}

/** @internal Reads structural metadata for one DML operation; callers must invoke this for every operation. */
export async function validateDmlMetadata(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
  suppliedColumns: readonly string[] = [],
): Promise<DmlTableMetadata> {
  let rows: DmlMetadataRow[];
  let primaryKeyRows: DmlPrimaryKeyRow[];
  try {
    [rows] = await mysql.query<DmlMetadataRow[]>(queryOptions(mysql, VALIDATE_DML_METADATA_SQL), [schema, table, MAX_METADATA_RESULTS + 1]);
    [primaryKeyRows] = await mysql.query<DmlPrimaryKeyRow[]>(queryOptions(mysql, VALIDATE_DML_PRIMARY_KEY_SQL), [schema, table]);
  } catch {
    throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
  }

  if (!Array.isArray(rows) || !Array.isArray(primaryKeyRows) || rows.length === 0 || rows.length > MAX_METADATA_RESULTS) {
    throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
  }
  const firstRow = rows[0];
  if (typeof firstRow !== 'object' || firstRow === null) {
    throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
  }

  const validColumnKeys = new Set(['', 'PRI', 'UNI', 'MUL']);
  const tableType = firstRow.tableType;
  const columnNames = new Set<string>();
  const columnOrdinals = new Set<number>();
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.schemaName) ||
      !isNonEmptyString(row.tableName) ||
      !isNonEmptyString(row.tableType) ||
      !isNonEmptyString(row.columnName) ||
      !isNonEmptyString(row.dataType) ||
      !['YES', 'NO'].includes(row.isNullable) ||
      !validColumnKeys.has(row.columnKey) ||
      !Number.isInteger(row.ordinalPosition) ||
      row.ordinalPosition <= 0 ||
      typeof row.extra !== 'string' ||
      row.schemaName !== schema ||
      row.tableName !== table ||
      row.tableType !== tableType ||
      columnNames.has(row.columnName) ||
      columnOrdinals.has(row.ordinalPosition)
    ) {
      throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
    }
    columnNames.add(row.columnName);
    columnOrdinals.add(row.ordinalPosition);
  }

  const orderedColumnOrdinals = [...columnOrdinals].sort((left, right) => left - right);
  if (orderedColumnOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
  }

  if (tableType !== 'BASE TABLE') {
    throw new DmlMetadataError(DML_METADATA_BASE_TABLE_ONLY);
  }

  const columns = rows
    .map(({ columnName, dataType, isNullable, columnKey, ordinalPosition, extra }) => ({
      columnName,
      dataType,
      isNullable: isNullable === 'YES',
      columnKey,
      ordinalPosition,
      isGenerated: /(^|\s)(?:virtual|stored)\s+generated(?=\s|$)/i.test(extra),
      isAutoIncrement: /(^|\s)auto_increment(\s|$)/i.test(extra),
      isVisible: !/(^|\s)invisible(?=\s|$)/i.test(extra),
    }))
    .sort((left, right) => left.ordinalPosition - right.ordinalPosition);

  const byName = new Map(columns.map((column) => [column.columnName, column]));
  const primaryKeyNames = new Set<string>();
  const primaryKeyOrdinals = new Set<number>();
  for (const keyRow of primaryKeyRows) {
    const keyColumn = typeof keyRow === 'object' && keyRow !== null ? byName.get(keyRow.columnName) : undefined;
    if (
      typeof keyRow !== 'object' ||
      keyRow === null ||
      !isNonEmptyString(keyRow.schemaName) ||
      !isNonEmptyString(keyRow.tableName) ||
      !isNonEmptyString(keyRow.constraintName) ||
      !isNonEmptyString(keyRow.columnName) ||
      keyRow.schemaName !== schema ||
      keyRow.tableName !== table ||
      keyRow.constraintName !== 'PRIMARY' ||
      !Number.isInteger(keyRow.ordinalPosition) ||
      keyRow.ordinalPosition <= 0 ||
      primaryKeyNames.has(keyRow.columnName) ||
      primaryKeyOrdinals.has(keyRow.ordinalPosition) ||
      keyColumn === undefined ||
      keyColumn.columnKey !== 'PRI'
    ) {
      throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
    }
    primaryKeyNames.add(keyRow.columnName);
    primaryKeyOrdinals.add(keyRow.ordinalPosition);
  }

  const orderedPrimaryKeyOrdinals = [...primaryKeyOrdinals].sort((left, right) => left - right);
  if (orderedPrimaryKeyOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
  }

  const columnPrimaryKeyNames = new Set(columns.filter(({ columnKey }) => columnKey === 'PRI').map(({ columnName }) => columnName));
  if (
    primaryKeyNames.size === 0 ||
    columnPrimaryKeyNames.size !== primaryKeyNames.size ||
    [...columnPrimaryKeyNames].some((columnName) => !primaryKeyNames.has(columnName))
  ) {
    throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
  }

  for (const suppliedColumn of suppliedColumns) {
    const column = byName.get(suppliedColumn);
    if (column === undefined || !column.isVisible) {
      throw new DmlMetadataError(DML_METADATA_UNKNOWN_COLUMN);
    }
    if (column.isGenerated) {
      throw new DmlMetadataError(DML_METADATA_GENERATED_COLUMN);
    }
    if (column.isAutoIncrement) {
      throw new DmlMetadataError(DML_METADATA_AUTO_INCREMENT_COLUMN);
    }
  }

  return {
    table: {
      schemaName: firstRow.schemaName,
      tableName: firstRow.tableName,
      tableType: firstRow.tableType,
    },
    columns,
    primaryKey: primaryKeyRows.sort((left, right) => left.ordinalPosition - right.ordinalPosition).map(({ columnName }) => columnName),
  };
}
