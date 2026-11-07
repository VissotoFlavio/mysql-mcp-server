import type { RowDataPacket } from 'mysql2';

import { MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS } from '../tools/alter-table-add-foreign-key-input.js';

import type { ConnectionLayer } from './pool.js';

export const MAX_METADATA_RESULTS = 100;
const MAX_INDEX_METADATA_RESULTS = 1024;

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

const VALIDATE_CREATE_INDEX_METADATA_SQL = `
  SELECT
    tables.TABLE_SCHEMA AS schemaName,
    tables.TABLE_NAME AS tableName,
    tables.TABLE_TYPE AS tableType,
    columns.COLUMN_NAME AS columnName,
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

const VALIDATE_ALTER_TABLE_ADD_COLUMN_METADATA_SQL = `
  SELECT
    tables.TABLE_SCHEMA AS schemaName,
    tables.TABLE_NAME AS tableName,
    tables.TABLE_TYPE AS tableType,
    columns.COLUMN_NAME AS columnName,
    columns.ORDINAL_POSITION AS ordinalPosition
  FROM information_schema.TABLES AS tables
  INNER JOIN information_schema.COLUMNS AS columns
    ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
    AND columns.TABLE_NAME = tables.TABLE_NAME
  WHERE tables.TABLE_SCHEMA = ?
    AND tables.TABLE_NAME = ?
  ORDER BY columns.ORDINAL_POSITION ASC
  LIMIT ?
`;

const VALIDATE_RENAME_TABLE_METADATA_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ?
    AND TABLE_NAME IN (?, ?)
  ORDER BY TABLE_NAME ASC
  LIMIT 3
`;

const VALIDATE_ALTER_TABLE_FOREIGN_KEY_TABLE_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType, ENGINE AS engine
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  LIMIT 2
`;
const VALIDATE_ALTER_TABLE_FOREIGN_KEY_COLUMNS_SQL = `
  SELECT COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition, COLUMN_TYPE AS columnType,
    CHARACTER_SET_NAME AS characterSetName, COLLATION_NAME AS collationName, EXTRA AS extra
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY ORDINAL_POSITION ASC
  LIMIT ?
`;
const VALIDATE_ALTER_TABLE_FOREIGN_KEY_STATISTICS_SQL = `
  SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequenceInIndex,
    COLLATION AS collation, COLUMN_NAME AS columnName, SUB_PART AS subPart, EXPRESSION AS expression, INDEX_TYPE AS indexType
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC
  LIMIT ?
`;
const VALIDATE_ALTER_TABLE_FOREIGN_KEY_CONSTRAINT_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName, CONSTRAINT_TYPE AS constraintType
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ?
  LIMIT 2
`;

