import type { PublishResult, PublishSession } from '@pinwall/shared';
import { hasAccess } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type { UserRow, VersionSource } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { scopeForUser } from '../domain/spaces.ts';
import { checkTarget, type PublishTarget } from '../domain/versions.ts';
import { publicUrl } from '../http/public-url.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newSecret } from '../lib/ids.ts';
import { ingestUpload, type PublishOutcome, publishLinks, type UploadInput } from './ingest.ts';

/** How long an upload URL remembers what became of it, so a retry learns the outcome. */
export const UPLOAD_RECEIPT_TTL_MS = 86_400_000;

/** What an upload URL publishes, and as whom; stored under the hash of its token. */
export interface UploadSession {
  target: PublishTarget;
  actorId: string;
  source: VersionSource;
  message: string | null;
  expiresAt: number;
}

/**
 * What became of an upload URL: unused (`open`), an upload reading its body (`running`), or the
 * version it published (`done`). It outlives the session, so a retry after a lost response or
 * after expiry gets an answer that says which.
 */
export type UploadReceipt =
  | { state: 'open' | 'running'; expiresAt: number }
  | { state: 'done'; expiresAt: number; result: PublishResult };

const sessionKey = (h: string) => `upload:${h}`;
const receiptKey = (h: string) => `upload-receipt:${h}`;
/** Every key of a user's upload URLs is put in this group, so a revocation can drop them all. */
const userGroup = (userId: string) => ({ group: `upload-user:${userId}` });

/**
 * Ends every upload URL `userId` has ("Revoke now"): the sessions not used yet, and the
 * receipts, so an upload running now cannot give its session back when it fails. A URL then
 * answers as unknown. Returns how many entries were removed.
 */
export function revokeUploadSessions(deps: AppDeps, userId: string): Promise<number> {
  return deps.oneTime.deleteGroup(userGroup(userId).group);
}

/**
 * Makes a one-time upload URL for `p.target`, valid for `PINWALL_UPLOAD_SESSION_TTL`. The target
 * is checked now, so a stale `expected_version_id` or a missing artifact or project fails here
 * rather than after the upload. Only the hash of the token is stored.
 */
export async function createPublishSession(
  deps: AppDeps,
  actor: UserRow,
  p: {
    target: PublishTarget;
    message: string | null;
    source: 'api' | 'mcp';
    directory?: string;
    file?: string;
  },
): Promise<PublishSession> {
  await checkTarget(deps, scopeForUser(deps, actor), p.target);
  const token = newSecret();
  const h = hashSecret(token);
  const ttl = deps.config.ttl.uploadSessionMs;
  const expiresAt = deps.clock.now() + ttl;
  const session: UploadSession = {
    target: p.target,
    actorId: actor.id,
    source: p.source,
    message: p.message,
    expiresAt,
  };
  const group = userGroup(actor.id);
  await deps.oneTime.put<UploadReceipt>(
    receiptKey(h),
    { state: 'open', expiresAt },
    UPLOAD_RECEIPT_TTL_MS,
    group,
  );
  await deps.oneTime.put(sessionKey(h), session, ttl, group);

  const url = publicUrl(deps.config, `/upload/${token}`);
  return {
    upload_url: url,
    expires_at: expiresAt,
    commands: uploadCommands(url, { directory: p.directory, file: p.file }),
    max_upload_bytes: deps.config.limits.maxUploadBytes,
  };
}

/** Characters a shell takes literally, so a path made only of them needs no quoting. */
const SHELL_SAFE = /^[A-Za-z0-9_./-]+$/;

/**
 * The commands that publish to `url`: a folder sent as a tar.gz (`directory`, default `./site`),
 * or one file (`file`, default `./index.html`). HTML and Markdown go by their Content-Type and
 * become `index.html` or `index.md`; any other file keeps its name through `?filename=`.
 */
export function uploadCommands(
  url: string,
  hint: { directory?: string; file?: string },
): { archive: string; single_file: string } {
  const directory = hint.directory ?? './site';
  const file = hint.file ?? './index.html';
  const curl = 'curl --fail-with-body';
  const archive = `tar -czf - -C ${shellQuote(directory)} . | ${curl} --data-binary @- "${url}"`;

  const data = `--data-binary @${shellQuote(file)}`;
  const lower = file.toLowerCase();
  let single_file: string;
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    single_file = `${curl} -H 'Content-Type: text/html' ${data} "${url}"`;
  } else if (lower.endsWith('.md')) {
    single_file = `${curl} -H 'Content-Type: text/markdown' ${data} "${url}"`;
  } else {
    const basename = file.slice(file.lastIndexOf('/') + 1);
    single_file = `${curl} ${data} "${url}?filename=${queryValue(basename)}"`;
  }
  return { archive, single_file };
}

