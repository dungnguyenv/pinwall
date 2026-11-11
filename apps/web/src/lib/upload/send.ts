import { ApiError, apiUrl, errorFromBody, notifyUnauthorized } from '../../api/client.ts';
import { PublishResult, type PublishTargetInput } from '../../api/dto.ts';
import type { UploadSelection } from './collect.ts';

/** How far an upload is: sending the body, then waiting while the server publishes it. */
export interface UploadProgress {
  phase: 'uploading' | 'processing';
  loaded: number;
  total: number;
}

/**
 * The body of `POST /publish/upload`: the target first, then for each file a
 * `path` field followed by its `file` part, so the server can stream them in
 * order. An archive is a single `file` part without a path, which the server
 * unpacks.
 */
export function buildUploadForm(target: PublishTargetInput, s: UploadSelection): FormData {
  const form = new FormData();
  form.append('target', JSON.stringify(target));
  if (s.kind === 'archive') {
    form.append('file', s.file, s.file.name);
    return form;
  }
  for (const { path, file } of s.files) {
    form.append('path', path);
    form.append('file', file, path.slice(path.lastIndexOf('/') + 1));
  }
  return form;
}

function aborted(): ApiError {
  return new ApiError(0, 'aborted', '');
}

/**
 * Sends a web upload and resolves with the version it published. This is an
 * XMLHttpRequest because fetch reports no upload progress. The browser sets
 * the multipart Content-Type with its boundary, and Origin for the CSRF check.
 * Rejects with an `ApiError` like `api()` does; cancelling through `signal`
 * rejects with code `aborted`.
 */
export function sendUpload(
  form: FormData,
  o: { onProgress?(p: UploadProgress): void; signal?: AbortSignal },
): Promise<PublishResult> {
  const { onProgress, signal } = o;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/publish/upload'));
    xhr.setRequestHeader('accept', 'application/json');

    let total = 0;
    xhr.upload.onprogress = (event) => {
      total = event.lengthComputable ? event.total : Math.max(total, event.loaded);
      onProgress?.({ phase: 'uploading', loaded: event.loaded, total });
    };
    xhr.upload.onload = () => onProgress?.({ phase: 'processing', loaded: total, total });

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => signal?.removeEventListener('abort', onAbort);

    xhr.onload = () => {
      settle();
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = errorFromBody(xhr.status, xhr.responseText);
        notifyUnauthorized(error);
        reject(error);
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      const parsed = PublishResult.safeParse(body);
      if (parsed.success) {
        resolve(parsed.data);
      } else {
        const error = new ApiError(xhr.status, 'invalid_response', '');
        error.cause = parsed.error;
        reject(error);
      }
    };
    xhr.onerror = () => {
      settle();
      reject(new ApiError(0, 'network', ''));
    };
    xhr.onabort = () => {
      settle();
      reject(aborted());
    };
    xhr.send(form);
  });
}
