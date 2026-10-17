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
    columns.COLUMN_KEY AS columnKey,
    columns.COLUMN_DEFAULT IS NOT NULL AS hasDefault
  FROM information_schema.TABLES AS tables
  INNER JOIN information_schema.COLUMNS AS columns
    ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
    AND columns.TABLE_NAME = tables.TABLE_NAME
  WHERE tables.TABLE_SCHEMA = ?
    AND tables.TABLE_NAME = ?
  ORDER BY columns.ORDINAL_POSITION ASC
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
  readonly hasDefault: number;
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
  readonly hasDefault: boolean;
}

export interface TableDescription {
  readonly table: TableMetadata;
  readonly columns: readonly ColumnMetadata[];
}

function queryOptions(mysql: ConnectionLayer, sql: string): Readonly<{ sql: string; timeout: number }> {
  return Object.freeze({ ...mysql.queryOptions(), sql });
}

export async function listAccessibleSchemas(mysql: ConnectionLayer): Promise<readonly SchemaMetadata[]> {
  const [rows] = await mysql.pool.query<SchemaRow[]>(queryOptions(mysql, LIST_SCHEMAS_SQL), [MAX_METADATA_RESULTS]);
  return rows.slice(0, MAX_METADATA_RESULTS).map(({ schemaName }) => ({ schemaName }));
}

export async function listAccessibleTables(mysql: ConnectionLayer, schema: string): Promise<readonly TableMetadata[]> {
  const [rows] = await mysql.pool.query<TableRow[]>(queryOptions(mysql, LIST_TABLES_SQL), [schema, MAX_METADATA_RESULTS]);
  return rows.slice(0, MAX_METADATA_RESULTS).map(({ schemaName, tableName, tableType }) => ({ schemaName, tableName, tableType }));
}

export async function describeAccessibleTable(mysql: ConnectionLayer, schema: string, table: string): Promise<TableDescription | undefined> {
  const [rows] = await mysql.pool.query<TableDescriptionRow[]>(queryOptions(mysql, DESCRIBE_TABLE_SQL), [schema, table, MAX_METADATA_RESULTS]);
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
    columns: boundedRows.map(({ columnName, dataType, isNullable, columnKey, hasDefault }) => ({
      columnName,
      dataType,
      isNullable: isNullable === 'YES',
      columnKey,
      hasDefault: hasDefault === 1,
    })),
  };
}