/** `text` as one shell word: as is when every character is safe, else in single quotes. */
function shellQuote(text: string): string {
  if (SHELL_SAFE.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * `encodeURIComponent`, plus the five characters it leaves alone that a shell could still act
 * on inside double quotes (`!` is history expansion in an interactive bash).
 */
function queryValue(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Publishes the body of an upload to the session behind `token`. A token works once: a retry
 * after success is refused with the version it made, one during an upload is refused as in
 * progress, one after expiry says how to get a new URL. An upload that fails before the session
 * expires gives the session back, so the same command can be run again once it is fixed, unless
 * the creator's credentials were revoked meanwhile. The creator must still have access when the
 * upload arrives.
 */
export async function runUpload(
  deps: AppDeps,
  token: string,
  input: UploadInput,
): Promise<PublishResult> {
  const h = hashSecret(token);
  const session = await deps.oneTime.take<UploadSession>(sessionKey(h));
  if (session === null) {
    input.body.destroy();
    throw await refusal(deps, h);
  }

  const { expiresAt } = session;
  const group = userGroup(session.actorId);
  await deps.oneTime.put<UploadReceipt>(
    receiptKey(h),
    { state: 'running', expiresAt },
    UPLOAD_RECEIPT_TTL_MS,
    group,
  );
  try {
    const actor = await activeUser(deps, session.actorId);
    const outcome = await ingestUpload(deps, session.target, input, {
      actor,
      source: session.source,
      message: session.message,
    });
    const result = toPublishResult(deps.config, outcome);
    await deps.oneTime.put<UploadReceipt>(
      receiptKey(h),
      { state: 'done', expiresAt, result },
      UPLOAD_RECEIPT_TTL_MS,
      group,
    );
    return result;
  } catch (error) {
    input.body.destroy();
    // A revocation while the upload ran removed its receipt: the URL stays gone.
    if ((await deps.oneTime.peek<UploadReceipt>(receiptKey(h))) === null) throw error;
    // The receipt first: a retry that comes in between is told the upload is in progress.
    await deps.oneTime.put<UploadReceipt>(
      receiptKey(h),
      { state: 'open', expiresAt },
      UPLOAD_RECEIPT_TTL_MS,
      group,
    );
    const left = expiresAt - deps.clock.now();
    if (left > 0) await deps.oneTime.put(sessionKey(h), session, left, group);
    throw error;
  }
}

/** Why an upload URL without a live session cannot be used, from its receipt. */
async function refusal(deps: AppDeps, h: string): Promise<AppError> {
  const receipt = await deps.oneTime.peek<UploadReceipt>(receiptKey(h));
  if (receipt === null) return notFound(t('publish.session.unknown'));
  if (receipt.state === 'done') {
    const { artifact_id, version_id, version_number, review_url } = receipt.result;
    return new AppError(
      'upload_session_used',
      409,
      t('publish.session.used', { number: version_number }),
      { artifact_id, version_id, version_number, review_url },
    );
  }
  // An upload still reading its body may yet publish, even past expiry: saying "expired" would
  // invite a second publish of the same thing.
  if (receipt.state === 'running' || deps.clock.now() < receipt.expiresAt) {
    return new AppError('upload_session_used', 409, t('publish.session.running'), {
      in_progress: true,
    });
  }
  return new AppError('upload_session_expired', 410, t('publish.session.expired'), {
    expired_at: receipt.expiresAt,
  });
}

/** The session's creator, refused with `access_denied` when they were removed or blocked since. */
async function activeUser(deps: AppDeps, id: string): Promise<UserRow> {
  const user = await deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (user === undefined || !hasAccess(user)) {
    throw new AppError('access_denied', 403, t('auth.accessDenied'));
  }
  return user;
}

/** The version a publish made, as the API returns it. */
export function toPublishResult(config: Config, o: PublishOutcome): PublishResult {
  const { artifact, version } = o;
  return {
    artifact_id: artifact.id,
    version_id: version.id,
    version_number: version.number,
    kind: artifact.kind,
    entry_path: version.entry_path,
    file_count: version.file_count,
    total_bytes: version.total_bytes,
    ...publishLinks(config, artifact.id, version.number),
    warnings: o.warnings,
  };
}
