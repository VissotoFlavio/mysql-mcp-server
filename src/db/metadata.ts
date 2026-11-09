import type { RowDataPacket } from 'mysql2';

import { MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS } from '../tools/alter-table-add-foreign-key-input.js';
import type { AlterTableDropColumnInput } from '../tools/alter-table-drop-column-input.js';
import type { AlterTableDropForeignKeyInput } from '../tools/alter-table-drop-foreign-key-input.js';
import type { AlterTableModifyColumnDefinition, AlterTableModifyColumnInput } from '../tools/alter-table-modify-column-input.js';
import type { CreateTableColumnType } from '../tools/create-table-input.js';

import type { ConnectionLayer } from './pool.js';

export const MAX_METADATA_RESULTS = 100;
const MAX_INDEX_METADATA_RESULTS = 1024;

const LIST_SCHEMAS_SQL = `
  SELECT SCHEMA_NAME AS schemaName
  FROM information_schema.SCHEMATA
  ORDER BY SCHEMA_NAME ASC
  LIMIT ?
`;

const VALIDATE_CREATE_SCHEMA_METADATA_SQL = `
  SELECT SCHEMA_NAME AS schemaName
  FROM information_schema.SCHEMATA
  WHERE SCHEMA_NAME = ?
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

const VALIDATE_CREATE_VIEW_TABLES_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)
  ORDER BY TABLE_NAME ASC
  LIMIT 3
`;
const VALIDATE_CREATE_VIEW_COLUMNS_SQL = `
  SELECT COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition, EXTRA AS extra
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY ORDINAL_POSITION ASC
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

const VALIDATE_ALTER_TABLE_MODIFY_COLUMN_METADATA_SQL = `
  SELECT
    tables.TABLE_SCHEMA AS schemaName,
    tables.TABLE_NAME AS tableName,
    tables.TABLE_TYPE AS tableType,
    columns.COLUMN_NAME AS columnName,
    columns.ORDINAL_POSITION AS ordinalPosition,
    columns.COLUMN_TYPE AS columnType,
    columns.CHARACTER_SET_NAME AS characterSetName,
    columns.COLLATION_NAME AS collationName,
    columns.IS_NULLABLE AS isNullable,
    columns.COLUMN_DEFAULT AS columnDefault,
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

const VALIDATE_ALTER_TABLE_MODIFY_COLUMN_STATISTICS_SQL = `
  SELECT INDEX_NAME AS indexName, SEQ_IN_INDEX AS sequenceInIndex, COLUMN_NAME AS columnName,
    SUB_PART AS subPart, EXPRESSION AS expression, INDEX_TYPE AS indexType
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_MODIFY_COLUMN_CONSTRAINTS_SQL = `
  SELECT key_columns.CONSTRAINT_NAME AS constraintName, key_columns.TABLE_NAME AS tableName,
    key_columns.COLUMN_NAME AS columnName, key_columns.REFERENCED_TABLE_NAME AS referencedTableName,
    key_columns.REFERENCED_COLUMN_NAME AS referencedColumnName, constraints.CONSTRAINT_TYPE AS constraintType
  FROM information_schema.KEY_COLUMN_USAGE AS key_columns
  INNER JOIN information_schema.TABLE_CONSTRAINTS AS constraints
    ON constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
    AND constraints.TABLE_NAME = key_columns.TABLE_NAME
    AND constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
  WHERE ((key_columns.TABLE_SCHEMA = ? AND key_columns.TABLE_NAME = ? AND key_columns.COLUMN_NAME = ?)
      OR (key_columns.REFERENCED_TABLE_SCHEMA = ? AND key_columns.REFERENCED_TABLE_NAME = ? AND key_columns.REFERENCED_COLUMN_NAME = ?))
  ORDER BY key_columns.CONSTRAINT_NAME ASC
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_MODIFY_COLUMN_CHECKS_SQL = `
  SELECT checks.CONSTRAINT_NAME AS constraintName
  FROM information_schema.CHECK_CONSTRAINTS AS checks
  INNER JOIN information_schema.TABLE_CONSTRAINTS AS constraints
    ON constraints.CONSTRAINT_SCHEMA = checks.CONSTRAINT_SCHEMA
    AND constraints.CONSTRAINT_NAME = checks.CONSTRAINT_NAME
  WHERE constraints.CONSTRAINT_SCHEMA = ?
    AND constraints.TABLE_NAME = ?
    AND constraints.CONSTRAINT_TYPE = 'CHECK'
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_DROP_COLUMN_METADATA_SQL = `
  SELECT
    tables.TABLE_SCHEMA AS schemaName,
    tables.TABLE_NAME AS tableName,
    tables.TABLE_TYPE AS tableType,
    columns.COLUMN_NAME AS columnName,
    columns.ORDINAL_POSITION AS ordinalPosition,
    columns.EXTRA AS extra,
    columns.GENERATION_EXPRESSION AS generationExpression
  FROM information_schema.TABLES AS tables
  INNER JOIN information_schema.COLUMNS AS columns
    ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
    AND columns.TABLE_NAME = tables.TABLE_NAME
  WHERE tables.TABLE_SCHEMA = ?
    AND tables.TABLE_NAME = ?
  ORDER BY columns.ORDINAL_POSITION ASC
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_DROP_COLUMN_STATISTICS_SQL = `
  SELECT INDEX_NAME AS indexName, SEQ_IN_INDEX AS sequenceInIndex, COLUMN_NAME AS columnName,
    SUB_PART AS subPart, EXPRESSION AS expression, INDEX_TYPE AS indexType
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_DROP_COLUMN_CONSTRAINTS_SQL = `
  SELECT key_columns.CONSTRAINT_NAME AS constraintName, key_columns.TABLE_NAME AS tableName,
    key_columns.COLUMN_NAME AS columnName, key_columns.REFERENCED_TABLE_NAME AS referencedTableName,
    key_columns.REFERENCED_COLUMN_NAME AS referencedColumnName, constraints.CONSTRAINT_TYPE AS constraintType
  FROM information_schema.KEY_COLUMN_USAGE AS key_columns
  INNER JOIN information_schema.TABLE_CONSTRAINTS AS constraints
    ON constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
    AND constraints.TABLE_NAME = key_columns.TABLE_NAME
    AND constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
  WHERE ((key_columns.TABLE_SCHEMA = ? AND key_columns.TABLE_NAME = ? AND key_columns.COLUMN_NAME = ?)
      OR (key_columns.REFERENCED_TABLE_SCHEMA = ? AND key_columns.REFERENCED_TABLE_NAME = ? AND key_columns.REFERENCED_COLUMN_NAME = ?))
  ORDER BY key_columns.CONSTRAINT_NAME ASC
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_DROP_COLUMN_CHECKS_SQL = `
  SELECT checks.CONSTRAINT_NAME AS constraintName, constraints.TABLE_NAME AS tableName,
    checks.CHECK_CLAUSE AS checkClause
  FROM information_schema.CHECK_CONSTRAINTS AS checks
  INNER JOIN information_schema.TABLE_CONSTRAINTS AS constraints
    ON constraints.CONSTRAINT_SCHEMA = checks.CONSTRAINT_SCHEMA
    AND constraints.CONSTRAINT_NAME = checks.CONSTRAINT_NAME
  WHERE constraints.CONSTRAINT_SCHEMA = ?
    AND constraints.TABLE_SCHEMA = ?
    AND constraints.TABLE_NAME = ?
    AND constraints.CONSTRAINT_TYPE = 'CHECK'
  LIMIT ?
`;

