import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CreatePublishSessionRequest,
  ErrorBody,
  InlinePublishRequest,
  PublishResult,
  PublishSession,
  PublishTargetInput,
} from '@pinwall/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import { perUser, RATE_RULES } from '../auth/rate-limits.ts';
import type { PublishTarget } from '../domain/versions.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import {
  countFailedPublish,
  countRequestBytes,
  type FileSink,
  ingestInline,
  ingestStreamed,
  type PublishOptions,
  type PublishOutcome,
} from '../publish/ingest.ts';
import { IngestBudget, limitExceeded } from '../publish/limits.ts';
import { createPublishSession, toPublishResult } from '../publish/sessions.ts';
import {
  type FormPart,
  type FormReader,
  readUploadForm,
  uploadFormError,
} from '../publish/upload-form.ts';
import { declaredLength } from '../publish/upload-route.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const created = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const authErrors = {
  401: error('Not signed in'),
  403: error('A cross-site request with the session cookie (`forbidden`)'),
};
const targetErrors = {
  404: error('The artifact or project does not exist (`not_found`)'),
  409: error(
    'The artifact has a newer version than `expected_version_id` (`version_conflict`), or the project is archived (`conflict`)',
  ),
  410: error('The artifact was deleted (`gone`)'),
};

/** The target as the publishing services take it; `{}` is a new artifact in the default project. */
export function toPublishTarget(i: PublishTargetInput): PublishTarget {
  if ('artifact_id' in i) {
    return {
      kind: 'new_version',
      artifactId: i.artifact_id,
      expectedVersionId: i.expected_version_id,
    };
  }
  return {
    kind: 'new_artifact',
    projectId: i.project_id ?? null,
    name: i.name ?? null,
    tags: i.tags ?? [],
  };
}

/** A version message as stored: an empty or blank one is no message. */
export function messageOf(message: string | undefined): string | null {
  return message === undefined || message.trim() === '' ? null : message;
}

/**
 * Inline files arrive JSON-escaped, which can double their size; past twice the inline limit
 * plus room for the rest of the body, the request cannot be within the limit. A body without a
 * length is read here as it arrives: one that breaks off before its end (the client went away)
 * is a 400, as for an upload, not a server error.
 */
const inlineBodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const max = c.var.deps.config.limits.maxInlineBytes;
  let reading = true;
  try {
    return await bodyLimit({
      maxSize: 2 * max + 65_536,
      onError: () => {
        throw limitExceeded('max_inline_bytes', max);
      },
    })(c, () => {
      reading = false;
      return next();
    });
  } catch (error) {
    if (reading && !(error instanceof AppError)) throw badRequest(t('publish.inline.interrupted'));
    throw error;
  }
};

const createSessionRoute = createRoute({
  method: 'post',
  path: '/publish-sessions',
  tags: ['publishing'],
  summary: 'Create a one-time upload URL',
  description:
    'Returns an upload URL that publishes one request body to the target, and ready-to-run commands for it. The URL needs no other credential, works once, and expires after `PINWALL_UPLOAD_SESSION_TTL`. The body of `POST <upload_url>` is a tar, tar.gz or zip archive (told by its bytes), or a single file: HTML or Markdown by its Content-Type, anything else named with `?filename=`. With a quota, a body whose `Content-Length` is larger than what is left in the space is refused before it is read, and one that goes over the bytes or files left while it streams stops there (`quota_exceeded`). An upload whose body sends nothing for 60 seconds, or that runs past the deadline of a publish (10 minutes, or the time `PINWALL_MAX_UPLOAD_BYTES` takes at 64 KiB/s when that is longer), ends with 408 `request_timeout`. Counts toward the limit of 60 publishes per user per 10 minutes, shared by every way to publish.',
  middleware: [
    requireAuth,
    perUser(RATE_RULES.publish),
    jsonBodyLimit,
  ] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreatePublishSessionRequest } },
    },
  },
  responses: {
    201: created('The upload URL and its commands', PublishSession),
    400: error('Invalid fields or tags'),
    ...authErrors,
    ...targetErrors,
    413: error('The space the publish fills is already full (`quota_exceeded`)'),
    429: error('Over the limit shared by every way to publish (`rate_limited`)'),
  },
});

