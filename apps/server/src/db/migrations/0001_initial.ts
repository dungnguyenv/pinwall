import { type ColumnDefinitionBuilder, sql } from 'kysely';
import type { DbDialect } from '../connect.ts';
import { bigintCol } from '../dialect.ts';
import type { MigrationDb } from './index.ts';

type Column = (c: ColumnDefinitionBuilder) => ColumnDefinitionBuilder;

// Column modifiers. Primary key columns are marked NOT NULL explicitly: SQLite would otherwise
// accept NULL in a non-integer primary key.
const pk: Column = (c) => c.primaryKey().notNull();
const required: Column = (c) => c.notNull();
const ref =
  (target: string, onDelete: 'cascade' | 'set null', notNull = onDelete === 'cascade'): Column =>
  (c) => {
    const column = c.references(target).onDelete(onDelete);
    return notNull ? column.notNull() : column;
  };

/** Creates every table of the v1 data model (roadmap, "Data model"). */
export async function up(db: MigrationDb, dialect: DbDialect): Promise<void> {
  const big = bigintCol({ dialect });
  // STRICT makes SQLite reject values of the wrong type, as Postgres does.
  const createTable = (name: string) =>
    dialect === 'sqlite'
      ? db.schema.createTable(name).modifyEnd(sql`strict`)
      : db.schema.createTable(name);
  const index = (table: string, columns: string[], unique = false) => {
    const builder = db.schema
      .createIndex(`${table}_${columns.join('_')}_${unique ? 'key' : 'idx'}`)
      .on(table)
      .columns(columns);
    return (unique ? builder.unique() : builder).execute();
  };

  await createTable('users')
    .addColumn('id', 'text', pk)
    .addColumn('kind', 'text', required)
    .addColumn('email', 'text')
    .addColumn('email_verified', 'integer', required)
    .addColumn('name', 'text')
    .addColumn('avatar_url', 'text')
    .addColumn('idp_role', 'text')
    .addColumn('role_override', 'text')
    .addColumn('oidc_issuer', 'text')
    .addColumn('oidc_subject', 'text')
    .addColumn('idp_refresh_token', 'text')
    .addColumn('idp_checked_at', big)
    .addColumn('disabled_at', big)
    .addColumn('disabled_reason', 'text')
    .addColumn('created_at', big, required)
    .addColumn('last_seen_at', big)
    .execute();
  await index('users', ['oidc_issuer', 'oidc_subject'], true);

  await createTable('password_credentials')
    .addColumn('user_id', 'text', (c) => pk(ref('users.id', 'cascade')(c)))
    .addColumn('hash', 'text', required)
    .addColumn('updated_at', big, required)
    .execute();

  await createTable('passkeys')
    .addColumn('id', 'text', pk)
    .addColumn('user_id', 'text', ref('users.id', 'cascade'))
    .addColumn('credential_id', 'text', required)
    .addColumn('public_key', 'text', required)
    .addColumn('counter', big, required)
    .addColumn('transports', 'text', required)
    .addColumn('name', 'text', required)
    .addColumn('created_at', big, required)
    .addColumn('last_used_at', big)
    .execute();
  await index('passkeys', ['user_id']);
  await index('passkeys', ['credential_id'], true);

  await createTable('sessions')
    .addColumn('id_hash', 'text', pk)
    .addColumn('user_id', 'text', ref('users.id', 'cascade'))
    .addColumn('auth_method', 'text', required)
    .addColumn('created_at', big, required)
    .addColumn('expires_at', big, required)
    .addColumn('last_seen_at', big, required)
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .execute();
  await index('sessions', ['user_id']);
  await index('sessions', ['expires_at']);

  await createTable('api_tokens')
    .addColumn('id', 'text', pk)
    .addColumn('user_id', 'text', ref('users.id', 'cascade'))
    .addColumn('name', 'text', required)
    .addColumn('token_hash', 'text', required)
    .addColumn('prefix', 'text', required)
    .addColumn('created_at', big, required)
    .addColumn('last_used_at', big)
    .addColumn('expires_at', big)
    .addColumn('revoked_at', big)
    .execute();
  await index('api_tokens', ['user_id']);
  await index('api_tokens', ['token_hash'], true);

  await createTable('oauth_clients')
    .addColumn('id', 'text', pk)
    .addColumn('name', 'text', required)
    .addColumn('redirect_uris', 'text', required)
    .addColumn('created_at', big, required)
    .addColumn('last_used_at', big)
    .execute();

  await createTable('oauth_grants')
    .addColumn('id', 'text', pk)
    .addColumn('client_id', 'text', ref('oauth_clients.id', 'cascade'))
    .addColumn('user_id', 'text', ref('users.id', 'cascade'))
    .addColumn('resource', 'text', required)
    .addColumn('scope', 'text', required)
    .addColumn('created_at', big, required)
    .addColumn('last_used_at', big)
    .addColumn('revoked_at', big)
    .execute();
  await index('oauth_grants', ['client_id']);
  await index('oauth_grants', ['user_id']);

  await createTable('oauth_tokens')
    .addColumn('token_hash', 'text', pk)
    .addColumn('grant_id', 'text', ref('oauth_grants.id', 'cascade'))
    .addColumn('kind', 'text', required)
    .addColumn('created_at', big, required)
    .addColumn('expires_at', big, required)
    .addColumn('used_at', big)
    .execute();
  await index('oauth_tokens', ['grant_id']);

  await createTable('projects')
    .addColumn('id', 'text', pk)
    .addColumn('name', 'text', required)
    .addColumn('instructions', 'text', required)
    .addColumn('is_default', 'integer', required)
    .addColumn('archived_at', big)
    .addColumn('created_by', 'text', ref('users.id', 'set null'))
    .addColumn('created_at', big, required)
    .addColumn('updated_at', big, required)
    .execute();
  await index('projects', ['created_by']);

  await createTable('artifacts')
    .addColumn('id', 'text', pk)
    .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id'))
    .addColumn('name', 'text', required)
    .addColumn('kind', 'text', required)
    .addColumn('current_version_id', 'text')
    .addColumn('latest_number', big, required)
    .addColumn('created_by', 'text', ref('users.id', 'set null'))
    .addColumn('created_at', big, required)
    .addColumn('updated_at', big, required)
    .execute();
  await index('artifacts', ['project_id', 'updated_at']);
  await index('artifacts', ['created_by']);

  await createTable('artifact_tags')
    .addColumn('artifact_id', 'text', ref('artifacts.id', 'cascade'))
    .addColumn('tag', 'text', required)
    .addPrimaryKeyConstraint('artifact_tags_pkey', ['artifact_id', 'tag'])
    .execute();

  await createTable('artifact_views')
    .addColumn('user_id', 'text', ref('users.id', 'cascade'))
    .addColumn('artifact_id', 'text', ref('artifacts.id', 'cascade'))
    .addColumn('viewed_at', big, required)
    .addPrimaryKeyConstraint('artifact_views_pkey', ['user_id', 'artifact_id'])
    .execute();
  await index('artifact_views', ['artifact_id']);

  await createTable('versions')
    .addColumn('id', 'text', pk)
    .addColumn('artifact_id', 'text', ref('artifacts.id', 'cascade'))
    .addColumn('number', big, required)
    .addColumn('parent_version_id', 'text')
    .addColumn('entry_path', 'text', required)
    .addColumn('title', 'text')
    .addColumn('theme_color', 'text')
    .addColumn('thumbnail_path', 'text')
    .addColumn('file_count', big, required)
    .addColumn('total_bytes', big, required)
    .addColumn('message', 'text')
    .addColumn('source', 'text', required)
    .addColumn('restored_from_version_id', 'text')
    .addColumn('meta', 'text', required)
    .addColumn('created_by', 'text', ref('users.id', 'set null'))
    .addColumn('created_at', big, required)
    .execute();
  await index('versions', ['artifact_id', 'number'], true);
  await index('versions', ['created_by']);

  await createTable('version_files')
    .addColumn('version_id', 'text', ref('versions.id', 'cascade'))
    .addColumn('path', 'text', required)
    .addColumn('sha256', 'text', required)
    .addColumn('size', big, required)
    .addColumn('content_type', 'text', required)
    .addPrimaryKeyConstraint('version_files_pkey', ['version_id', 'path'])
    .execute();

  await createTable('blobs')
    .addColumn('sha256', 'text', pk)
    .addColumn('size', big, required)
    .addColumn('created_at', big, required)
    .execute();

  await createTable('share_links')
    .addColumn('id', 'text', pk)
    .addColumn('artifact_id', 'text', ref('artifacts.id', 'cascade'))
    .addColumn('version_id', 'text', ref('versions.id', 'cascade', false))
    .addColumn('token_hash', 'text', required)
    .addColumn('password_hash', 'text')
    .addColumn('allow_comments', 'integer', required)
    .addColumn('expires_at', big)
    .addColumn('created_by', 'text', ref('users.id', 'set null'))
    .addColumn('created_at', big, required)
    .addColumn('last_used_at', big)
    .addColumn('revoked_at', big)
    .execute();
  await index('share_links', ['artifact_id']);
  await index('share_links', ['version_id']);
  await index('share_links', ['created_by']);
  await index('share_links', ['token_hash'], true);

  await createTable('content_grants')
    .addColumn('token', 'text', pk)
    .addColumn('version_id', 'text', ref('versions.id', 'cascade'))
    .addColumn('mode', 'text', required)
    .addColumn('share_link_id', 'text', ref('share_links.id', 'cascade', false))
    .addColumn('created_at', big, required)
    .addColumn('expires_at', big, required)
    .execute();
  await index('content_grants', ['version_id']);
  await index('content_grants', ['share_link_id']);
  await index('content_grants', ['expires_at']);

  await createTable('comments')
    .addColumn('id', 'text', pk)
    .addColumn('artifact_id', 'text', ref('artifacts.id', 'cascade'))
    .addColumn('version_id', 'text', ref('versions.id', 'cascade'))
    .addColumn('parent_id', 'text', ref('comments.id', 'cascade', false))
    .addColumn('author_user_id', 'text', ref('users.id', 'set null'))
    .addColumn('guest_name', 'text')
    .addColumn('share_link_id', 'text', ref('share_links.id', 'set null'))
    .addColumn('body', 'text', required)
    .addColumn('anchor', 'text')
    .addColumn('status', 'text')
    .addColumn('resolved_in_version_id', 'text', ref('versions.id', 'set null'))
    .addColumn('resolved_by', 'text', ref('users.id', 'set null'))
    .addColumn('resolved_at', big)
    .addColumn('created_at', big, required)
    .addColumn('updated_at', big, required)
    .addColumn('edited_at', big)
    .execute();
  await index('comments', ['artifact_id', 'status']);
  await index('comments', ['version_id']);
  await index('comments', ['parent_id']);
  await index('comments', ['author_user_id']);
  await index('comments', ['share_link_id']);
  await index('comments', ['resolved_in_version_id']);
  await index('comments', ['resolved_by']);

  await createTable('leases')
    .addColumn('name', 'text', pk)
    .addColumn('holder', 'text', required)
    .addColumn('expires_at', big, required)
    .execute();

  if (dialect === 'sqlite') {
    // FTS5 cannot carry a foreign key; `searchDelete` cleans up when an artifact goes.
    await sql`
      create virtual table search_index using fts5(
        artifact_id unindexed, name, tags, body,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `.execute(db);
  } else {
    await sql`create extension if not exists unaccent`.execute(db);
    await createTable('search_index')
      .addColumn('artifact_id', 'text', (c) => pk(ref('artifacts.id', 'cascade')(c)))
      .addColumn('name', 'text', required)
      .addColumn('tags', 'text', required)
      .addColumn('body', 'text', required)
      .addColumn('document', sql`tsvector`, required)
      .execute();
    await sql`create index search_index_document_idx on search_index using gin (document)`.execute(
      db,
    );
  }
}
