import type { AdminLookup, AdminPerson, AdminShareLink } from '@pinwall/shared';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import type { Config } from '../config/types.ts';
import { isContentToken, revokeVersionGrants } from '../content/grants.ts';
import type {
  ArtifactRow,
  ContentGrantRow,
  ShareLinkRow,
  TombstoneKind,
  VersionRow,
} from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, gone, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret } from '../lib/ids.ts';
import { holdArtifact } from './artifacts.ts';
import { holdProject, type SystemScope } from './spaces.ts';
import { isTombstoned } from './tombstones.ts';

/** Where the next page of links starts: after the one made at `c` with id `i`. */
const LinkCursor = z.object({ c: z.number().int(), i: z.string() });

/** What `newSecret` makes, as `/s/<token>` carries it: 43 base64url characters. */
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{43})(?:\/original)?\/?$/;
/** `/a/<id>`, then `/v/<n>`, then `/raw`, `/compare` or a closing `/`, each optional. */
const ARTIFACT_PATH = /^\/a\/([A-Za-z0-9_-]{1,100})(?:\/v\/(\d{1,9}))?(?:\/(?:raw|compare))?\/?$/;
/** `/c/<token>` and whatever follows it. */
const CONTENT_PATH = /^\/c\/([^/]+)(?:\/|$)/;

/** A share link, an artifact or a content grant an address from a report points to. */
export type ReportedUrl =
  | { kind: 'share'; token: string }
  | { kind: 'artifact'; id: string; n: number | null }
  | { kind: 'grant'; token: string };

/** `url` as an `http:` or `https:` address, or null when it is neither. */
function parseHttpUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
}

/** The grant token in a host `<token>.<content host>` of the content origin, else null. */
function contentHostToken(config: Config, url: URL): string | null {
  const { isolation } = config;
  if (isolation.mode !== 'content-domain') return null;
  const { scheme, host, port } = isolation.contentOrigin;
  const origin = new URL(`${scheme}://${host}${port === undefined ? '' : `:${port}`}`);
  if (url.protocol !== origin.protocol || url.port !== origin.port) return null;
  const suffix = `.${origin.hostname}`;
  if (!url.hostname.endsWith(suffix)) return null;
  const label = url.hostname.slice(0, -suffix.length);
  return isContentToken(label) ? label : null;
}

/**
 * What an address from a report points to, if it is one this Pinwall hands out; null otherwise.
 * On the public origin (scheme, host and port): `/s/<token>`, optionally with `/original`;
 * `/a/<id>`, optionally with `/v/<n>` and `/raw` or `/compare`; and, where content is served
 * under the app's origin, `/c/<token>/…`. Where content has a host of its own: that host,
 * `<token>.<content host>`, on the content origin's scheme and port. A query or fragment is
 * ignored. Another site's address, and any other path, are null.
 */
export function parseReportedUrl(config: Config, url: string): ReportedUrl | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null) return null;
  if (parsed.origin === new URL(config.publicOrigin).origin) {
    const path = parsed.pathname;
    const share = SHARE_PATH.exec(path)?.[1];
    if (share !== undefined) return { kind: 'share', token: share };
    const artifact = ARTIFACT_PATH.exec(path);
    if (artifact?.[1] !== undefined) {
      return {
        kind: 'artifact',
        id: artifact[1],
        n: artifact[2] === undefined ? null : Number(artifact[2]),
      };
    }
    if (config.isolation.mode === 'single-domain') {
      const token = CONTENT_PATH.exec(path)?.[1];
      if (token !== undefined && isContentToken(token)) return { kind: 'grant', token };
    }
    return null;
  }
  const token = contentHostToken(config, parsed);
  return token === null ? null : { kind: 'grant', token };
}

/** A share link with what an admin needs to know about it, before the people are looked up. */
interface LinkFacts {
  link: ShareLinkRow;
  artifact: { id: string; name: string };
  ownerId: string | null;
}

/**
 * Whose space holds an artifact: its project's owner in `personal` mode, the person who
 * published it in `team` mode, where projects are shared and the publisher is who answers for it.
 */
function ownerIdOf(
  config: Config,
  artifact: { created_by: string | null },
  project: { owner_id: string | null },
): string | null {
  return config.visibility === 'personal' ? project.owner_id : artifact.created_by;
}

/**
 * Every person in `ids` that still exists, by id, as an admin sees them: the name, else the
 * email, else empty. One query.
 */
async function peopleById(
  db: Db,
  ids: readonly (string | null)[],
): Promise<Map<string, AdminPerson>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .selectFrom('users')
    .select(['id', 'name', 'email'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, name: row.name ?? row.email ?? '', email: row.email },
    ]),
  );
}

/** The person `id`, if they still exist. */
function personIn(people: ReadonlyMap<string, AdminPerson>, id: string | null) {
  return id === null ? null : (people.get(id) ?? null);
}