const VALIDATE_ALTER_TABLE_DROP_COLUMN_VIEWS_SQL = `
  SELECT VIEW_SCHEMA AS viewSchemaName, VIEW_NAME AS viewName,
    TABLE_SCHEMA AS tableSchemaName, TABLE_NAME AS tableName
  FROM information_schema.VIEW_TABLE_USAGE
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY VIEW_SCHEMA ASC, VIEW_NAME ASC
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

const VALIDATE_ALTER_TABLE_DROP_FOREIGN_KEY_TABLE_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  LIMIT 2
`;
const VALIDATE_ALTER_TABLE_DROP_FOREIGN_KEY_CONSTRAINT_SQL = `
  SELECT CONSTRAINT_SCHEMA AS schemaName, TABLE_SCHEMA AS tableSchemaName, TABLE_NAME AS tableName,
    CONSTRAINT_NAME AS constraintName, CONSTRAINT_TYPE AS constraintType
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
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

const VALIDATE_DROP_INDEX_TABLE_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  LIMIT 2
`;

const VALIDATE_DROP_VIEW_TABLE_SQL = `
  SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  LIMIT 2
`;

const VALIDATE_DROP_VIEW_DEPENDENCIES_SQL = `
  SELECT VIEW_SCHEMA AS viewSchemaName, VIEW_NAME AS viewName,
    TABLE_SCHEMA AS tableSchemaName, TABLE_NAME AS tableName
  FROM information_schema.VIEW_TABLE_USAGE
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY VIEW_SCHEMA ASC, VIEW_NAME ASC
  LIMIT ?
`;

const VALIDATE_DROP_INDEX_FOREIGN_KEYS_SQL = `
  SELECT CONSTRAINT_SCHEMA AS constraintSchemaName, TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName,
    CONSTRAINT_NAME AS constraintName, COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition,
    REFERENCED_TABLE_SCHEMA AS referencedSchemaName, REFERENCED_TABLE_NAME AS referencedTableName,
    REFERENCED_COLUMN_NAME AS referencedColumnName
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE REFERENCED_TABLE_NAME IS NOT NULL
    AND ((TABLE_SCHEMA = ? AND TABLE_NAME = ?) OR (REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?))
  ORDER BY CONSTRAINT_SCHEMA ASC, TABLE_SCHEMA ASC, TABLE_NAME ASC, CONSTRAINT_NAME ASC, ORDINAL_POSITION ASC
  LIMIT ?
`;

