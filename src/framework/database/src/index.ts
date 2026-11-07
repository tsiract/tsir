/**
 * @tsir/database — D1-first database layer.
 *
 * Public surface:
 *   createDatabase, Database, declare, assertRequirements, DatabaseOptions,
 *   createDrizzle, rootCause, errorCode,
 *   scrubSql, paramType, shouldLog, QueryLogEvent, QueryLogger, QueryLogLevel,
 *   optimisticUpdate, applyOptimistic, retryOnConflict,
 *   defineCodedColumns, CodedColumns, ColumnCodec, ColumnRef,
 *   createConnections, Connections, ConnectionsOptions, ConnectionDefinition,
 *   assertConnectionRequirements, ConnectionRequirement,
 *   createD1Driver, D1_CAPABILITIES, D1Like, D1StatementLike, D1ResultLike,
 *   statement, DbDriver, DbCapabilities, DbStatement, DbResult, DbHealth,
 *   databaseConfigSchema, DATABASE_ENGINES, DatabaseConfig, postgresOnlyKeys,
 *   DatabaseErrorCode
 *
 * Drizzle sits above this package: the driver is a transport (SQL in, rows out),
 * not a second query builder. D1 is the default engine (ADR-0016); its decisive
 * limitation — no interactive transactions — is a declared capability, not a
 * surprise under load.
 */

export { createDatabase, declare, assertRequirements, isSerializationFailure } from './database.ts';
export type {
  CloseOptions,
  Database,
  DatabaseOptions,
  DatabaseRequirement,
  TransactionOptions,
} from './database.ts';

export { assertConnectionRequirements, createConnections } from './connections.ts';
export type {
  ConnectionDefinition,
  ConnectionRequirement,
  Connections,
  ConnectionsOptions,
  RegistryCloseOptions,
} from './connections.ts';

export { createConnectionsFromConfig } from './from-config.ts';
export type { BindingsSource, RuntimeBindings } from './from-config.ts';

export { createDatabaseBootstrap } from './bootstrap.ts';
export type { DatabaseBootstrap, DatabaseBootstrapOptions } from './bootstrap.ts';

export { createSqliteBinding } from './sqlite-binding.ts';

export { createD1Driver, D1_CAPABILITIES } from './d1.ts';
export type { D1DriverOptions, D1Like, D1ResultLike, D1StatementLike } from './d1.ts';

export { createDrizzle, errorCode, rootCause } from './drizzle.ts';

export { paramType, scrubSql, shouldLog } from './logging.ts';
export type {
  DatabaseLogEvent,
  ParamType,
  QueryLogEvent,
  QueryLogger,
  QueryLogLevel,
  TransactionLogEvent,
} from './logging.ts';

export { defineCodedColumns } from './codec.ts';
export type { CodedColumn, CodedColumns, ColumnCodec, ColumnRef } from './codec.ts';

export { advisoryLockKey, createRotationStore } from './rotation.ts';
export type { RotationStoreOptions } from './rotation.ts';

export { applyOptimistic, optimisticUpdate, retryOnConflict } from './optimistic.ts';
export type { OptimisticResult, OptimisticUpdate, RetryOptions } from './optimistic.ts';

export { statement } from './driver.ts';
export type {
  DbCapabilities,
  DbDriver,
  DbHealth,
  DbResult,
  DbStatement,
  RowFormat,
} from './driver.ts';

export {
  connectionConfigSchema,
  connectionNames,
  DATABASE_ENGINES,
  databaseConfigSchema,
  postgresOnlyKeys,
} from './config.ts';
export type { ConnectionConfig, DatabaseConfig, DatabaseEngine } from './config.ts';

export type { DatabaseErrorCode } from './errors.ts';