const inlineRoute = createRoute({
  method: 'post',
  path: '/publish/inline',
  tags: ['publishing'],
  summary: 'Publish text files given inline',
  description:
    'Publishes text files (HTML, Markdown, CSS, JavaScript, SVG, JSON and other text types) given as strings, up to `PINWALL_MAX_INLINE_BYTES` of UTF-8 in all. For anything larger or binary, use an upload URL. Counts toward the limit of 60 publishes per user per 10 minutes, shared by every way to publish.',
  middleware: [
    requireAuth,
    perUser(RATE_RULES.publish),
    inlineBodyLimit,
  ] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: InlinePublishRequest } } },
  },
  responses: {
    201: created('The new version', PublishResult),
    400: error('Invalid fields, a refused path, a binary file, or no entry page'),
    ...authErrors,
    ...targetErrors,
    408: error(
      'The publish ran past its deadline, 10 minutes or the time `PINWALL_MAX_UPLOAD_BYTES` takes at 64 KiB/s when that is longer (`request_timeout`)',
    ),
    413: error(
      'Over the inline limit or another publishing limit (`payload_too_large`), or the version does not fit in the space it fills (`quota_exceeded`)',
    ),
    429: error(
      'Over the limit shared by every way to publish, or with 2 of your publishes, or 4 on the server, already in progress (`rate_limited`, with `Retry-After`). An admin is held to their own 2 only.',
    ),
  },
});