const VALIDATE_CREATE_INDEX_STATISTICS_SQL = `
  SELECT
    TABLE_SCHEMA AS schemaName,
    TABLE_NAME AS tableName,
    INDEX_NAME AS indexName,
    NON_UNIQUE AS nonUnique,
    SEQ_IN_INDEX AS sequenceInIndex,
    COLLATION AS collation,
    COLUMN_NAME AS columnName,
    SUB_PART AS subPart,
    EXPRESSION AS expression,
    INDEX_TYPE AS indexType
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = ?
    AND TABLE_NAME = ?
  ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC
  LIMIT ?
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

interface CreateIndexMetadataRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly extra: string;
}

interface CreateIndexStatisticRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly indexName: string;
  readonly nonUnique: number;
  readonly sequenceInIndex: number;
  readonly collation: string | null;
  readonly columnName: string | null;
  readonly subPart: number | null;
  readonly expression: string | null;
  readonly indexType: string;
}
interface DuplicateTupleRow extends RowDataPacket {
  readonly duplicateExists: unknown;
}
interface ForeignKeyOrphanRow extends RowDataPacket {
  readonly orphanExists: unknown;
}

interface AlterTableAddColumnMetadataRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
}
interface ForeignKeyTableRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
  readonly engine: string | null;
}
interface ForeignKeyColumnRow extends RowDataPacket {
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly columnType: string;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  readonly extra: string;
}
interface ForeignKeyStatisticRow extends RowDataPacket {
  readonly indexName: string;
  readonly nonUnique: number;
  readonly sequenceInIndex: number;
  readonly collation: string | null;
  readonly columnName: string | null;
  readonly subPart: number | null;
  readonly expression: string | null;
  readonly indexType: string;
}
interface ForeignKeyConstraintRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly constraintName: string;
  readonly constraintType: string;
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

export interface DmlMetadataOptions {
  readonly operation?: 'insert' | 'update' | 'delete';
}

export class DmlMetadataError extends Error {
  readonly code = 'MYSQL_DML_METADATA_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DmlMetadataError';
  }
}

export type CreateIndexMetadataCode =
  'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_COLUMN_INVALID' | 'MYSQL_DDL_INDEX_EXISTS';

export type CreateUniqueIndexMetadataCode = CreateIndexMetadataCode | 'MYSQL_DDL_DUPLICATE_DATA';

export class CreateIndexMetadataError extends Error {
  readonly code: CreateIndexMetadataCode;

  constructor(code: CreateIndexMetadataCode, message: string) {
    super(message);
    this.name = 'CreateIndexMetadataError';
    this.code = code;
  }
}
export class CreateUniqueIndexMetadataError extends Error {
  readonly code: CreateUniqueIndexMetadataCode;
  constructor(code: CreateUniqueIndexMetadataCode, message: string) {
    super(message);
    this.name = 'CreateUniqueIndexMetadataError';
    this.code = code;
  }
}

export type AlterTableAddColumnMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_COLUMN_EXISTS';

export class AlterTableAddColumnMetadataError extends Error {
  readonly code: AlterTableAddColumnMetadataCode;

  constructor(code: AlterTableAddColumnMetadataCode, message: string) {
    super(message);
    this.name = 'AlterTableAddColumnMetadataError';
    this.code = code;
  }
}
export type AlterTableRenameColumnMetadataCode =
  'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_COLUMN_INVALID' | 'MYSQL_DDL_COLUMN_EXISTS';
export class AlterTableRenameColumnMetadataError extends Error {
  constructor(
    readonly code: AlterTableRenameColumnMetadataCode,
    message: string,
  ) {
    super(message);
    this.name = 'AlterTableRenameColumnMetadataError';
  }
}
export type RenameTableMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_TABLE_EXISTS';
export class RenameTableMetadataError extends Error {
  constructor(
    readonly code: RenameTableMetadataCode,
    message: string,
  ) {
    super(message);
    this.name = 'RenameTableMetadataError';
  }
}
export type AlterTableAddForeignKeyMetadataCode =
  | 'MYSQL_DDL_METADATA_INVALID'
  | 'MYSQL_DDL_TABLE_INVALID'
  | 'MYSQL_DDL_COLUMN_INVALID'
  | 'MYSQL_DDL_FOREIGN_KEY_EXISTS'
  | 'MYSQL_DDL_FOREIGN_KEY_ORPHANS';
export class AlterTableAddForeignKeyMetadataError extends Error {
  readonly code: AlterTableAddForeignKeyMetadataCode;
  constructor(code: AlterTableAddForeignKeyMetadataCode, message: string) {
    super(message);
    this.name = 'AlterTableAddForeignKeyMetadataError';
    this.code = code;
  }
}

const DML_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const DML_METADATA_BASE_TABLE_ONLY = 'DML metadata is supported for base tables only.';
const DML_METADATA_UNKNOWN_COLUMN = 'One or more supplied DML columns are unknown or inaccessible.';
const DML_METADATA_GENERATED_COLUMN = 'Generated columns cannot be supplied for DML.';
const DML_METADATA_AUTO_INCREMENT_COLUMN = 'AUTO_INCREMENT columns cannot be supplied for DML.';
const CREATE_INDEX_METADATA_UNAVAILABLE = 'Unable to validate the requested index metadata.';
const CREATE_INDEX_METADATA_BASE_TABLE_ONLY = 'CREATE INDEX metadata is supported for base tables only.';
const CREATE_INDEX_METADATA_COLUMN_INVALID = 'One or more supplied index columns are unknown, generated, or invisible.';
const CREATE_INDEX_METADATA_EXISTS = 'The requested index name or definition already exists.';
const CREATE_UNIQUE_INDEX_METADATA_EXISTS = 'The requested index name, primary key, or unique definition already exists.';
const CREATE_UNIQUE_INDEX_DUPLICATE_DATA = 'The requested unique index cannot be created because duplicate non-null tuples exist.';
const ALTER_TABLE_ADD_COLUMN_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const ALTER_TABLE_ADD_COLUMN_METADATA_BASE_TABLE_ONLY = 'ALTER TABLE ADD COLUMN metadata is supported for base tables only.';
const ALTER_TABLE_ADD_COLUMN_METADATA_COLUMN_EXISTS = 'The requested column already exists.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_BASE_TABLE_ONLY = 'ALTER TABLE RENAME COLUMN metadata is supported for base tables only.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_COLUMN_INVALID = 'The source column is unknown or inaccessible.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_COLUMN_EXISTS = 'The destination column already exists.';
const RENAME_TABLE_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const RENAME_TABLE_METADATA_SOURCE_INVALID = 'The source must be an existing base table.';
const RENAME_TABLE_METADATA_DESTINATION_EXISTS = 'The destination table already exists.';
const ALTER_TABLE_FOREIGN_KEY_METADATA_UNAVAILABLE = 'Unable to validate the requested foreign-key metadata.';
const ALTER_TABLE_FOREIGN_KEY_TABLE_INVALID = 'Foreign keys are supported only between InnoDB base tables.';
const ALTER_TABLE_FOREIGN_KEY_COLUMN_INVALID = 'One or more foreign-key columns are unknown, incompatible, or lack a required index.';
const ALTER_TABLE_FOREIGN_KEY_EXISTS = 'The requested foreign-key constraint already exists.';
const ALTER_TABLE_FOREIGN_KEY_ORPHANS = 'The requested foreign key conflicts with existing data.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizedIdentifierName(value: string): string {
  return value.toLocaleLowerCase('en-US');
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
  options: DmlMetadataOptions = {},
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
  if (options.operation !== 'insert') {
    if (
      primaryKeyNames.size === 0 ||
      columnPrimaryKeyNames.size !== primaryKeyNames.size ||
      [...columnPrimaryKeyNames].some((columnName) => !primaryKeyNames.has(columnName))
    ) {
      throw new DmlMetadataError(DML_METADATA_UNAVAILABLE);
    }
  } else if (
    primaryKeyNames.size !== columnPrimaryKeyNames.size ||
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

/** @internal Reads bounded table and index metadata required before one CREATE INDEX attempt. */
function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}
function duplicateTupleSql(schema: string, table: string, columns: readonly string[]): string {
  const qualifiedTable = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
  const selectedColumns = columns.map(escapeIdentifier).join(', ');
  const nonNull = columns.map((column) => `${escapeIdentifier(column)} IS NOT NULL`).join(' AND ');
  return `SELECT EXISTS (SELECT 1 FROM (SELECT 1 FROM ${qualifiedTable} WHERE ${nonNull} GROUP BY ${selectedColumns} HAVING COUNT(*) > 1 LIMIT 1) AS duplicate_groups) AS duplicateExists`;
}

async function validateIndexMetadata(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
  index: string,
  requestedColumns: readonly string[],
  unique: boolean,
): Promise<void> {
  let columns: CreateIndexMetadataRow[];
  let statistics: CreateIndexStatisticRow[];
  try {
    [columns] = await mysql.query<CreateIndexMetadataRow[]>(queryOptions(mysql, VALIDATE_CREATE_INDEX_METADATA_SQL), [
      schema,
      table,
      MAX_METADATA_RESULTS + 1,
    ]);
    [statistics] = await mysql.query<CreateIndexStatisticRow[]>(queryOptions(mysql, VALIDATE_CREATE_INDEX_STATISTICS_SQL), [
      schema,
      table,
      MAX_INDEX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
  }

  if (
    !Array.isArray(columns) ||
    !Array.isArray(statistics) ||
    columns.length === 0 ||
    columns.length > MAX_METADATA_RESULTS ||
    statistics.length > MAX_INDEX_METADATA_RESULTS
  )
    throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);

  const knownColumns = new Map<string, Readonly<{ generated: boolean; visible: boolean }>>();
  const ordinals = new Set<number>();
  const first = columns[0];
  if (first === undefined || typeof first !== 'object' || first === null)
    throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
  for (const column of columns) {
    if (
      typeof column !== 'object' ||
      column === null ||
      !isNonEmptyString(column.schemaName) ||
      !isNonEmptyString(column.tableName) ||
      !isNonEmptyString(column.tableType) ||
      !isNonEmptyString(column.columnName) ||
      !Number.isInteger(column.ordinalPosition) ||
      column.ordinalPosition <= 0 ||
      typeof column.extra !== 'string' ||
      column.schemaName !== schema ||
      column.tableName !== table ||
      column.tableType !== first.tableType ||
      knownColumns.has(column.columnName) ||
      ordinals.has(column.ordinalPosition)
    )
      throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    knownColumns.set(column.columnName, {
      generated: /(^|\s)(?:virtual|stored)\s+generated(?=\s|$)/i.test(column.extra),
      visible: !/(^|\s)invisible(?=\s|$)/i.test(column.extra),
    });
    ordinals.add(column.ordinalPosition);
  }
  if ([...ordinals].sort((left, right) => left - right).some((ordinal, position) => ordinal !== position + 1))
    throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
  if (first.tableType !== 'BASE TABLE') throw new CreateIndexMetadataError('MYSQL_DDL_TABLE_INVALID', CREATE_INDEX_METADATA_BASE_TABLE_ONLY);

  const supplied = new Set<string>();
  for (const name of requestedColumns) {
    const column = knownColumns.get(name);
    if (supplied.has(name) || column === undefined || column.generated || !column.visible)
      throw new CreateIndexMetadataError('MYSQL_DDL_COLUMN_INVALID', CREATE_INDEX_METADATA_COLUMN_INVALID);
    supplied.add(name);
  }

  const indexes = new Map<string, CreateIndexStatisticRow[]>();
  for (const statistic of statistics) {
    if (
      typeof statistic !== 'object' ||
      statistic === null ||
      !isNonEmptyString(statistic.schemaName) ||
      !isNonEmptyString(statistic.tableName) ||
      !isNonEmptyString(statistic.indexName) ||
      !Number.isInteger(statistic.nonUnique) ||
      ![0, 1].includes(statistic.nonUnique) ||
      !Number.isInteger(statistic.sequenceInIndex) ||
      statistic.sequenceInIndex <= 0 ||
      statistic.sequenceInIndex > 16 ||
      (statistic.collation !== null && !['A', 'D'].includes(statistic.collation)) ||
      (statistic.columnName !== null && !isNonEmptyString(statistic.columnName)) ||
      (statistic.subPart !== null && (!Number.isInteger(statistic.subPart) || statistic.subPart <= 0)) ||
      (statistic.expression !== null && !isNonEmptyString(statistic.expression)) ||
      !isNonEmptyString(statistic.indexType) ||
      statistic.schemaName !== schema ||
      statistic.tableName !== table
    )
      throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    const normalizedName = normalizedIdentifierName(statistic.indexName);
    const entries = indexes.get(normalizedName) ?? [];
    if (entries.some(({ sequenceInIndex }) => sequenceInIndex === statistic.sequenceInIndex))
      throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    entries.push(statistic);
    indexes.set(normalizedName, entries);
  }

  if (indexes.has(normalizedIdentifierName(index)))
    throw new CreateIndexMetadataError('MYSQL_DDL_INDEX_EXISTS', unique ? CREATE_UNIQUE_INDEX_METADATA_EXISTS : CREATE_INDEX_METADATA_EXISTS);
  for (const entries of indexes.values()) {
    const ordered = entries.sort((left, right) => left.sequenceInIndex - right.sequenceInIndex);
    if (ordered.some((entry, position) => entry.sequenceInIndex !== position + 1))
      throw new CreateIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    if (
      ordered.length === requestedColumns.length &&
      ordered.every(
        (entry, position) =>
          entry.sequenceInIndex === position + 1 &&
          (unique ? entry.nonUnique === 0 : entry.nonUnique === 1) &&
          entry.columnName === requestedColumns[position] &&
          entry.collation === 'A' &&
          entry.subPart === null &&
          entry.expression === null &&
          entry.indexType.toUpperCase() === 'BTREE',
      )
    )
      throw new CreateIndexMetadataError('MYSQL_DDL_INDEX_EXISTS', unique ? CREATE_UNIQUE_INDEX_METADATA_EXISTS : CREATE_INDEX_METADATA_EXISTS);
  }

  if (unique) {
    let duplicates: DuplicateTupleRow[];
    try {
      [duplicates] = await mysql.query<DuplicateTupleRow[]>(queryOptions(mysql, duplicateTupleSql(schema, table, requestedColumns)));
    } catch {
      throw new CreateUniqueIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    }
    if (!Array.isArray(duplicates) || duplicates.length !== 1 || typeof duplicates[0] !== 'object' || duplicates[0] === null)
      throw new CreateUniqueIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    const duplicateExists = duplicates[0].duplicateExists;
    const hasDuplicates =
      duplicateExists === 1 || duplicateExists === '1' ? true : duplicateExists === 0 || duplicateExists === '0' ? false : undefined;
    if (hasDuplicates === undefined) throw new CreateUniqueIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
    if (hasDuplicates) throw new CreateUniqueIndexMetadataError('MYSQL_DDL_DUPLICATE_DATA', CREATE_UNIQUE_INDEX_DUPLICATE_DATA);
  }
}

/** @internal Reads bounded metadata and duplicate existence before one CREATE INDEX attempt. */
export async function validateCreateIndexMetadata(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
  index: string,
  requestedColumns: readonly string[],
): Promise<void> {
  return validateIndexMetadata(mysql, schema, table, index, requestedColumns, false);
}

/** @internal Reads bounded metadata and duplicate existence before one CREATE UNIQUE INDEX attempt. */
export async function validateCreateUniqueIndexMetadata(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
  index: string,
  requestedColumns: readonly string[],
): Promise<void> {
  try {
    await validateIndexMetadata(mysql, schema, table, index, requestedColumns, true);
  } catch (error) {
    if (error instanceof CreateUniqueIndexMetadataError) throw error;
    if (error instanceof CreateIndexMetadataError) throw new CreateUniqueIndexMetadataError(error.code, error.message);
    throw new CreateUniqueIndexMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_INDEX_METADATA_UNAVAILABLE);
  }
}

/** @internal Reads bounded table metadata before one ALTER TABLE ADD COLUMN attempt. */
async function readBaseTableColumnNames(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
  normalizeName: (name: string) => string,
  fail: (kind: 'metadata' | 'table') => never,
): Promise<ReadonlySet<string>> {
  let rows: AlterTableAddColumnMetadataRow[];
  try {
    [rows] = await mysql.query<AlterTableAddColumnMetadataRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_ADD_COLUMN_METADATA_SQL), [
      schema,
      table,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    fail('metadata');
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_METADATA_RESULTS) fail('metadata');
  const first = rows[0];
  const names = new Set<string>();
  const ordinals = new Set<number>();
  if (first === undefined || typeof first !== 'object' || first === null) fail('metadata');
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.schemaName) ||
      !isNonEmptyString(row.tableName) ||
      !isNonEmptyString(row.tableType) ||
      !isNonEmptyString(row.columnName) ||
      !Number.isInteger(row.ordinalPosition) ||
      row.ordinalPosition <= 0 ||
      row.schemaName !== schema ||
      row.tableName !== table ||
      row.tableType !== first.tableType ||
      names.has(normalizeName(row.columnName)) ||
      ordinals.has(row.ordinalPosition)
    )
      fail('metadata');
    names.add(normalizeName(row.columnName));
    ordinals.add(row.ordinalPosition);
  }
  if ([...ordinals].sort((left, right) => left - right).some((ordinal, position) => ordinal !== position + 1)) fail('metadata');
  if (first.tableType !== 'BASE TABLE') fail('table');
  return names;
}

export async function validateAlterTableAddColumnMetadata(mysql: ConnectionLayer, schema: string, table: string, column: string): Promise<void> {
  const names = await readBaseTableColumnNames(
    mysql,
    schema,
    table,
    (name) => name,
    (kind) => {
      throw new AlterTableAddColumnMetadataError(
        kind === 'metadata' ? 'MYSQL_DDL_METADATA_INVALID' : 'MYSQL_DDL_TABLE_INVALID',
        kind === 'metadata' ? ALTER_TABLE_ADD_COLUMN_METADATA_UNAVAILABLE : ALTER_TABLE_ADD_COLUMN_METADATA_BASE_TABLE_ONLY,
      );
    },
  );
  if (names.has(column)) throw new AlterTableAddColumnMetadataError('MYSQL_DDL_COLUMN_EXISTS', ALTER_TABLE_ADD_COLUMN_METADATA_COLUMN_EXISTS);
}

/** @internal Reads bounded metadata before one ALTER TABLE RENAME COLUMN attempt. */
export async function validateAlterTableRenameColumnMetadata(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
  column: string,
  newColumn: string,
): Promise<void> {
  const names = await readBaseTableColumnNames(mysql, schema, table, normalizedIdentifierName, (kind) => {
    throw new AlterTableRenameColumnMetadataError(
      kind === 'metadata' ? 'MYSQL_DDL_METADATA_INVALID' : 'MYSQL_DDL_TABLE_INVALID',
      kind === 'metadata' ? ALTER_TABLE_RENAME_COLUMN_METADATA_UNAVAILABLE : ALTER_TABLE_RENAME_COLUMN_METADATA_BASE_TABLE_ONLY,
    );
  });
  if (!names.has(normalizedIdentifierName(column)))
    throw new AlterTableRenameColumnMetadataError('MYSQL_DDL_COLUMN_INVALID', ALTER_TABLE_RENAME_COLUMN_METADATA_COLUMN_INVALID);
  if (names.has(normalizedIdentifierName(newColumn)))
    throw new AlterTableRenameColumnMetadataError('MYSQL_DDL_COLUMN_EXISTS', ALTER_TABLE_RENAME_COLUMN_METADATA_COLUMN_EXISTS);
}

/** @internal Reads bounded table metadata before one intra-schema RENAME TABLE attempt. */
export async function validateRenameTableMetadata(mysql: ConnectionLayer, schema: string, table: string, newTable: string): Promise<void> {
  let rows: TableRow[];
  try {
    [rows] = await mysql.query<TableRow[]>(queryOptions(mysql, VALIDATE_RENAME_TABLE_METADATA_SQL), [schema, table, newTable]);
  } catch {
    throw new RenameTableMetadataError('MYSQL_DDL_METADATA_INVALID', RENAME_TABLE_METADATA_UNAVAILABLE);
  }
  if (!Array.isArray(rows) || rows.length > 2) throw new RenameTableMetadataError('MYSQL_DDL_METADATA_INVALID', RENAME_TABLE_METADATA_UNAVAILABLE);

  const seen = new Set<string>();
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.schemaName) ||
      !isNonEmptyString(row.tableName) ||
      !isNonEmptyString(row.tableType) ||
      normalizedIdentifierName(row.schemaName) !== normalizedIdentifierName(schema) ||
      ![table, newTable].some((name) => normalizedIdentifierName(name) === normalizedIdentifierName(row.tableName)) ||
      seen.has(normalizedIdentifierName(row.tableName))
    )
      throw new RenameTableMetadataError('MYSQL_DDL_METADATA_INVALID', RENAME_TABLE_METADATA_UNAVAILABLE);
    seen.add(normalizedIdentifierName(row.tableName));
  }

  const source = rows.find(({ tableName }) => normalizedIdentifierName(tableName) === normalizedIdentifierName(table));
  const destination = rows.find(({ tableName }) => normalizedIdentifierName(tableName) === normalizedIdentifierName(newTable));
  if (source === undefined || source.tableType !== 'BASE TABLE')
    throw new RenameTableMetadataError('MYSQL_DDL_TABLE_INVALID', RENAME_TABLE_METADATA_SOURCE_INVALID);
  if (destination !== undefined) throw new RenameTableMetadataError('MYSQL_DDL_TABLE_EXISTS', RENAME_TABLE_METADATA_DESTINATION_EXISTS);
}

function foreignKeyError(code: AlterTableAddForeignKeyMetadataCode): AlterTableAddForeignKeyMetadataError {
  const message =
    code === 'MYSQL_DDL_TABLE_INVALID'
      ? ALTER_TABLE_FOREIGN_KEY_TABLE_INVALID
      : code === 'MYSQL_DDL_COLUMN_INVALID'
        ? ALTER_TABLE_FOREIGN_KEY_COLUMN_INVALID
        : code === 'MYSQL_DDL_FOREIGN_KEY_EXISTS'
          ? ALTER_TABLE_FOREIGN_KEY_EXISTS
          : code === 'MYSQL_DDL_FOREIGN_KEY_ORPHANS'
            ? ALTER_TABLE_FOREIGN_KEY_ORPHANS
            : ALTER_TABLE_FOREIGN_KEY_METADATA_UNAVAILABLE;
  return new AlterTableAddForeignKeyMetadataError(code, message);
}
function foreignKeyOrphansSql(
  schema: string,
  table: string,
  columns: readonly string[],
  referencedTable: string,
  referencedColumns: readonly string[],
): string {
  const local = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
  const referenced = `${escapeIdentifier(schema)}.${escapeIdentifier(referencedTable)}`;
  const joins = columns
    .map((column, index) => `local_row.${escapeIdentifier(column)} = referenced_row.${escapeIdentifier(referencedColumns[index] as string)}`)
    .join(' AND ');
  const present = columns.map((column) => `local_row.${escapeIdentifier(column)} IS NOT NULL`).join(' AND ');
  return `SELECT EXISTS (SELECT 1 FROM ${local} AS local_row LEFT JOIN ${referenced} AS referenced_row ON ${joins} WHERE ${present} AND referenced_row.${escapeIdentifier(referencedColumns[0] as string)} IS NULL LIMIT 1) AS orphanExists`;
}

function columnsByName(rows: readonly ForeignKeyColumnRow[]): Map<string, ForeignKeyColumnRow> {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_METADATA_RESULTS) throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  const names = new Map<string, ForeignKeyColumnRow>();
  const ordinals = new Set<number>();
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.columnName) ||
      !Number.isInteger(row.ordinalPosition) ||
      row.ordinalPosition <= 0 ||
      !isNonEmptyString(row.columnType) ||
      (row.characterSetName !== null && !isNonEmptyString(row.characterSetName)) ||
      (row.collationName !== null && !isNonEmptyString(row.collationName)) ||
      typeof row.extra !== 'string' ||
      names.has(row.columnName) ||
      ordinals.has(row.ordinalPosition) ||
      /(^|\s)(?:virtual|stored)\s+generated(?=\s|$)|(^|\s)invisible(?=\s|$)/iu.test(row.extra)
    )
      throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
    names.set(row.columnName, row);
    ordinals.add(row.ordinalPosition);
  }
  if ([...ordinals].sort((left, right) => left - right).some((ordinal, index) => ordinal !== index + 1))
    throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  return names;
}

type OrderedForeignKeyIndex = readonly ForeignKeyStatisticRow[];

function groupForeignKeyIndexes(rows: readonly ForeignKeyStatisticRow[]): readonly OrderedForeignKeyIndex[] {
  if (!Array.isArray(rows) || rows.length > MAX_INDEX_METADATA_RESULTS) throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  const indexes = new Map<string, ForeignKeyStatisticRow[]>();
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.indexName) ||
      !Number.isInteger(row.nonUnique) ||
      ![0, 1].includes(row.nonUnique) ||
      !Number.isInteger(row.sequenceInIndex) ||
      row.sequenceInIndex <= 0 ||
      row.sequenceInIndex > MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS ||
      (row.collation !== null && !['A', 'D'].includes(row.collation)) ||
      (row.columnName !== null && !isNonEmptyString(row.columnName)) ||
      (row.subPart !== null && (!Number.isInteger(row.subPart) || row.subPart <= 0)) ||
      (row.expression !== null && !isNonEmptyString(row.expression)) ||
      !isNonEmptyString(row.indexType)
    )
      throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
    const entries = indexes.get(row.indexName) ?? [];
    if (entries.some(({ sequenceInIndex }) => sequenceInIndex === row.sequenceInIndex)) throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
    entries.push(row);
    indexes.set(row.indexName, entries);
  }
  return Object.freeze(
    [...indexes.values()].map((entries) => {
      const ordered = [...entries].sort((left, right) => left.sequenceInIndex - right.sequenceInIndex);
      if (ordered.some((entry, index) => entry.sequenceInIndex !== index + 1)) throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
      return Object.freeze(ordered);
    }),
  );
}

function hasOrderedIndexPrefix(rows: readonly ForeignKeyStatisticRow[], requestedColumns: readonly string[]): boolean {
  return groupForeignKeyIndexes(rows).some((ordered) =>
    requestedColumns.every(
      (column, index) =>
        ordered[index]?.columnName === column &&
        ordered[index]?.collation === 'A' &&
        ordered[index]?.subPart === null &&
        ordered[index]?.expression === null &&
        ordered[index]?.indexType.toUpperCase() === 'BTREE',
    ),
  );
}

function hasUniqueExactIndex(rows: readonly ForeignKeyStatisticRow[], requestedColumns: readonly string[]): boolean {
  return groupForeignKeyIndexes(rows).some((ordered) => {
    if (ordered.length !== requestedColumns.length) return false;
    return ordered.every(
      (entry, index) =>
        entry.nonUnique === 0 &&
        entry.columnName === requestedColumns[index] &&
        entry.collation === 'A' &&
        entry.subPart === null &&
        entry.expression === null &&
        entry.indexType.toUpperCase() === 'BTREE',
    );
  });
}

type ForeignKeyColumnFamily = Readonly<{ kind: 'numeric'; normalizedType: string }> | Readonly<{ kind: 'character' }>;

function foreignKeyColumnFamily(column: ForeignKeyColumnRow): ForeignKeyColumnFamily | undefined {
  const normalizedType = column.columnType.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
  if (
    /^(?:tinyint|smallint|mediumint|int|bigint)(?:\([1-9][0-9]*\))?(?: unsigned)?$/u.test(normalizedType) ||
    /^decimal\([1-9][0-9]*,[0-9]+\)(?: unsigned)?$/u.test(normalizedType) ||
    /^(?:float|double)(?:\([1-9][0-9]*(?:,[0-9]+)?\))?(?: unsigned)?$/u.test(normalizedType)
  )
    return Object.freeze({ kind: 'numeric', normalizedType });
  if (/^(?:char|varchar)\([1-9][0-9]*\)$/u.test(normalizedType) || /^(?:tinytext|text|mediumtext|longtext)$/u.test(normalizedType)) {
    if (!isNonEmptyString(column.characterSetName) || !isNonEmptyString(column.collationName)) return undefined;
    return Object.freeze({ kind: 'character' });
  }
  return undefined;
}

function compatibleForeignKeyColumns(local: ForeignKeyColumnRow, referenced: ForeignKeyColumnRow): boolean {
  const localFamily = foreignKeyColumnFamily(local);
  const referencedFamily = foreignKeyColumnFamily(referenced);
  if (localFamily === undefined || referencedFamily === undefined || localFamily.kind !== referencedFamily.kind) return false;
  if (localFamily.kind === 'numeric' && referencedFamily.kind === 'numeric') return localFamily.normalizedType === referencedFamily.normalizedType;
  return local.characterSetName === referenced.characterSetName && local.collationName === referenced.collationName;
}

/** @internal Performs the bounded, read-only foreign-key preflight. The subsequent DDL remains subject to normal TOCTOU races. */
export async function validateAlterTableAddForeignKeyMetadata(
  mysql: ConnectionLayer,
  input: Readonly<{
    schema: string;
    table: string;
    constraint: string;
    columns: readonly string[];
    referencedTable: string;
    referencedColumns: readonly string[];
  }>,
): Promise<void> {
  let localTableRows: ForeignKeyTableRow[];
  let referencedTableRows: ForeignKeyTableRow[];
  let localColumns: ForeignKeyColumnRow[];
  let referencedColumns: ForeignKeyColumnRow[];
  let localIndexes: ForeignKeyStatisticRow[];
  let referencedIndexes: ForeignKeyStatisticRow[];
  let constraints: ForeignKeyConstraintRow[];
  try {
    [localTableRows] = await mysql.query<ForeignKeyTableRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_TABLE_SQL), [
      input.schema,
      input.table,
    ]);
    [referencedTableRows] = await mysql.query<ForeignKeyTableRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_TABLE_SQL), [
      input.schema,
      input.referencedTable,
    ]);
    [localColumns] = await mysql.query<ForeignKeyColumnRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_COLUMNS_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
    [referencedColumns] = await mysql.query<ForeignKeyColumnRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_COLUMNS_SQL), [
      input.schema,
      input.referencedTable,
      MAX_METADATA_RESULTS + 1,
    ]);
    [localIndexes] = await mysql.query<ForeignKeyStatisticRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_STATISTICS_SQL), [
      input.schema,
      input.table,
      MAX_INDEX_METADATA_RESULTS + 1,
    ]);
    [referencedIndexes] = await mysql.query<ForeignKeyStatisticRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_STATISTICS_SQL), [
      input.schema,
      input.referencedTable,
      MAX_INDEX_METADATA_RESULTS + 1,
    ]);
    [constraints] = await mysql.query<ForeignKeyConstraintRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_FOREIGN_KEY_CONSTRAINT_SQL), [
      input.schema,
      input.constraint,
    ]);
  } catch {
    throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  }
  const validateTable = (rows: readonly ForeignKeyTableRow[], table: string): void => {
    if (!Array.isArray(rows) || rows.length !== 1) throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
    const row = rows[0];
    if (
      !row ||
      typeof row !== 'object' ||
      row.schemaName !== input.schema ||
      row.tableName !== table ||
      !isNonEmptyString(row.tableType) ||
      (row.engine !== null && !isNonEmptyString(row.engine))
    )
      throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
    if (row.tableType !== 'BASE TABLE' || row.engine?.toUpperCase() !== 'INNODB') throw foreignKeyError('MYSQL_DDL_TABLE_INVALID');
  };
  validateTable(localTableRows, input.table);
  validateTable(referencedTableRows, input.referencedTable);
  if (!Array.isArray(constraints) || constraints.length > 1) throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  if (constraints.length === 1) {
    const constraint = constraints[0];
    if (
      !constraint ||
      constraint.schemaName !== input.schema ||
      !isNonEmptyString(constraint.tableName) ||
      constraint.constraintName !== input.constraint ||
      !isNonEmptyString(constraint.constraintType)
    )
      throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
    throw foreignKeyError('MYSQL_DDL_FOREIGN_KEY_EXISTS');
  }
  const localByName = columnsByName(localColumns);
  const referencedByName = columnsByName(referencedColumns);
  for (let index = 0; index < input.columns.length; index += 1) {
    const local = localByName.get(input.columns[index] as string);
    const referenced = referencedByName.get(input.referencedColumns[index] as string);
    if (!local || !referenced || !compatibleForeignKeyColumns(local, referenced)) throw foreignKeyError('MYSQL_DDL_COLUMN_INVALID');
  }
  if (!hasOrderedIndexPrefix(localIndexes, input.columns) || !hasUniqueExactIndex(referencedIndexes, input.referencedColumns))
    throw foreignKeyError('MYSQL_DDL_COLUMN_INVALID');
  let orphanRows: ForeignKeyOrphanRow[];
  try {
    [orphanRows] = await mysql.query<ForeignKeyOrphanRow[]>(
      queryOptions(mysql, foreignKeyOrphansSql(input.schema, input.table, input.columns, input.referencedTable, input.referencedColumns)),
    );
  } catch {
    throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  }
  if (!Array.isArray(orphanRows) || orphanRows.length !== 1 || typeof orphanRows[0] !== 'object' || orphanRows[0] === null)
    throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
  const orphanExists = orphanRows[0].orphanExists;
  if (orphanExists === 1 || orphanExists === '1') throw foreignKeyError('MYSQL_DDL_FOREIGN_KEY_ORPHANS');
  if (orphanExists !== 0 && orphanExists !== '0') throw foreignKeyError('MYSQL_DDL_METADATA_INVALID');
}
