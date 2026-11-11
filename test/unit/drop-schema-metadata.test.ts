import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DropSchemaMetadataError,
  DropSchemaVerificationError,
  consumeDropSchemaMetadataAttestation,
  inspectDropSchemaMetadata,
  validateDropSchemaMetadata,
  verifyDropSchemaMetadata,
} from '../../src/db/metadata.js';
import type { ConnectionLayer } from '../../src/db/pool.js';

type MetadataState = {
  present: boolean;
  tables: Array<Record<string, unknown>>;
  routines: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  triggers: Array<Record<string, unknown>>;
};

function metadataLayer(schema: string, state: MetadataState): ConnectionLayer {
  return {
    queryTimeoutMs: 30_000,
    queryOptions: () => ({ timeout: 30_000 }),
    async query(options) {
      if (options.sql.includes('SCHEMATA')) return [state.present ? [{ schemaName: schema }] : [], []] as never;
      if (options.sql.includes('ROUTINES')) return [state.routines, []] as never;
      if (options.sql.includes('EVENTS')) return [state.events, []] as never;
      if (options.sql.includes('TRIGGERS')) return [state.triggers, []] as never;
      return [state.tables, []] as never;
    },
    async verifyConnection() {},
    async close() {},
  };
}

function stateFor(): MetadataState {
  return {
    present: true,
    tables: [{ objectName: 'orders', objectType: 'BASE TABLE', engine: 'InnoDB', creationIdentity: 'table-orders-v1', durableIdentity: '101' }],
    routines: [],
    events: [],
    triggers: [],
  };
}

test('classifies bounded schema impact and reuses or replaces attestations safely', async () => {
  const schema = `drop_schema_metadata_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  const first = await inspectDropSchemaMetadata(mysql, schema);
  const repeated = await inspectDropSchemaMetadata(mysql, schema);

  assert.deepEqual(first.impact, {
    tables: { count: 1, names: ['orders'] },
    views: { count: 0, names: [] },
    otherObjects: { count: 0, names: [] },
  });
  assert.equal(repeated.metadataRevision, first.metadataRevision);

  state.tables = [
    ...state.tables,
    { objectName: 'new_table', objectType: 'BASE TABLE', engine: 'InnoDB', creationIdentity: 'table-new-v1', durableIdentity: '102' },
  ];
  const changed = await inspectDropSchemaMetadata(mysql, schema);
  assert.notEqual(changed.metadataRevision, first.metadataRevision);
  await assert.rejects(
    validateDropSchemaMetadata(mysql, { schema, reason: 'Remove the schema.', confirmation: first.confirmation }),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
  await validateDropSchemaMetadata(mysql, { schema, reason: 'Remove the schema.', confirmation: changed.confirmation });
  consumeDropSchemaMetadataAttestation(mysql, schema, changed.metadataRevision);
  await assert.rejects(
    validateDropSchemaMetadata(mysql, { schema, reason: 'Remove the schema.', confirmation: changed.confirmation }),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
});

test('rejects unsupported schema metadata before issuing confirmation', async () => {
  const schema = `drop_schema_invalid_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.tables = [{ objectName: 'unsupported', objectType: 'UNKNOWN', creationIdentity: 'unsupported-v1' }];
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('rejects views before issuing confirmation', async () => {
  const schema = `drop_schema_view_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.tables.push({ objectName: 'report', objectType: 'VIEW', creationIdentity: 'view-report-v1' });
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('rejects system views before issuing confirmation', async () => {
  const schema = `drop_schema_system_view_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.tables.push({ objectName: 'system_report', objectType: 'SYSTEM VIEW', creationIdentity: 'system-view-report-v1' });
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('rejects routines before issuing confirmation', async () => {
  const schema = `drop_schema_routine_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.routines.push({ objectName: 'refresh_orders', creationIdentity: 'routine-refresh-orders-v1' });
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('rejects events before issuing confirmation', async () => {
  const schema = `drop_schema_event_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.events.push({ objectName: 'nightly_refresh', creationIdentity: 'event-nightly-refresh-v1' });
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('rejects triggers before issuing confirmation', async () => {
  const schema = `drop_schema_trigger_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.triggers.push({ objectName: 'orders_audit', creationIdentity: 'trigger-orders-audit-v1' });
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('rejects missing object creation identity before issuing confirmation', async () => {
  const schema = `drop_schema_identity_missing_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  delete state.tables[0].creationIdentity;
  await assert.rejects(
    inspectDropSchemaMetadata(mysql, schema),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
});

test('rejects schema metadata beyond the bounded impact ceiling', async () => {
  const schema = `drop_schema_overflow_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.tables = Array.from({ length: 101 }, (_, index) => ({
    objectName: `table_${index}`,
    objectType: 'BASE TABLE',
    engine: 'InnoDB',
    creationIdentity: `table-${index}-v1`,
    durableIdentity: String(index + 1),
  }));
  await assert.rejects(inspectDropSchemaMetadata(mysql, schema), (error: unknown) => error instanceof DropSchemaMetadataError);
});

test('verifies schema absence after DROP SCHEMA without exposing metadata contents', async () => {
  const schema = `drop_schema_verify_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  await assert.rejects(verifyDropSchemaMetadata(mysql, schema), DropSchemaVerificationError);
  state.present = false;
  await assert.doesNotReject(verifyDropSchemaMetadata(mysql, schema));
});

test('rejects empty schemas because information_schema has no schema creation identity', async () => {
  const schema = `drop_schema_recreated_${Date.now()}`;
  const state: MetadataState = { present: true, tables: [], routines: [], events: [], triggers: [] };
  const mysql = metadataLayer(schema, state);
  await assert.rejects(
    inspectDropSchemaMetadata(mysql, schema),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
});

test('rejects non-InnoDB base tables as durable anchors', async () => {
  const schema = `drop_schema_non_innodb_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  state.tables = [{ objectName: 'legacy', objectType: 'BASE TABLE', engine: 'MyISAM', creationIdentity: 'legacy-v1', durableIdentity: '103' }];

  await assert.rejects(
    inspectDropSchemaMetadata(mysql, schema),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
});

test('rejects stale confirmation when durable table identity changes without changing names or types', async () => {
  const schema = `drop_schema_identity_${Date.now()}`;
  const state = stateFor();
  const mysql = metadataLayer(schema, state);
  const first = await inspectDropSchemaMetadata(mysql, schema);
  state.tables[0].durableIdentity = '102';

  await assert.rejects(
    validateDropSchemaMetadata(mysql, { schema, reason: 'Remove the schema.', confirmation: first.confirmation }),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
});

test('scopes schema attestations to the connection layer instance', async () => {
  const schema = `drop_schema_scoped_${Date.now()}`;
  const state = stateFor();
  const layerA = metadataLayer(schema, state);
  const layerB = metadataLayer(schema, state);
  const first = await inspectDropSchemaMetadata(layerA, schema);

  await assert.rejects(
    validateDropSchemaMetadata(layerB, { schema, reason: 'Remove the schema.', confirmation: first.confirmation }),
    (error: unknown) => error instanceof DropSchemaMetadataError && error.code === 'MYSQL_DDL_METADATA_INVALID',
  );
  await assert.doesNotReject(validateDropSchemaMetadata(layerA, { schema, reason: 'Remove the schema.', confirmation: first.confirmation }));
});