const uploadRoute = createRoute({
  method: 'post',
  path: '/publish/upload',
  tags: ['publishing'],
  summary: 'Publish files uploaded from a browser',
  description:
    'A `multipart/form-data` body, read while it streams: a `target` field (the JSON of a publish target) and an optional `message` first, then the files as `file` parts. To publish a folder, put a `path` field before each `file` part with its path in the folder; without `path` fields each part is stored under its filename. A `.zip`, `.tar`, `.tgz` or `.tar.gz` part sent first and without a `path` is unpacked, and must then be the only file. Every file part counts toward `PINWALL_MAX_FILES`, and the upload stops at the part that crosses a limit. With a quota, a declared `Content-Length` larger than what is left in the space is refused before any file is stored, and the upload stops as soon as its files go over the bytes or files left. Counts toward the limit of 60 publishes per user per 10 minutes, shared by every way to publish.',
  middleware: [requireAuth, perUser(RATE_RULES.publish)] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          // Described, not validated: the handler reads the parts in order.
          schema: {
            type: 'object',
            required: ['target', 'file'],
            properties: {
              target: { type: 'string', description: 'A publish target, as JSON' },
              message: { type: 'string', maxLength: 2000 },
              path: { type: 'array', items: { type: 'string' } },
              file: { type: 'array', items: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
  },
  responses: {
    201: created('The new version', PublishResult),
    400: error(
      'Not a form with a target and then files, a refused path, or an archive sent with other files',
    ),
    ...authErrors,
    ...targetErrors,
    413: error(
      'Over a publishing limit (`payload_too_large`), or the version does not fit in the space it fills (`quota_exceeded`)',
    ),
    415: error('A single archive part that is not a tar, tar.gz or zip'),
    429: error(
      'Over the limit shared by every way to publish, or with 2 of your publishes, or 4 on the server, already in progress (`rate_limited`, with `Retry-After`). An admin is held to their own 2 only.',
    ),
  },
});

/** Parts named like an archive: one sent first and without a `path` is unpacked. */
const ARCHIVE_NAME = /\.(zip|tar|tgz|tar\.gz)$/i;

/** The form fields besides the files. */
const UploadFields = z.object({
  target: PublishTargetInput,
  message: CreatePublishSessionRequest.shape.message,
});

type FilePart = Extract<FormPart, { kind: 'file' }>;

/** A web upload's form up to its first file. */
interface FormHead {
  fields: z.infer<typeof UploadFields>;
  /** The `path` sent before the first file; null when the form sends none. */
  path: string | null;
  file: FilePart;
}

/**
 * Publishes a web upload while its form streams in (the route's description gives the form).
 * Every limit counts as the parts arrive: the request's size, the number of file parts
 * (`PINWALL_MAX_FILES`, whatever their names, junk included) and each file's size, so a refused
 * upload stops at the part that crossed one and keeps nothing it stored. Only the file being
 * stored is held in memory.
 */
async function publishWebUpload(
  c: Context<AppEnv>,
  opts: Omit<PublishOptions, 'message'>,
): Promise<PublishOutcome> {
  const { deps } = c.var;
  const budget = new IngestBudget(
    deps.config.limits,
    declaredLength(c.req.header('content-length')),
  );
  let opened: OpenedUpload;
  try {
    opened = await openWebUpload(c, budget);
  } catch (error) {
    // `ingestStreamed` counts the publish from here on; a refusal before it is counted here.
    countFailedPublish(deps, opts.source, error, budget.requestBytesRead);
    throw error;
  }
  const { form, head, next } = opened;
  return ingestStreamed(
    deps,
    toPublishTarget(head.fields.target),
    { ...opts, message: messageOf(head.fields.message) },
    budget,
    (error) => form.destroy(error),
    (sink) => storeFormFiles(head, next, sink),
  );
}

/** A web upload read up to its first file. */
interface OpenedUpload {
  form: FormReader;
  head: FormHead;
  /** The next part of `form`; each file part counts toward `PINWALL_MAX_FILES`. */
  next: () => Promise<FormPart | null>;
}

/**
 * Refuses a declared length over `PINWALL_MAX_UPLOAD_BYTES`, then reads the form up to its first
 * file, counting every request byte in `budget`. On failure the request body is destroyed.
 */
async function openWebUpload(c: Context<AppEnv>, budget: IngestBudget): Promise<OpenedUpload> {
  const { limits } = c.var.deps.config;
  const raw = c.req.raw.body === null ? Readable.from([]) : Readable.fromWeb(c.req.raw.body);
  const declared = declaredLength(c.req.header('content-length'));
  if (declared !== null && declared > limits.maxUploadBytes) {
    raw.destroy();
    throw limitExceeded('max_upload_bytes', limits.maxUploadBytes);
  }
  const form = readUploadForm(countRequestBytes(raw, budget), c.req.header('content-type') ?? '');
  let files = 0;
  const next = async (): Promise<FormPart | null> => {
    const part = await form.next();
    if (part?.kind === 'file') {
      files += 1;
      if (files > limits.maxFiles) throw limitExceeded('max_files', limits.maxFiles);
    }
    return part;
  };
  try {
    return { form, head: await readFormHead(next), next };
  } catch (error) {
    form.destroy();
    throw error;
  }
}

/** Reads the fields that come before the first file, and that file. */
async function readFormHead(next: () => Promise<FormPart | null>): Promise<FormHead> {
  let target: string | null = null;
  let message: string | undefined;
  let path: string | null = null;
  for (;;) {
    const part = await next();
    if (part === null) throw uploadFormError();
    if (part.kind === 'field') {
      if (part.name === 'target') target = part.value;
      else if (part.name === 'message') message = part.value;
      else if (part.name === 'path') {
        if (path !== null) throw uploadFormError();
        path = part.value;
      }
    } else if (part.name !== 'file') {
      part.body.resume();
    } else {
      if (target === null) throw uploadFormError();
      return { fields: parseUploadFields(target, message), path, file: part };
    }
  }
}

function parseUploadFields(
  target: string,
  message: string | undefined,
): z.infer<typeof UploadFields> {
  let targetJson: unknown;
  try {
    targetJson = JSON.parse(target);
  } catch {
    throw badRequest(t('error.validation'), {
      issues: [{ path: 'target', message: 'Must be JSON' }],
    });
  }
  const parsed = UploadFields.safeParse({ target: targetJson, message });
  if (!parsed.success) {
    throw badRequest(t('error.validation'), {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Stores the first file, then each later one as it arrives. With `path` fields, every file needs
 * one right before it; without, each is stored under its filename. A first file named like an
 * archive, without a `path`, is unpacked instead, and no other file may follow it.
 */
async function storeFormFiles(
  head: FormHead,
  next: () => Promise<FormPart | null>,
  sink: FileSink,
): Promise<void> {
  const unpack = head.path === null && ARCHIVE_NAME.test(head.file.filename);
  if (unpack) await sink.archive(head.file.body);
  else await sink.file(head.path ?? head.file.filename, head.file.body);

  let path: string | null = null;
  for (let part = await next(); part !== null; part = await next()) {
    if (part.kind === 'field') {
      // The fields that describe the publish come first; only paths may follow.
      if (part.name === 'target' || part.name === 'message') throw uploadFormError();
      if (part.name !== 'path') continue;
      if (head.path === null || path !== null) throw uploadFormError();
      path = part.value;
    } else if (part.name !== 'file') {
      part.body.resume();
    } else {
      if (unpack) throw badRequest(t('publish.upload.archiveAlone'));
      if (head.path !== null && path === null) throw uploadFormError();
      await sink.file(path ?? part.filename, part.body);
      path = null;
    }
  }
  if (path !== null) throw uploadFormError();
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerPublishRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(createSessionRoute, async (c) => {
    const body = c.req.valid('json');
    const session = await createPublishSession(c.var.deps, authOf(c).user, {
      target: toPublishTarget(body.target),
      message: messageOf(body.message),
      source: 'api',
      directory: body.directory,
      file: body.file,
    });
    return c.json(session, 201, noStore);
  });

  api.openapi(inlineRoute, async (c) => {
    const body = c.req.valid('json');
    const { deps } = c.var;
    const outcome = await ingestInline(deps, toPublishTarget(body.target), body.files, {
      actor: authOf(c).user,
      source: 'inline',
      message: messageOf(body.message),
    });
    return c.json(toPublishResult(deps.config, outcome), 201, noStore);
  });

  api.openapi(uploadRoute, async (c) => {
    const outcome = await publishWebUpload(c, { actor: authOf(c).user, source: 'web' });
    return c.json(toPublishResult(c.var.deps.config, outcome), 201, noStore);
  });
}