const VALIDATE_DROP_INDEX_STATISTICS_SQL = `
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
    INDEX_TYPE AS indexType,
    IS_VISIBLE AS isVisible
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
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
interface CreateViewColumnRow extends RowDataPacket {
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
interface DropIndexStatisticRow extends CreateIndexStatisticRow {
  readonly isVisible: 'YES' | 'NO';
}
interface DropIndexTableRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
}
interface DropViewTableRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
}
interface DropViewDependencyRow extends RowDataPacket {
  readonly viewSchemaName: string;
  readonly viewName: string;
  readonly tableSchemaName: string;
  readonly tableName: string;
}
interface DropIndexForeignKeyRow extends RowDataPacket {
  readonly constraintSchemaName: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly constraintName: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly referencedSchemaName: string;
  readonly referencedTableName: string;
  readonly referencedColumnName: string;
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
interface AlterTableModifyColumnMetadataRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly columnType: string;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  readonly isNullable: 'YES' | 'NO';
  readonly columnDefault: unknown;
  readonly extra: string;
}
interface AlterTableModifyColumnStatisticRow extends RowDataPacket {
  readonly indexName: string;
  readonly sequenceInIndex: number;
  readonly columnName: string | null;
  readonly subPart: number | null;
  readonly expression: string | null;
  readonly indexType: string;
}
interface AlterTableModifyColumnConstraintRow extends RowDataPacket {
  readonly constraintName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly referencedTableName: string | null;
  readonly referencedColumnName: string | null;
  readonly constraintType: string;
}
interface AlterTableModifyColumnCheckRow extends RowDataPacket {
  readonly constraintName: string;
}
interface AlterTableDropColumnMetadataRow extends RowDataPacket {
  readonly schemaName: string;
  readonly tableName: string;
  readonly tableType: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly extra: string;
  readonly generationExpression: string | null;
}
interface AlterTableDropColumnStatisticRow extends RowDataPacket {
  readonly indexName: string;
  readonly sequenceInIndex: number;
  readonly columnName: string | null;
  readonly subPart: number | null;
  readonly expression: string | null;
  readonly indexType: string;
}
interface AlterTableDropColumnConstraintRow extends RowDataPacket {
  readonly constraintName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly referencedTableName: string | null;
  readonly referencedColumnName: string | null;
  readonly constraintType: string;
}
interface AlterTableDropColumnCheckRow extends RowDataPacket {
  readonly constraintName: string;
  readonly tableName: string;
  readonly checkClause: string;
}
interface AlterTableDropColumnViewRow extends RowDataPacket {
  readonly viewSchemaName: string;
  readonly viewName: string;
  readonly tableSchemaName: string;
  readonly tableName: string;
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
export type CreateViewMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_COLUMN_INVALID' | 'MYSQL_DDL_TABLE_EXISTS';
export class CreateViewMetadataError extends Error {
  constructor(
    readonly code: CreateViewMetadataCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreateViewMetadataError';
  }
}

export type CreateSchemaMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_SCHEMA_EXISTS';
export class CreateSchemaMetadataError extends Error {
  constructor(
    readonly code: CreateSchemaMetadataCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreateSchemaMetadataError';
  }
}

export type DropIndexMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_STRUCTURE_INVALID';
export class DropIndexMetadataError extends Error {
  readonly code: DropIndexMetadataCode;

  constructor(code: DropIndexMetadataCode, message: string) {
    super(message);
    this.name = 'DropIndexMetadataError';
    this.code = code;
  }
}
export class DropIndexVerificationError extends Error {
  constructor() {
    super('The dropped index could not be verified.');
    this.name = 'DropIndexVerificationError';
  }
}

export type DropViewMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_STRUCTURE_INVALID';
export class DropViewMetadataError extends Error {
  constructor(
    readonly code: DropViewMetadataCode,
    message: string,
  ) {
    super(message);
    this.name = 'DropViewMetadataError';
  }
}
export class DropViewVerificationError extends Error {
  constructor() {
    super('The dropped view could not be verified.');
    this.name = 'DropViewVerificationError';
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
export type AlterTableModifyColumnMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_COLUMN_INVALID';
export class AlterTableModifyColumnMetadataError extends Error {
  readonly code: AlterTableModifyColumnMetadataCode;
  constructor(code: AlterTableModifyColumnMetadataCode, message: string) {
    super(message);
    this.name = 'AlterTableModifyColumnMetadataError';
    this.code = code;
  }
}
export class AlterTableModifyColumnVerificationError extends Error {
  constructor(message = 'The modified column could not be verified.') {
    super(message);
    this.name = 'AlterTableModifyColumnVerificationError';
  }
}
export type AlterTableDropColumnMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_COLUMN_INVALID';
export class AlterTableDropColumnMetadataError extends Error {
  readonly code: AlterTableDropColumnMetadataCode;
  constructor(code: AlterTableDropColumnMetadataCode, message: string) {
    super(message);
    this.name = 'AlterTableDropColumnMetadataError';
    this.code = code;
  }
}
export class AlterTableDropColumnVerificationError extends Error {
  constructor(message = 'The dropped column could not be verified.') {
    super(message);
    this.name = 'AlterTableDropColumnVerificationError';
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
export type AlterTableDropForeignKeyMetadataCode = 'MYSQL_DDL_METADATA_INVALID' | 'MYSQL_DDL_TABLE_INVALID' | 'MYSQL_DDL_STRUCTURE_INVALID';
export class AlterTableDropForeignKeyMetadataError extends Error {
  constructor(
    readonly code: AlterTableDropForeignKeyMetadataCode,
    message: string,
  ) {
    super(message);
    this.name = 'AlterTableDropForeignKeyMetadataError';
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
const CREATE_VIEW_METADATA_UNAVAILABLE = 'Unable to validate the requested view metadata.';
const CREATE_VIEW_METADATA_SOURCE_INVALID = 'The source must be an existing base table.';
const CREATE_VIEW_METADATA_COLUMN_INVALID = 'One or more view columns are unknown or invisible.';
const CREATE_VIEW_METADATA_EXISTS = 'The target view already exists.';
const CREATE_SCHEMA_METADATA_UNAVAILABLE = 'Unable to validate the requested schema metadata.';
const CREATE_SCHEMA_METADATA_EXISTS = 'The target schema already exists.';
const DROP_INDEX_METADATA_UNAVAILABLE = 'Unable to validate the requested index metadata.';
const DROP_INDEX_METADATA_BASE_TABLE_ONLY = 'DROP INDEX metadata is supported for base tables only.';
const DROP_INDEX_METADATA_NOT_REMOVABLE = 'The named index is not a removable secondary index.';
const DROP_VIEW_METADATA_UNAVAILABLE = 'Unable to validate the requested view metadata.';
const DROP_VIEW_METADATA_VIEW_ONLY = 'DROP VIEW is supported for existing views only.';
const DROP_VIEW_METADATA_DEPENDENCIES = 'The requested view has known dependent views.';
const ALTER_TABLE_ADD_COLUMN_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const ALTER_TABLE_ADD_COLUMN_METADATA_BASE_TABLE_ONLY = 'ALTER TABLE ADD COLUMN metadata is supported for base tables only.';
const ALTER_TABLE_ADD_COLUMN_METADATA_COLUMN_EXISTS = 'The requested column already exists.';
const ALTER_TABLE_MODIFY_COLUMN_METADATA_UNAVAILABLE = 'Unable to validate the requested column definition.';
const ALTER_TABLE_MODIFY_COLUMN_METADATA_BASE_TABLE_ONLY = 'ALTER TABLE MODIFY COLUMN is supported for base tables only.';
const ALTER_TABLE_MODIFY_COLUMN_METADATA_COLUMN_INVALID = 'The current column definition is unknown, incompatible, or has an unsupported dependency.';
const ALTER_TABLE_DROP_COLUMN_METADATA_UNAVAILABLE = 'Unable to validate the requested column metadata.';
const ALTER_TABLE_DROP_COLUMN_METADATA_TABLE_INVALID = 'ALTER TABLE DROP COLUMN is supported for base tables only.';
const ALTER_TABLE_DROP_COLUMN_METADATA_COLUMN_INVALID = 'The requested column is unknown, generated, or has an unresolved dependency.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_BASE_TABLE_ONLY = 'ALTER TABLE RENAME COLUMN metadata is supported for base tables only.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_COLUMN_INVALID = 'The source column is unknown or inaccessible.';
const ALTER_TABLE_RENAME_COLUMN_METADATA_COLUMN_EXISTS = 'The destination column already exists.';
const RENAME_TABLE_METADATA_UNAVAILABLE = 'Unable to validate the requested table metadata.';
const ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_UNAVAILABLE = 'Unable to validate the requested foreign-key metadata.';
const ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_TABLE_INVALID = 'ALTER TABLE DROP FOREIGN KEY is supported for base tables only.';
const ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_STRUCTURE_INVALID = 'The named constraint is not a foreign key on the requested table.';
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

/** @internal Preflights the target, one base-table source, and requested visible projection columns. */
export async function validateCreateViewMetadata(
  mysql: ConnectionLayer,
  schema: string,
  view: string,
  table: string,
  requestedColumns: readonly string[],
): Promise<void> {
  let tables: TableRow[];
  let columns: CreateViewColumnRow[];
  try {
    [tables] = await mysql.query<TableRow[]>(queryOptions(mysql, VALIDATE_CREATE_VIEW_TABLES_SQL), [schema, view, table]);
    [columns] = await mysql.query<CreateViewColumnRow[]>(queryOptions(mysql, VALIDATE_CREATE_VIEW_COLUMNS_SQL), [
      schema,
      table,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw new CreateViewMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_VIEW_METADATA_UNAVAILABLE);
  }
  if (!Array.isArray(tables) || tables.length > 2 || !Array.isArray(columns) || columns.length === 0 || columns.length > MAX_METADATA_RESULTS)
    throw new CreateViewMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_VIEW_METADATA_UNAVAILABLE);
  let source: TableRow | undefined;
  for (const row of tables) {
    if (!row || row.schemaName !== schema || !isNonEmptyString(row.tableName) || !isNonEmptyString(row.tableType))
      throw new CreateViewMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_VIEW_METADATA_UNAVAILABLE);
    if (row.tableName === view) throw new CreateViewMetadataError('MYSQL_DDL_TABLE_EXISTS', CREATE_VIEW_METADATA_EXISTS);
    if (row.tableName !== table || source !== undefined)
      throw new CreateViewMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_VIEW_METADATA_UNAVAILABLE);
    source = row;
  }
  if (source === undefined || source.tableType !== 'BASE TABLE')
    throw new CreateViewMetadataError('MYSQL_DDL_TABLE_INVALID', CREATE_VIEW_METADATA_SOURCE_INVALID);
  const names = new Set<string>();
  const visibleNames = new Set<string>();
  const ordinals = new Set<number>();
  for (const column of columns) {
    if (
      !column ||
      !isNonEmptyString(column.columnName) ||
      !Number.isInteger(column.ordinalPosition) ||
      column.ordinalPosition <= 0 ||
      typeof column.extra !== 'string' ||
      names.has(column.columnName) ||
      ordinals.has(column.ordinalPosition)
    )
      throw new CreateViewMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_VIEW_METADATA_UNAVAILABLE);
    names.add(column.columnName);
    if (!/(^|\s)invisible(?=\s|$)/iu.test(column.extra)) visibleNames.add(column.columnName);
    ordinals.add(column.ordinalPosition);
  }
  if ([...ordinals].sort((left, right) => left - right).some((ordinal, position) => ordinal !== position + 1))
    throw new CreateViewMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_VIEW_METADATA_UNAVAILABLE);
  if (requestedColumns.some((column) => !visibleNames.has(column)))
    throw new CreateViewMetadataError('MYSQL_DDL_COLUMN_INVALID', CREATE_VIEW_METADATA_COLUMN_INVALID);
}

/** @internal Reads bounded information_schema metadata before one CREATE SCHEMA attempt. */
export async function validateCreateSchemaMetadata(mysql: ConnectionLayer, schema: string): Promise<void> {
  let rows: SchemaRow[];
  try {
    [rows] = await mysql.query<SchemaRow[]>(queryOptions(mysql, VALIDATE_CREATE_SCHEMA_METADATA_SQL), [schema, 2]);
  } catch {
    throw new CreateSchemaMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_SCHEMA_METADATA_UNAVAILABLE);
  }
  if (!Array.isArray(rows) || rows.length > 1) throw new CreateSchemaMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_SCHEMA_METADATA_UNAVAILABLE);
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || row.schemaName !== schema) {
      throw new CreateSchemaMetadataError('MYSQL_DDL_METADATA_INVALID', CREATE_SCHEMA_METADATA_UNAVAILABLE);
    }
  }
  if (rows.length === 1) throw new CreateSchemaMetadataError('MYSQL_DDL_SCHEMA_EXISTS', CREATE_SCHEMA_METADATA_EXISTS);
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

type DropIndexDefinition = Readonly<{
  name: string;
  nonUnique: number;
  columns: readonly string[];
  supported: boolean;
}>;

function dropIndexMetadataError(code: DropIndexMetadataCode): DropIndexMetadataError {
  return new DropIndexMetadataError(
    code,
    code === 'MYSQL_DDL_TABLE_INVALID'
      ? DROP_INDEX_METADATA_BASE_TABLE_ONLY
      : code === 'MYSQL_DDL_STRUCTURE_INVALID'
        ? DROP_INDEX_METADATA_NOT_REMOVABLE
        : DROP_INDEX_METADATA_UNAVAILABLE,
  );
}

function dropViewMetadataError(code: DropViewMetadataCode): DropViewMetadataError {
  return new DropViewMetadataError(
    code,
    code === 'MYSQL_DDL_TABLE_INVALID'
      ? DROP_VIEW_METADATA_VIEW_ONLY
      : code === 'MYSQL_DDL_STRUCTURE_INVALID'
        ? DROP_VIEW_METADATA_DEPENDENCIES
        : DROP_VIEW_METADATA_UNAVAILABLE,
  );
}

function validateDropIndexStatisticRow(row: unknown, schema: string, table: string): row is DropIndexStatisticRow {
  if (typeof row !== 'object' || row === null) return false;
  const statistic = row as DropIndexStatisticRow;
  const subPart = statistic.subPart;
  return (
    isNonEmptyString(statistic.schemaName) &&
    isNonEmptyString(statistic.tableName) &&
    isNonEmptyString(statistic.indexName) &&
    Number.isInteger(statistic.nonUnique) &&
    [0, 1].includes(statistic.nonUnique) &&
    Number.isInteger(statistic.sequenceInIndex) &&
    statistic.sequenceInIndex > 0 &&
    statistic.sequenceInIndex <= 16 &&
    (statistic.collation === null || ['A', 'D'].includes(statistic.collation)) &&
    (statistic.columnName === null || isNonEmptyString(statistic.columnName)) &&
    (subPart === null || (typeof subPart === 'number' && Number.isInteger(subPart) && subPart > 0)) &&
    (statistic.expression === null || isNonEmptyString(statistic.expression)) &&
    isNonEmptyString(statistic.indexType) &&
    ['YES', 'NO'].includes(statistic.isVisible) &&
    statistic.schemaName === schema &&
    statistic.tableName === table
  );
}

function orderedDropIndexGroups(statistics: readonly DropIndexStatisticRow[]): Map<string, readonly DropIndexStatisticRow[]> {
  const groups = new Map<string, DropIndexStatisticRow[]>();
  for (const statistic of statistics) {
    const key = normalizedIdentifierName(statistic.indexName);
    const entries = groups.get(key) ?? [];
    if (entries.some((entry) => entry.sequenceInIndex === statistic.sequenceInIndex)) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    entries.push(statistic);
    groups.set(key, entries);
  }
  const ordered = new Map<string, readonly DropIndexStatisticRow[]>();
  for (const [key, entries] of groups) {
    const values = [...entries].sort((left, right) => left.sequenceInIndex - right.sequenceInIndex);
    if (values.some((entry, position) => entry.sequenceInIndex !== position + 1)) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    if (values.some((entry) => entry.nonUnique !== values[0]?.nonUnique)) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    ordered.set(key, values);
  }
  return ordered;
}

function dropIndexDefinition(entries: readonly DropIndexStatisticRow[]): DropIndexDefinition {
  return Object.freeze({
    name: entries[0]?.indexName ?? '',
    nonUnique: entries[0]?.nonUnique ?? -1,
    columns: Object.freeze(entries.map((entry) => entry.columnName ?? '')),
    supported:
      entries.length > 0 &&
      entries.every(
        (entry) =>
          entry.columnName !== null &&
          entry.subPart === null &&
          entry.expression === null &&
          entry.collation === 'A' &&
          entry.indexType.toUpperCase() === 'BTREE' &&
          entry.isVisible === 'YES',
      ),
  });
}

function sameDropIndexColumns(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((column, position) => normalizedIdentifierName(column) === normalizedIdentifierName(right[position] ?? ''))
  );
}

function hasForeignKeyPrefix(indexColumns: readonly string[], foreignKeyColumns: readonly string[]): boolean {
  return (
    foreignKeyColumns.length > 0 &&
    indexColumns.length >= foreignKeyColumns.length &&
    foreignKeyColumns.every((column, position) => normalizedIdentifierName(indexColumns[position] ?? '') === normalizedIdentifierName(column))
  );
}

async function readDropIndexStatistics(
  mysql: ConnectionLayer,
  schema: string,
  table: string,
): Promise<Map<string, readonly DropIndexStatisticRow[]>> {
  let statistics: DropIndexStatisticRow[];
  try {
    [statistics] = await mysql.query<DropIndexStatisticRow[]>(queryOptions(mysql, VALIDATE_DROP_INDEX_STATISTICS_SQL), [
      schema,
      table,
      MAX_INDEX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
  }
  if (!Array.isArray(statistics) || statistics.length > MAX_INDEX_METADATA_RESULTS) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
  for (const statistic of statistics) {
    if (!validateDropIndexStatisticRow(statistic, schema, table)) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
  }
  return orderedDropIndexGroups(statistics);
}

/** @internal Validates that one named index is a removable secondary B-tree. */
export async function validateDropIndexMetadata(mysql: ConnectionLayer, schema: string, table: string, index: string): Promise<void> {
  let tables: DropIndexTableRow[];
  let foreignKeys: DropIndexForeignKeyRow[];
  try {
    [tables] = await mysql.query<DropIndexTableRow[]>(queryOptions(mysql, VALIDATE_DROP_INDEX_TABLE_SQL), [schema, table]);
    [foreignKeys] = await mysql.query<DropIndexForeignKeyRow[]>(queryOptions(mysql, VALIDATE_DROP_INDEX_FOREIGN_KEYS_SQL), [
      schema,
      table,
      schema,
      table,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
  }
  if (!Array.isArray(tables) || tables.length > 1) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
  const tableRow = tables[0];
  if (
    tableRow === undefined ||
    !isNonEmptyString(tableRow.schemaName) ||
    !isNonEmptyString(tableRow.tableName) ||
    !isNonEmptyString(tableRow.tableType) ||
    tableRow.schemaName !== schema ||
    tableRow.tableName !== table
  )
    throw dropIndexMetadataError('MYSQL_DDL_TABLE_INVALID');
  if (tableRow.tableType !== 'BASE TABLE') throw dropIndexMetadataError('MYSQL_DDL_TABLE_INVALID');
  if (!Array.isArray(foreignKeys) || foreignKeys.length > MAX_METADATA_RESULTS) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');

  const groups = await readDropIndexStatistics(mysql, schema, table);
  const targetEntries = groups.get(normalizedIdentifierName(index));
  if (targetEntries === undefined || targetEntries.length === 0) throw dropIndexMetadataError('MYSQL_DDL_STRUCTURE_INVALID');
  const target = dropIndexDefinition(targetEntries);
  if (normalizedIdentifierName(index) === 'primary' || target.nonUnique !== 1 || !target.supported) {
    throw dropIndexMetadataError('MYSQL_DDL_STRUCTURE_INVALID');
  }

  for (const entries of groups.values()) {
    const candidate = dropIndexDefinition(entries);
    if (candidate.nonUnique === 0 && candidate.supported && sameDropIndexColumns(target.columns, candidate.columns))
      throw dropIndexMetadataError('MYSQL_DDL_STRUCTURE_INVALID');
  }

  const foreignKeyGroups = new Map<string, DropIndexForeignKeyRow[]>();
  for (const row of foreignKeys) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.constraintSchemaName) ||
      !isNonEmptyString(row.schemaName) ||
      !isNonEmptyString(row.tableName) ||
      !isNonEmptyString(row.constraintName) ||
      !isNonEmptyString(row.columnName) ||
      !Number.isInteger(row.ordinalPosition) ||
      row.ordinalPosition <= 0 ||
      row.ordinalPosition > 16 ||
      !isNonEmptyString(row.referencedSchemaName) ||
      !isNonEmptyString(row.referencedTableName) ||
      !isNonEmptyString(row.referencedColumnName) ||
      row.constraintSchemaName !== row.schemaName ||
      ((row.schemaName !== schema || row.tableName !== table) && (row.referencedSchemaName !== schema || row.referencedTableName !== table))
    )
      throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    const key = JSON.stringify([row.constraintSchemaName, row.schemaName, row.tableName, row.constraintName]);
    const entries = foreignKeyGroups.get(key) ?? [];
    if (entries.some((entry) => entry.ordinalPosition === row.ordinalPosition)) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    entries.push(row);
    foreignKeyGroups.set(key, entries);
  }
  for (const entries of foreignKeyGroups.values()) {
    const ordered = [...entries].sort((left, right) => left.ordinalPosition - right.ordinalPosition);
    if (ordered.some((entry, position) => entry.ordinalPosition !== position + 1)) throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    const sourceIsTarget = ordered.every((entry) => entry.schemaName === schema && entry.tableName === table);
    const referencedIsTarget = ordered.every((entry) => entry.referencedSchemaName === schema && entry.referencedTableName === table);
    if (
      (!sourceIsTarget && ordered.some((entry) => entry.schemaName === schema && entry.tableName === table)) ||
      (!referencedIsTarget && ordered.some((entry) => entry.referencedSchemaName === schema && entry.referencedTableName === table))
    )
      throw dropIndexMetadataError('MYSQL_DDL_METADATA_INVALID');
    if (
      (sourceIsTarget &&
        hasForeignKeyPrefix(
          target.columns,
          ordered.map((entry) => entry.columnName),
        )) ||
      (referencedIsTarget &&
        hasForeignKeyPrefix(
          target.columns,
          ordered.map((entry) => entry.referencedColumnName),
        ))
    )
      throw dropIndexMetadataError('MYSQL_DDL_STRUCTURE_INVALID');
  }
}

/** @internal Confirms that the named index no longer exists after DROP INDEX. */
export async function verifyDropIndexMetadata(mysql: ConnectionLayer, schema: string, table: string, index: string): Promise<void> {
  try {
    const groups = await readDropIndexStatistics(mysql, schema, table);
    if (groups.has(normalizedIdentifierName(index))) throw new DropIndexVerificationError();
  } catch (error) {
    if (error instanceof DropIndexVerificationError) throw error;
    throw new DropIndexVerificationError();
  }
}

/** @internal Validates one existing view and rejects known dependent views before DROP VIEW. */
export async function validateDropViewMetadata(mysql: ConnectionLayer, schema: string, view: string): Promise<void> {
  let tables: DropViewTableRow[];
  let dependencies: DropViewDependencyRow[];
  try {
    [tables] = await mysql.query<DropViewTableRow[]>(queryOptions(mysql, VALIDATE_DROP_VIEW_TABLE_SQL), [schema, view]);
    [dependencies] = await mysql.query<DropViewDependencyRow[]>(queryOptions(mysql, VALIDATE_DROP_VIEW_DEPENDENCIES_SQL), [
      schema,
      view,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw dropViewMetadataError('MYSQL_DDL_METADATA_INVALID');
  }
  if (!Array.isArray(tables) || tables.length > 1 || !Array.isArray(dependencies) || dependencies.length > MAX_METADATA_RESULTS)
    throw dropViewMetadataError('MYSQL_DDL_METADATA_INVALID');
  const target = tables[0];
  if (
    target === undefined ||
    !isNonEmptyString(target.schemaName) ||
    !isNonEmptyString(target.tableName) ||
    !isNonEmptyString(target.tableType) ||
    target.schemaName !== schema ||
    target.tableName !== view ||
    target.tableType !== 'VIEW'
  )
    throw dropViewMetadataError('MYSQL_DDL_TABLE_INVALID');

  for (const dependency of dependencies) {
    if (
      typeof dependency !== 'object' ||
      dependency === null ||
      !isNonEmptyString(dependency.viewSchemaName) ||
      !isNonEmptyString(dependency.viewName) ||
      !isNonEmptyString(dependency.tableSchemaName) ||
      !isNonEmptyString(dependency.tableName) ||
      dependency.tableSchemaName !== schema ||
      dependency.tableName !== view ||
      (dependency.viewSchemaName === schema && dependency.viewName === view)
    )
      throw dropViewMetadataError('MYSQL_DDL_METADATA_INVALID');
  }
  if (dependencies.length > 0) throw dropViewMetadataError('MYSQL_DDL_STRUCTURE_INVALID');
}

/** @internal Confirms that the named view no longer exists after DROP VIEW. */
export async function verifyDropViewMetadata(mysql: ConnectionLayer, schema: string, view: string): Promise<void> {
  try {
    const [tables] = await mysql.query<DropViewTableRow[]>(queryOptions(mysql, VALIDATE_DROP_VIEW_TABLE_SQL), [schema, view]);
    if (!Array.isArray(tables) || tables.length > 0) throw new DropViewVerificationError();
  } catch (error) {
    if (error instanceof DropViewVerificationError) throw error;
    throw new DropViewVerificationError();
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

const INTEGER_TYPE_RANK: Readonly<Record<string, number>> = Object.freeze({ tinyint: 1, smallint: 2, mediumint: 3, int: 4, bigint: 5 });

function parseAlterTableModifyColumnType(value: unknown): CreateTableColumnType | undefined {
  if (typeof value !== 'string') return undefined;
  const type = value.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
  if (type === 'tinyint(1)') return { kind: 'boolean' };
  const integer = /^(tinyint|smallint|mediumint|int|bigint)( unsigned)?$/u.exec(type);
  if (integer !== null)
    return {
      kind: 'integer',
      integerType: integer[1] as 'tinyint' | 'smallint' | 'mediumint' | 'int' | 'bigint',
      ...(integer[2] ? { unsigned: true } : {}),
    };
  const decimal = /^decimal\(([0-9]+),([0-9]+)\)$/u.exec(type);
  if (decimal !== null) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    if (
      Number.isSafeInteger(precision) &&
      precision >= 1 &&
      precision <= 65 &&
      Number.isSafeInteger(scale) &&
      scale >= 0 &&
      scale <= Math.min(30, precision)
    )
      return { kind: 'decimal', precision, scale };
    return undefined;
  }
  const text = /^(char|varchar)\(([0-9]+)\)$/u.exec(type);
  if (text !== null) {
    const length = Number(text[2]);
    return Number.isSafeInteger(length) && length >= 1 && length <= 255 ? { kind: text[1] as 'char' | 'varchar', length } : undefined;
  }
  if (type === 'text' || type === 'date' || type === 'json') return { kind: type };
  const temporal = /^(time|datetime|timestamp)(?:\(([0-6])\))?$/u.exec(type);
  if (temporal !== null)
    return temporal[2] === undefined
      ? { kind: temporal[1] as 'time' | 'datetime' | 'timestamp' }
      : { kind: temporal[1] as 'time' | 'datetime' | 'timestamp', fractionalSecondsPrecision: Number(temporal[2]) };
  return undefined;
}

function alterTableModifyColumnMetadataError(code: AlterTableModifyColumnMetadataCode): AlterTableModifyColumnMetadataError {
  return new AlterTableModifyColumnMetadataError(
    code,
    code === 'MYSQL_DDL_TABLE_INVALID'
      ? ALTER_TABLE_MODIFY_COLUMN_METADATA_BASE_TABLE_ONLY
      : code === 'MYSQL_DDL_COLUMN_INVALID'
        ? ALTER_TABLE_MODIFY_COLUMN_METADATA_COLUMN_INVALID
        : ALTER_TABLE_MODIFY_COLUMN_METADATA_UNAVAILABLE,
  );
}

function isWideningColumnType(current: CreateTableColumnType, target: CreateTableColumnType): boolean {
  if (current.kind === 'integer' && target.kind === 'integer') {
    return current.unsigned === target.unsigned && INTEGER_TYPE_RANK[target.integerType] > INTEGER_TYPE_RANK[current.integerType];
  }
  if (current.kind === 'decimal' && target.kind === 'decimal') return current.scale === target.scale && target.precision > current.precision;
  if ((current.kind === 'char' || current.kind === 'varchar') && current.kind === target.kind) return target.length > current.length;
  if ((current.kind === 'time' || current.kind === 'datetime' || current.kind === 'timestamp') && current.kind === target.kind) {
    const currentPrecision = current.fractionalSecondsPrecision ?? 0;
    const targetPrecision = target.fractionalSecondsPrecision ?? 0;
    return targetPrecision > currentPrecision;
  }
  return false;
}

/** @internal Reads bounded metadata and dependency information before one MODIFY COLUMN attempt. */
export async function validateAlterTableModifyColumnMetadata(
  mysql: ConnectionLayer,
  input: AlterTableModifyColumnInput,
): Promise<AlterTableModifyColumnInput> {
  let rows: AlterTableModifyColumnMetadataRow[];
  let statistics: AlterTableModifyColumnStatisticRow[];
  let constraints: AlterTableModifyColumnConstraintRow[];
  let checks: AlterTableModifyColumnCheckRow[];
  try {
    [rows] = await mysql.query<AlterTableModifyColumnMetadataRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_MODIFY_COLUMN_METADATA_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
    [statistics] = await mysql.query<AlterTableModifyColumnStatisticRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_MODIFY_COLUMN_STATISTICS_SQL), [
      input.schema,
      input.table,
      MAX_INDEX_METADATA_RESULTS + 1,
    ]);
    [constraints] = await mysql.query<AlterTableModifyColumnConstraintRow[]>(
      queryOptions(mysql, VALIDATE_ALTER_TABLE_MODIFY_COLUMN_CONSTRAINTS_SQL),
      [input.schema, input.table, input.column, input.schema, input.table, input.column, MAX_METADATA_RESULTS + 1],
    );
    [checks] = await mysql.query<AlterTableModifyColumnCheckRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_MODIFY_COLUMN_CHECKS_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  }

  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    rows.length > MAX_METADATA_RESULTS ||
    !Array.isArray(statistics) ||
    statistics.length > MAX_INDEX_METADATA_RESULTS ||
    !Array.isArray(constraints) ||
    constraints.length > MAX_METADATA_RESULTS ||
    !Array.isArray(checks) ||
    checks.length > MAX_METADATA_RESULTS
  )
    throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  const first = rows[0];
  if (first === undefined || typeof first !== 'object' || first === null) throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  const names = new Set<string>();
  const ordinals = new Set<number>();
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
      !isNonEmptyString(row.columnType) ||
      (row.characterSetName !== null && !isNonEmptyString(row.characterSetName)) ||
      (row.collationName !== null && !isNonEmptyString(row.collationName)) ||
      !['YES', 'NO'].includes(row.isNullable) ||
      (row.columnDefault !== null && !['string', 'number', 'boolean'].includes(typeof row.columnDefault)) ||
      typeof row.extra !== 'string' ||
      row.schemaName !== input.schema ||
      row.tableName !== input.table ||
      row.tableType !== first.tableType ||
      names.has(normalizedIdentifierName(row.columnName)) ||
      ordinals.has(row.ordinalPosition)
    )
      throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    names.add(normalizedIdentifierName(row.columnName));
    ordinals.add(row.ordinalPosition);
  }
  if ([...ordinals].sort((left, right) => left - right).some((ordinal, position) => ordinal !== position + 1))
    throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  if (first.tableType !== 'BASE TABLE') throw alterTableModifyColumnMetadataError('MYSQL_DDL_TABLE_INVALID');

  const source = rows.find((row) => normalizedIdentifierName(row.columnName) === normalizedIdentifierName(input.column));
  if (source === undefined) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  const currentType = parseAlterTableModifyColumnType(source.columnType);
  if (currentType === undefined) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  const extra = source.extra.trim().toLowerCase();
  const autoIncrement = /(^|\s)auto_increment(\s|$)/u.test(extra);
  const otherExtra = extra.replace(/(^|\s)auto_increment(?=\s|$)/gu, ' ').trim();
  if (otherExtra.length > 0 || source.columnDefault !== null || /(^|\s)(?:virtual|stored)\s+generated(?=\s|$)|(^|\s)invisible(?=\s|$)/u.test(extra))
    throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  if (autoIncrement !== (input.definition.autoIncrement === true)) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  if (source.isNullable === 'YES' && input.definition.nullable === false) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  const typeWidening = isWideningColumnType(currentType, input.definition.type);
  const typeUnchanged = source.columnType.trim().replaceAll(/\s+/gu, ' ').toLowerCase() === renderColumnTypeForMetadata(input.definition.type);
  const nullabilityWidening = source.isNullable === 'NO' && input.definition.nullable === true;
  if (!typeWidening && !typeUnchanged) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  if (!typeWidening && !nullabilityWidening) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  if (typeWidening && typeUnchanged) throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');

  let preparedDefinition: AlterTableModifyColumnDefinition = input.definition;
  if (currentType.kind === 'char' || currentType.kind === 'varchar' || currentType.kind === 'text') {
    if (source.characterSetName === null || source.collationName === null) throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    if (
      (input.definition.characterSet !== undefined && input.definition.characterSet.toLowerCase() !== source.characterSetName.toLowerCase()) ||
      (input.definition.collation !== undefined && input.definition.collation.toLowerCase() !== source.collationName.toLowerCase())
    )
      throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
    preparedDefinition = Object.freeze({ ...input.definition, characterSet: source.characterSetName, collation: source.collationName });
  } else if (input.definition.characterSet !== undefined || input.definition.collation !== undefined) {
    throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }

  const indexNames = new Map<string, Set<number>>();
  for (const statistic of statistics) {
    if (
      typeof statistic !== 'object' ||
      statistic === null ||
      !isNonEmptyString(statistic.indexName) ||
      !Number.isInteger(statistic.sequenceInIndex) ||
      statistic.sequenceInIndex <= 0 ||
      !isNonEmptyString(statistic.columnName) ||
      statistic.subPart !== null ||
      statistic.expression !== null ||
      !isNonEmptyString(statistic.indexType) ||
      statistic.indexType.toUpperCase() !== 'BTREE'
    )
      throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
    if (statistic.columnName !== source.columnName) continue;
    const positions = indexNames.get(statistic.indexName) ?? new Set<number>();
    if (positions.has(statistic.sequenceInIndex)) throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    positions.add(statistic.sequenceInIndex);
    indexNames.set(statistic.indexName, positions);
  }
  for (const constraint of constraints) {
    if (
      typeof constraint !== 'object' ||
      constraint === null ||
      !isNonEmptyString(constraint.constraintName) ||
      !isNonEmptyString(constraint.tableName) ||
      !isNonEmptyString(constraint.columnName) ||
      (constraint.referencedTableName !== null && !isNonEmptyString(constraint.referencedTableName)) ||
      (constraint.referencedColumnName !== null && !isNonEmptyString(constraint.referencedColumnName)) ||
      !isNonEmptyString(constraint.constraintType)
    )
      throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    const constraintType = constraint.constraintType.toUpperCase();
    if (constraintType === 'FOREIGN KEY' || (constraintType === 'PRIMARY KEY' && input.definition.nullable))
      throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }
  for (const check of checks) {
    if (typeof check !== 'object' || check === null || !isNonEmptyString(check.constraintName))
      throw alterTableModifyColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    throw alterTableModifyColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }
  return Object.freeze({ ...input, definition: preparedDefinition });
}

/** @internal Verifies the bounded column definition after the DDL returns. */
export async function verifyAlterTableModifyColumnMetadata(mysql: ConnectionLayer, input: AlterTableModifyColumnInput): Promise<void> {
  let rows: AlterTableModifyColumnMetadataRow[];
  try {
    [rows] = await mysql.query<AlterTableModifyColumnMetadataRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_MODIFY_COLUMN_METADATA_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw new AlterTableModifyColumnVerificationError();
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_METADATA_RESULTS) throw new AlterTableModifyColumnVerificationError();
  const source = rows.find(
    (row) => typeof row.columnName === 'string' && normalizedIdentifierName(row.columnName) === normalizedIdentifierName(input.column),
  );
  if (source === undefined || source.tableType !== 'BASE TABLE') throw new AlterTableModifyColumnVerificationError();
  const currentType = parseAlterTableModifyColumnType(source.columnType);
  if (currentType === undefined || renderColumnTypeForMetadata(currentType) !== renderColumnTypeForMetadata(input.definition.type))
    throw new AlterTableModifyColumnVerificationError();
  if (source.isNullable !== (input.definition.nullable ? 'YES' : 'NO')) throw new AlterTableModifyColumnVerificationError();
  const currentAutoIncrement = /(^|\s)auto_increment(\s|$)/u.test(source.extra.trim().toLowerCase());
  if (currentAutoIncrement !== (input.definition.autoIncrement === true)) throw new AlterTableModifyColumnVerificationError();
  if (input.definition.characterSet !== undefined || input.definition.collation !== undefined) {
    if (
      source.characterSetName?.toLowerCase() !== input.definition.characterSet?.toLowerCase() ||
      source.collationName?.toLowerCase() !== input.definition.collation?.toLowerCase()
    )
      throw new AlterTableModifyColumnVerificationError();
  }
}

function renderColumnTypeForMetadata(type: CreateTableColumnType): string {
  switch (type.kind) {
    case 'integer':
      return `${type.integerType}${type.unsigned === true ? ' unsigned' : ''}`;
    case 'decimal':
      return `decimal(${type.precision},${type.scale})`;
    case 'char':
    case 'varchar':
      return `${type.kind}(${type.length})`;
    case 'text':
      return 'text';
    case 'date':
      return 'date';
    case 'boolean':
      return 'tinyint(1)';
    case 'json':
      return 'json';
    case 'time':
    case 'datetime':
    case 'timestamp':
      return `${type.kind}${type.fractionalSecondsPrecision === undefined ? '' : `(${type.fractionalSecondsPrecision})`}`;
  }
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

function alterTableDropColumnMetadataError(code: AlterTableDropColumnMetadataCode): AlterTableDropColumnMetadataError {
  return new AlterTableDropColumnMetadataError(
    code,
    code === 'MYSQL_DDL_TABLE_INVALID'
      ? ALTER_TABLE_DROP_COLUMN_METADATA_TABLE_INVALID
      : code === 'MYSQL_DDL_COLUMN_INVALID'
        ? ALTER_TABLE_DROP_COLUMN_METADATA_COLUMN_INVALID
        : ALTER_TABLE_DROP_COLUMN_METADATA_UNAVAILABLE,
  );
}

function validDropColumnMetadataRows(rows: readonly AlterTableDropColumnMetadataRow[], input: AlterTableDropColumnInput): void {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_METADATA_RESULTS)
    throw alterTableDropColumnMetadataError(rows.length === 0 ? 'MYSQL_DDL_TABLE_INVALID' : 'MYSQL_DDL_METADATA_INVALID');
  const first = rows[0];
  if (first === undefined || typeof first !== 'object' || first === null) throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  const names = new Set<string>();
  const ordinals = new Set<number>();
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
      typeof row.extra !== 'string' ||
      (row.generationExpression !== null && typeof row.generationExpression !== 'string') ||
      normalizedIdentifierName(row.schemaName) !== normalizedIdentifierName(input.schema) ||
      normalizedIdentifierName(row.tableName) !== normalizedIdentifierName(input.table) ||
      row.tableType !== first.tableType ||
      names.has(normalizedIdentifierName(row.columnName)) ||
      ordinals.has(row.ordinalPosition)
    )
      throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    names.add(normalizedIdentifierName(row.columnName));
    ordinals.add(row.ordinalPosition);
  }
  if ([...ordinals].sort((left, right) => left - right).some((ordinal, position) => ordinal !== position + 1))
    throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  if (first.tableType !== 'BASE TABLE') throw alterTableDropColumnMetadataError('MYSQL_DDL_TABLE_INVALID');
  const matches = rows.filter((row) => normalizedIdentifierName(row.columnName) === normalizedIdentifierName(input.column));
  if (matches.length !== 1) throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  if (/(^|\s)(?:virtual|stored)\s+generated(?=\s|$)/iu.test(matches[0]?.extra ?? ''))
    throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  if (rows.some((row) => row.generationExpression !== null && row.generationExpression.length > 0))
    throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
}

function validDropColumnStatistics(rows: readonly AlterTableDropColumnStatisticRow[], input: AlterTableDropColumnInput): void {
  if (!Array.isArray(rows) || rows.length > MAX_INDEX_METADATA_RESULTS) throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.indexName) ||
      !Number.isInteger(row.sequenceInIndex) ||
      row.sequenceInIndex <= 0 ||
      (row.columnName !== null && !isNonEmptyString(row.columnName)) ||
      (row.subPart !== null && (!Number.isInteger(row.subPart) || row.subPart <= 0)) ||
      (row.expression !== null && !isNonEmptyString(row.expression)) ||
      !isNonEmptyString(row.indexType)
    )
      throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    if (row.expression !== null || normalizedIdentifierName(row.columnName ?? '') === normalizedIdentifierName(input.column))
      throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }
}

function validDropColumnConstraints(rows: readonly AlterTableDropColumnConstraintRow[]): void {
  if (!Array.isArray(rows) || rows.length > MAX_METADATA_RESULTS) throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.constraintName) ||
      !isNonEmptyString(row.tableName) ||
      !isNonEmptyString(row.columnName) ||
      (row.referencedTableName !== null && !isNonEmptyString(row.referencedTableName)) ||
      (row.referencedColumnName !== null && !isNonEmptyString(row.referencedColumnName)) ||
      !isNonEmptyString(row.constraintType)
    )
      throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }
}

function validDropColumnChecks(rows: readonly AlterTableDropColumnCheckRow[], input: AlterTableDropColumnInput): void {
  if (!Array.isArray(rows) || rows.length > MAX_METADATA_RESULTS) throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.constraintName) ||
      row.tableName !== input.table ||
      !isNonEmptyString(row.checkClause)
    )
      throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }
}

function validDropColumnViews(rows: readonly AlterTableDropColumnViewRow[], input: AlterTableDropColumnInput): void {
  if (!Array.isArray(rows) || rows.length > MAX_METADATA_RESULTS) throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !isNonEmptyString(row.viewSchemaName) ||
      !isNonEmptyString(row.viewName) ||
      !isNonEmptyString(row.tableSchemaName) ||
      !isNonEmptyString(row.tableName) ||
      normalizedIdentifierName(row.tableSchemaName) !== normalizedIdentifierName(input.schema) ||
      normalizedIdentifierName(row.tableName) !== normalizedIdentifierName(input.table)
    )
      throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
    throw alterTableDropColumnMetadataError('MYSQL_DDL_COLUMN_INVALID');
  }
}

/** @internal Reads bounded metadata and known dependencies before one DROP COLUMN attempt. */
export async function validateAlterTableDropColumnMetadata(mysql: ConnectionLayer, input: AlterTableDropColumnInput): Promise<void> {
  let rows: AlterTableDropColumnMetadataRow[];
  let statistics: AlterTableDropColumnStatisticRow[];
  let constraints: AlterTableDropColumnConstraintRow[];
  let checks: AlterTableDropColumnCheckRow[];
  let views: AlterTableDropColumnViewRow[];
  try {
    [rows] = await mysql.query<AlterTableDropColumnMetadataRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_COLUMN_METADATA_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
    [statistics] = await mysql.query<AlterTableDropColumnStatisticRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_COLUMN_STATISTICS_SQL), [
      input.schema,
      input.table,
      MAX_INDEX_METADATA_RESULTS + 1,
    ]);
    [constraints] = await mysql.query<AlterTableDropColumnConstraintRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_COLUMN_CONSTRAINTS_SQL), [
      input.schema,
      input.table,
      input.column,
      input.schema,
      input.table,
      input.column,
      MAX_METADATA_RESULTS + 1,
    ]);
    [checks] = await mysql.query<AlterTableDropColumnCheckRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_COLUMN_CHECKS_SQL), [
      input.schema,
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
    [views] = await mysql.query<AlterTableDropColumnViewRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_COLUMN_VIEWS_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
  } catch {
    throw alterTableDropColumnMetadataError('MYSQL_DDL_METADATA_INVALID');
  }
  validDropColumnMetadataRows(rows, input);
  validDropColumnStatistics(statistics, input);
  validDropColumnConstraints(constraints);
  validDropColumnChecks(checks, input);
  validDropColumnViews(views, input);
}

/** @internal Confirms that the target table remains a base table and the dropped column is absent. */
export async function verifyAlterTableDropColumnMetadata(mysql: ConnectionLayer, input: AlterTableDropColumnInput): Promise<void> {
  try {
    const [rows] = await mysql.query<AlterTableDropColumnMetadataRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_COLUMN_METADATA_SQL), [
      input.schema,
      input.table,
      MAX_METADATA_RESULTS + 1,
    ]);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_METADATA_RESULTS) throw new AlterTableDropColumnVerificationError();
    const first = rows[0];
    if (first === undefined || typeof first !== 'object' || first === null || first.tableType !== 'BASE TABLE')
      throw new AlterTableDropColumnVerificationError();
    const names = new Set<string>();
    const ordinals = new Set<number>();
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !isNonEmptyString(row.schemaName) ||
        !isNonEmptyString(row.tableName) ||
        row.schemaName !== input.schema ||
        row.tableName !== input.table ||
        row.tableType !== 'BASE TABLE' ||
        !isNonEmptyString(row.columnName) ||
        !Number.isInteger(row.ordinalPosition) ||
        row.ordinalPosition <= 0 ||
        typeof row.extra !== 'string' ||
        (row.generationExpression !== null && typeof row.generationExpression !== 'string') ||
        names.has(normalizedIdentifierName(row.columnName)) ||
        ordinals.has(row.ordinalPosition)
      )
        throw new AlterTableDropColumnVerificationError();
      names.add(normalizedIdentifierName(row.columnName));
      ordinals.add(row.ordinalPosition);
    }
    if ([...ordinals].sort((left, right) => left - right).some((ordinal, position) => ordinal !== position + 1))
      throw new AlterTableDropColumnVerificationError();
    if (rows.some((row) => row.generationExpression !== null && row.generationExpression.length > 0))
      throw new AlterTableDropColumnVerificationError();
    if (rows.some((row) => normalizedIdentifierName(row.columnName) === normalizedIdentifierName(input.column)))
      throw new AlterTableDropColumnVerificationError();
  } catch (error) {
    if (error instanceof AlterTableDropColumnVerificationError) throw error;
    throw new AlterTableDropColumnVerificationError();
  }
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

/** @internal Confirms that the named constraint is a foreign key on the requested base table. */
export async function validateAlterTableDropForeignKeyMetadata(mysql: ConnectionLayer, input: AlterTableDropForeignKeyInput): Promise<void> {
  interface DropForeignKeyTableRow extends RowDataPacket {
    schemaName: string;
    tableName: string;
    tableType: string;
  }
  interface DropForeignKeyConstraintRow extends RowDataPacket {
    schemaName: string;
    tableSchemaName: string;
    tableName: string;
    constraintName: string;
    constraintType: string;
  }
  let tables: DropForeignKeyTableRow[];
  let constraints: DropForeignKeyConstraintRow[];
  try {
    [tables] = await mysql.query<TableRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_FOREIGN_KEY_TABLE_SQL), [input.schema, input.table]);
    [constraints] = await mysql.query<DropForeignKeyConstraintRow[]>(queryOptions(mysql, VALIDATE_ALTER_TABLE_DROP_FOREIGN_KEY_CONSTRAINT_SQL), [
      input.schema,
      input.schema,
      input.table,
      input.constraint,
    ]);
  } catch {
    throw new AlterTableDropForeignKeyMetadataError('MYSQL_DDL_METADATA_INVALID', ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_UNAVAILABLE);
  }
  if (!Array.isArray(tables) || tables.length !== 1)
    throw new AlterTableDropForeignKeyMetadataError('MYSQL_DDL_METADATA_INVALID', ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_UNAVAILABLE);
  const table = tables[0];
  if (!table || table.schemaName !== input.schema || table.tableName !== input.table)
    throw new AlterTableDropForeignKeyMetadataError('MYSQL_DDL_METADATA_INVALID', ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_UNAVAILABLE);
  if (table.tableType !== 'BASE TABLE')
    throw new AlterTableDropForeignKeyMetadataError('MYSQL_DDL_TABLE_INVALID', ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_TABLE_INVALID);
  if (!Array.isArray(constraints) || constraints.length !== 1)
    throw new AlterTableDropForeignKeyMetadataError('MYSQL_DDL_STRUCTURE_INVALID', ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_STRUCTURE_INVALID);
  const constraint = constraints[0];
  if (
    !constraint ||
    constraint.schemaName !== input.schema ||
    constraint.tableSchemaName !== input.schema ||
    constraint.tableName !== input.table ||
    constraint.constraintName !== input.constraint ||
    constraint.constraintType !== 'FOREIGN KEY'
  )
    throw new AlterTableDropForeignKeyMetadataError('MYSQL_DDL_STRUCTURE_INVALID', ALTER_TABLE_DROP_FOREIGN_KEY_METADATA_STRUCTURE_INVALID);
}