/** The number of each version in `ids` that still exists, by id. One query. */
async function versionNumbers(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('versions')
    .select(['id', 'number'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((row) => [row.id, row.number]));
}

/**
 * Share links as an admin sees them, in the order given: metadata only, one query for the
 * versions they pin and one for the people, whatever their number. A link whose version is gone
 * went with it (a read that raced the deletion) and is left out.
 */
async function toAdminShareLinks(db: Db, facts: readonly LinkFacts[]): Promise<AdminShareLink[]> {
  const numbers = await versionNumbers(
    db,
    facts.flatMap(({ link }) => (link.version_id === null ? [] : [link.version_id])),
  );
  const people = await peopleById(
    db,
    facts.flatMap(({ link, ownerId }) => [ownerId, link.created_by]),
  );
  const links: AdminShareLink[] = [];
  for (const { link, artifact, ownerId } of facts) {
    let version: AdminShareLink['version'] = null;
    if (link.version_id !== null) {
      const number = numbers.get(link.version_id);
      if (number === undefined) continue;
      version = { id: link.version_id, number };
    }
    links.push({
      id: link.id,
      artifact,
      owner: personIn(people, ownerId),
      created_by: personIn(people, link.created_by),
      version,
      has_password: link.password_hash !== null,
      allow_comments: link.allow_comments === 1,
      created_at: link.created_at,
      expires_at: link.expires_at,
      last_used_at: link.last_used_at,
    });
  }
  return links;
}

/**
 * One page of the share links that still open, across the whole instance: not revoked, and
 * without an expiry or expiring after now. Newest first, ties by id, so a page boundary never
 * repeats or skips one. Metadata only: tokens are stored as hashes and no address is rebuilt.
 */
export async function listActiveShareLinks(
  deps: AppDeps,
  _scope: SystemScope,
  p: { limit: number; cursor: string | null },
): Promise<{ items: AdminShareLink[]; nextCursor: string | null }> {
  const { db } = deps.db;
  let query = db
    .selectFrom('share_links')
    .innerJoin('artifacts', 'artifacts.id', 'share_links.artifact_id')
    .innerJoin('projects', 'projects.id', 'artifacts.project_id')
    .selectAll('share_links')
    .select([
      'artifacts.name as artifact_name',
      'artifacts.created_by as artifact_created_by',
      'projects.owner_id as project_owner_id',
    ])
    .where('share_links.revoked_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('share_links.expires_at', 'is', null),
        eb('share_links.expires_at', '>', deps.clock.now()),
      ]),
    );
  if (p.cursor !== null) {
    const after = decodeCursor(p.cursor, LinkCursor);
    query = query.where((eb) =>
      eb.or([
        eb('share_links.created_at', '<', after.c),
        eb.and([eb('share_links.created_at', '=', after.c), eb('share_links.id', '<', after.i)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('share_links.created_at', 'desc')
    .orderBy('share_links.id', 'desc')
    .limit(p.limit + 1)
    .execute();
  const page = rows.slice(0, p.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > p.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null;
  const items = await toAdminShareLinks(
    db,
    page.map(({ artifact_name, artifact_created_by, project_owner_id, ...link }) => ({
      link,
      artifact: { id: link.artifact_id, name: artifact_name },
      ownerId: ownerIdOf(
        deps.config,
        { created_by: artifact_created_by },
        { owner_id: project_owner_id },
      ),
    })),
  );
  return { items, nextCursor };
}

/** What a reported address resolved to, before its people are named. */
interface Found {
  kind: AdminLookup['kind'];
  artifact: ArtifactRow;
  version: VersionRow;
  link: ShareLinkRow | null;
  grant: ContentGrantRow | null;
}

/** Throws what an address of `kind` and `key` that matches no row answers: 410 if it was taken down. */
async function noRow(db: Db, kind: TombstoneKind, key: string, now: number): Promise<never> {
  if (await isTombstoned(db, kind, key, now)) throw gone(t('moderation.lookup.gone'));
  throw notFound(t('moderation.lookup.unknown'));
}

/** The artifact `id`; 410 when it is gone, which a read that raced its deletion finds. */
async function artifactById(db: Db, id: string): Promise<ArtifactRow> {
  const artifact = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (artifact === undefined) throw gone(t('moderation.lookup.gone'));
  return artifact;
}

/** The version `id`; 410 when it is gone, as for `artifactById`. */
async function versionById(db: Db, id: string | null): Promise<VersionRow> {
  const version =
    id === null
      ? undefined
      : await db.selectFrom('versions').selectAll().where('id', '=', id).executeTakeFirst();
  if (version === undefined) throw gone(t('moderation.lookup.gone'));
  return version;
}

async function findShare(db: Db, token: string, now: number): Promise<Found> {
  const hash = hashSecret(token);
  const link = await db
    .selectFrom('share_links')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirst();
  if (link === undefined) return noRow(db, 'share_link', hash, now);
  const artifact = await artifactById(db, link.artifact_id);
  const version = await versionById(db, link.version_id ?? artifact.current_version_id);
  return { kind: 'share_link', artifact, version, link, grant: null };
}

async function findArtifact(db: Db, id: string, n: number | null, now: number): Promise<Found> {
  const artifact = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (artifact === undefined) return noRow(db, 'artifact', id, now);
  if (n === null) {
    const version = await versionById(db, artifact.current_version_id);
    return { kind: 'artifact', artifact, version, link: null, grant: null };
  }
  const version = await db
    .selectFrom('versions')
    .selectAll()
    .where('artifact_id', '=', id)
    .where('number', '=', n)
    .executeTakeFirst();
  if (version === undefined) {
    // A number that was given out and is gone was taken down; one never given out is no version.
    throw n >= 1 && n <= artifact.latest_number
      ? gone(t('moderation.lookup.gone'))
      : notFound(t('moderation.lookup.unknown'));
  }
  return { kind: 'artifact', artifact, version, link: null, grant: null };
}

async function findGrant(db: Db, token: string, now: number): Promise<Found> {
  const grant = await db
    .selectFrom('content_grants')
    .selectAll()
    .where('token', '=', token)
    .executeTakeFirst();
  if (grant === undefined) return noRow(db, 'content_grant', token, now);
  const version = await versionById(db, grant.version_id);
  const artifact = await artifactById(db, version.artifact_id);
  const link =
    grant.share_link_id === null
      ? undefined
      : await db
          .selectFrom('share_links')
          .selectAll()
          .where('id', '=', grant.share_link_id)
          .executeTakeFirst();
  return { kind: 'content_grant', artifact, version, link: link ?? null, grant };
}

/**
 * What an address from an abuse report belongs to: the artifact with its project and owner, the
 * version, and the share link or grant it names, if any. Metadata only; nothing of the content,
 * and never a token. A link that was revoked or has expired is still named, so the artifact it
 * showed can be dealt with. 400 when `url` is no http(s) address, 404 when it names nothing here
 * (another site, an unknown token or id, a path Pinwall does not hand out), 410 when what it
 * names was taken down.
 */
export async function lookupReportedUrl(
  deps: AppDeps,
  _scope: SystemScope,
  url: string,
): Promise<AdminLookup> {
  if (parseHttpUrl(url) === null) {
    throw badRequest(t('moderation.lookup.badUrl'), { field: 'url' });
  }
  const reported = parseReportedUrl(deps.config, url);
  if (reported === null) throw notFound(t('moderation.lookup.unknown'));
  const { db } = deps.db;
  const now = deps.clock.now();
  const found =
    reported.kind === 'share'
      ? await findShare(db, reported.token, now)
      : reported.kind === 'artifact'
        ? await findArtifact(db, reported.id, reported.n, now)
        : await findGrant(db, reported.token, now);

  const { artifact, version, link, grant } = found;
  const project = await db
    .selectFrom('projects')
    .select(['id', 'name', 'owner_id'])
    .where('id', '=', artifact.project_id)
    .executeTakeFirst();
  // The artifact and then its project were deleted since the address was resolved.
  if (project === undefined) throw gone(t('moderation.lookup.gone'));
  const ownerId = ownerIdOf(deps.config, artifact, project);
  let shareLink: AdminShareLink | null = null;
  if (link !== null) {
    const [named] = await toAdminShareLinks(db, [
      { link, artifact: { id: artifact.id, name: artifact.name }, ownerId },
    ]);
    // Its version was deleted, taking the link along, since the address was resolved.
    if (named === undefined) throw gone(t('moderation.lookup.gone'));
    shareLink = named;
  }
  const people = await peopleById(db, [ownerId, version.created_by, grant?.user_id ?? null]);
  return {
    kind: found.kind,
    artifact: {
      id: artifact.id,
      name: artifact.name,
      project: { id: project.id, name: project.name },
      owner: personIn(people, ownerId),
    },
    version: {
      id: version.id,
      number: version.number,
      published_by: personIn(people, version.created_by),
    },
    share_link: shareLink,
    grant:
      grant === null
        ? null
        : {
            mode: grant.mode,
            expires_at: grant.expires_at,
            holder: personIn(people, grant.user_id),
          },
  };
}

/**
 * Deletes and tombstones every content grant of version `versionId`, those made for people and
 * those a share link's guests hold, so each answers 410 from then on. The version, its links
 * and the artifact stay. The artifact is held first, then its project, as every write takes them.
 * An unknown version answers 404. Returns how many grants it ended.
 */
export async function endVersionGrants(
  deps: AppDeps,
  scope: SystemScope,
  versionId: string,
): Promise<number> {
  const { db, dialect } = deps.db;
  return db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifactOf = () =>
      trx
        .selectFrom('versions')
        .select('artifact_id')
        .where('id', '=', versionId)
        .executeTakeFirst();
    const seen = await artifactOf();
    if (seen === undefined) throw notFound(t('version.notFound'));
    const artifact = await holdArtifact(trx, dialect, scope, seen.artifact_id, now);
    await holdProject(trx, dialect, deps.config.visibility, artifact.project_id);
    // A deletion the hold waited for may have taken the version along.
    if (dialect === 'postgres' && (await artifactOf()) === undefined) {
      throw notFound(t('version.notFound'));
    }
    return revokeVersionGrants(trx, versionId, now);
  });
}
