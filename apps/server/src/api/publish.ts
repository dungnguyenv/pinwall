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
import { enforceRateLimit } from '../auth/rate-limits.ts';
import type { PublishTarget } from '../domain/versions.ts';
import { badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import {
  ingestFiles,
  ingestInline,
  ingestUpload,
  type PublishOptions,
  type PublishOutcome,
} from '../publish/ingest.ts';
import { limitExceeded } from '../publish/limits.ts';
import {
  createPublishSession,
  PUBLISH_SESSION_RATE,
  toPublishResult,
} from '../publish/sessions.ts';
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
function messageOf(message: string | undefined): string | null {
  return message === undefined || message.trim() === '' ? null : message;
}

/** Counts the attempt against the caller's own allowance, before the body is read. */
const sessionRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforceRateLimit(c, PUBLISH_SESSION_RATE, authOf(c).user.id);
  await next();
};

/**
 * Inline files arrive JSON-escaped, which can double their size; past twice the inline limit
 * plus room for the rest of the body, the request cannot be within the limit.
 */
const inlineBodyLimit: MiddlewareHandler<AppEnv> = (c, next) => {
  const max = c.var.deps.config.limits.maxInlineBytes;
  return bodyLimit({
    maxSize: 2 * max + 65_536,
    onError: () => {
      throw limitExceeded('max_inline_bytes', max);
    },
  })(c, next);
};

/** A web upload is one request, held to `PINWALL_MAX_UPLOAD_BYTES` like any other. */
const uploadBodyLimit: MiddlewareHandler<AppEnv> = (c, next) => {
  const max = c.var.deps.config.limits.maxUploadBytes;
  return bodyLimit({
    maxSize: max,
    onError: () => {
      throw limitExceeded('max_upload_bytes', max);
    },
  })(c, next);
};

const createSessionRoute = createRoute({
  method: 'post',
  path: '/publish-sessions',
  tags: ['publishing'],
  summary: 'Create a one-time upload URL',
  description:
    'Returns an upload URL that publishes one request body to the target, and ready-to-run commands for it. The URL needs no other credential, works once, and expires after `PINWALL_UPLOAD_SESSION_TTL`. The body of `POST <upload_url>` is a tar, tar.gz or zip archive (told by its bytes), or a single file: HTML or Markdown by its Content-Type, anything else named with `?filename=`. Limited to 60 per user per 10 minutes.',
  middleware: [requireAuth, sessionRateLimit, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
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
    429: error('Too many upload URLs (`rate_limited`)'),
  },
});

const inlineRoute = createRoute({
  method: 'post',
  path: '/publish/inline',
  tags: ['publishing'],
  summary: 'Publish text files given inline',
  description:
    'Publishes text files (HTML, Markdown, CSS, JavaScript, SVG, JSON and other text types) given as strings, up to `PINWALL_MAX_INLINE_BYTES` of UTF-8 in all. For anything larger or binary, use an upload URL.',
  middleware: [requireAuth, inlineBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: InlinePublishRequest } } },
  },
  responses: {
    201: created('The new version', PublishResult),
    400: error('Invalid fields, a refused path, a binary file, or no entry page'),
    ...authErrors,
    ...targetErrors,
    413: error('Over the inline limit or another publishing limit (`payload_too_large`)'),
  },
});

const uploadRoute = createRoute({
  method: 'post',
  path: '/publish/upload',
  tags: ['publishing'],
  summary: 'Publish files uploaded from a browser',
  description:
    'A `multipart/form-data` body: a `target` field (the JSON of a publish target), an optional `message`, then the files as `file` parts. To publish a folder, put a `path` field before each `file` part with its path in the folder; without `path` fields each part is stored under its filename. A single `.zip`, `.tar`, `.tgz` or `.tar.gz` part without a `path` is unpacked.',
  middleware: [requireAuth, uploadBodyLimit] as MiddlewareHandler<AppEnv>[],
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
    400: error('Not a form with a target and files, or a refused path'),
    ...authErrors,
    ...targetErrors,
    413: error('Over a publishing limit (`payload_too_large`)'),
    415: error('A single archive part that is not a tar, tar.gz or zip'),
  },
});

/** Parts named like an archive; such a part alone, without a `path`, is unpacked. */
const ARCHIVE_NAME = /\.(zip|tar|tgz|tar\.gz)$/i;

/** The form fields besides the files. */
const UploadFields = z.object({
  target: PublishTargetInput,
  message: CreatePublishSessionRequest.shape.message,
});

const formError = () => badRequest(t('publish.upload.form'));

interface UploadForm {
  fields: z.infer<typeof UploadFields>;
  /** Paths from `path` fields, matched to the files by order; empty when none were sent. */
  paths: string[];
  files: File[];
}

/** Reads the multipart body: `target`, `message`, then `path` and `file` parts in order. */
async function readUploadForm(c: Context<AppEnv>): Promise<UploadForm> {
  const type = c.req.header('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) throw formError();
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw formError();
  }

  let target: string | null = null;
  let message: string | undefined;
  const paths: string[] = [];
  const files: File[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      if (name === 'target') target = value;
      else if (name === 'message') message = value;
      else if (name === 'path') paths.push(value);
    } else if (name === 'file') {
      files.push(value);
    }
  }
  if (target === null || files.length === 0) throw formError();
  if (paths.length > 0 && paths.length !== files.length) throw formError();

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
  return { fields: parsed.data, paths, files };
}

/** Publishes a web upload: one archive part is unpacked, anything else is a set of files. */
async function publishForm(
  c: Context<AppEnv>,
  form: UploadForm,
  opts: PublishOptions,
): Promise<PublishOutcome> {
  const { deps } = c.var;
  const target = toPublishTarget(form.fields.target);
  const [only] = form.files;
  if (only !== undefined && form.files.length === 1 && form.paths.length === 0) {
    if (ARCHIVE_NAME.test(only.name)) {
      return ingestUpload(
        deps,
        target,
        {
          body: Readable.fromWeb(only.stream()),
          contentType: null,
          contentLength: only.size,
          filename: null,
        },
        opts,
      );
    }
  }
  const set = await Promise.all(
    form.files.map(async (file, i) => ({
      path: form.paths[i] ?? file.name,
      data: Buffer.from(await file.arrayBuffer()),
    })),
  );
  return ingestFiles(deps, target, set, opts);
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
    const form = await readUploadForm(c);
    const outcome = await publishForm(c, form, {
      actor: authOf(c).user,
      source: 'web',
      message: messageOf(form.fields.message),
    });
    return c.json(toPublishResult(c.var.deps.config, outcome), 201, noStore);
  });
}
