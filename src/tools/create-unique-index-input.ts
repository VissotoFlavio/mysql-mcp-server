/** The unique-index boundary intentionally has the same small input contract as create_index. */
export {
  CREATE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN as CREATE_UNIQUE_INDEX_NO_CONTROL_CHARACTERS_JSON_SCHEMA_PATTERN,
  CreateIndexInputValidationError as CreateUniqueIndexInputValidationError,
  MAX_CREATE_INDEX_COLUMNS as MAX_CREATE_UNIQUE_INDEX_COLUMNS,
  MAX_CREATE_INDEX_IDENTIFIER_LENGTH as MAX_CREATE_UNIQUE_INDEX_IDENTIFIER_LENGTH,
  MAX_CREATE_INDEX_NESTING_DEPTH as MAX_CREATE_UNIQUE_INDEX_NESTING_DEPTH,
  MAX_CREATE_INDEX_PAYLOAD_BYTES as MAX_CREATE_UNIQUE_INDEX_PAYLOAD_BYTES,
  MAX_CREATE_INDEX_REASON_LENGTH as MAX_CREATE_UNIQUE_INDEX_REASON_LENGTH,
  createIndexInputJsonSchema as createUniqueIndexInputJsonSchema,
  normalizeCreateIndexInput as normalizeCreateUniqueIndexInput,
} from './create-index-input.js';

export type {
  CreateIndexInput as CreateUniqueIndexInput,
  CreateIndexValidationCode as CreateUniqueIndexValidationCode,
} from './create-index-input.js';
