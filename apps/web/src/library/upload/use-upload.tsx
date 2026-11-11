import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { type ChangeEvent, type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type NavigateFunction, useNavigate } from 'react-router';
import { errorMessage, isApiError } from '../../api/client.ts';
import type { PublishTargetInput } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { getArtifact } from '../../api/library.ts';
import { usePublicConfig } from '../../api/session.ts';
import {
  checkSelection,
  collectFromFileList,
  hiddenFiles,
  selectionStats,
  type UploadSelection,
  withoutHidden,
} from '../../lib/upload/collect.ts';
import { buildUploadForm, sendUpload } from '../../lib/upload/send.ts';
import { toast } from '../../ui/index.ts';
import { type HiddenChoice, HiddenFilesDialog } from './hidden-files-dialog.tsx';
import {
  createUploadStore,
  nextUploadToastId,
  TOAST_PUBLISHED,
  TOAST_STAYS,
  toastUploadFailure,
  UploadToast,
} from './upload-toast.tsx';

interface UploadContext {
  t: TFunction;
  queryClient: QueryClient;
  navigate: NavigateFunction;
}

/**
 * Sends one selection and keeps its toast up to date. It runs to the end even
 * when the page that started it is gone: the toast outlives the page.
 */
function runUpload(
  s: UploadSelection,
  target: PublishTargetInput,
  projectId: string | null,
  note: string | undefined,
  { t, queryClient, navigate }: UploadContext,
): void {
  const { label } = selectionStats(s);
  const id = nextUploadToastId();
  const controller = new AbortController();
  const store = createUploadStore({ phase: 'preparing' });

  // Called again whenever the toast's size or lifetime changes, so sonner measures and times it anew.
  const show = (timing: { duration: number }, dismissible: boolean) =>
    toast.custom(
      () => (
        <UploadToast
          label={label}
          note={note}
          store={store}
          onCancel={() => controller.abort()}
          onOpen={(href) => {
            toast.dismiss(id);
            void navigate(href);
          }}
          onClose={() => toast.dismiss(id)}
        />
      ),
      { id, ...timing, dismissible },
    );

  show(TOAST_STAYS, false);
  let phase = store.get().phase;
  sendUpload(buildUploadForm(target, s), {
    signal: controller.signal,
    onProgress: (progress) => {
      store.set(progress);
      if (progress.phase === phase) return;
      phase = progress.phase;
      show(TOAST_STAYS, false);
    },
  }).then(
    async (result) => {
      // The publish result has no name; the artifact does, and is cached for its page.
      const artifact = await queryClient
        .fetchQuery({
          queryKey: qk.artifact(result.artifact_id),
          queryFn: () => getArtifact(result.artifact_id),
        })
        .catch(() => null);
      const project = projectId ?? artifact?.project_id ?? null;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.artifactLists }),
        queryClient.invalidateQueries({ queryKey: qk.projectLists }),
        project ? queryClient.invalidateQueries({ queryKey: qk.project(project) }) : null,
      ]);
      store.set({
        phase: 'published',
        name: artifact?.name ?? label,
        number: result.version_number,
        href: `/a/${encodeURIComponent(result.artifact_id)}`,
        warnings: result.warnings,
      });
      // Warnings stay until read; a plain success leaves on its own.
      show(result.warnings.length > 0 ? TOAST_STAYS : TOAST_PUBLISHED, true);
    },
    (error: unknown) => {
      if (isApiError(error, 'aborted')) {
        toast.dismiss(id);
        return;
      }
      store.set({ phase: 'failed', message: errorMessage(error, t) });
      show(TOAST_STAYS, true);
    },
  );
}

export interface UploadControls {
  /** Checks the selection against the public limits, then publishes it with a progress toast. */
  start(s: UploadSelection): void;
  /** Opens the browser's picker for files (or one archive), or for a folder. */
  pick(kind: 'files' | 'folder'): void;
  /**
   * The hidden file inputs `pick` opens, and the dialog that asks about hidden
   * files before they are sent. Render them once, anywhere on the page.
   */
  inputs: ReactNode;
  /** The project uploads go to, for headings. */
  projectName: string;
  /** How many selections this has taken so far; the upload dialog closes when it goes up. */
  started: number;
}

/** What the toast says about the files that were not sent, or nothing when all of them were. */
function leftOutNote(t: TFunction, versionControl: number, hidden: number): string | undefined {
  const parts = [
    versionControl > 0 ? t('web.upload.skippedVcs', { count: versionControl }) : null,
    hidden > 0 ? t('web.upload.skippedHidden', { count: hidden }) : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Upload into one project (`projectId`), or into the default project when it
 * is `null`. Each upload gets its own toast with its progress, a Cancel while
 * the body is going up, and then the published version with an Open link, or
 * the server's message as it wrote it. A selection over the limits the server
 * publishes is refused before anything is sent. Files in version-control
 * folders are never sent, and the person says whether hidden files (names
 * starting with a dot) are, before anything leaves the browser.
 */
export function useUpload(target: {
  projectId: string | null;
  projectName: string;
  disabled?: boolean;
}): UploadControls {
  const { projectId, projectName, disabled = false } = target;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const limits = usePublicConfig().data?.limits;
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [started, setStarted] = useState(0);

  // A selection with hidden files waits here for the person's answer.
  const [asked, setAsked] = useState<{ selection: UploadSelection; paths: string[] } | null>(null);

  const send = useCallback(
    (s: UploadSelection, hiddenLeftOut: number) => {
      const { label, files } = selectionStats(s);
      const note = leftOutNote(t, s.kind === 'files' ? (s.skipped ?? 0) : 0, hiddenLeftOut);
      // Before the configuration loads, only an empty selection is refused here; the server checks the rest.
      const problem = limits
        ? checkSelection(s, limits, t)
        : files === 0
          ? t('web.upload.empty')
          : null;
      if (problem) {
        toastUploadFailure(label, problem, note);
        return;
      }
      runUpload(s, projectId ? { project_id: projectId } : {}, projectId, note, {
        t,
        queryClient,
        navigate,
      });
    },
    [limits, t, projectId, queryClient, navigate],
  );

  const start = useCallback(
    (s: UploadSelection) => {
      if (disabled) return;
      setStarted((n) => n + 1);
      const hidden = hiddenFiles(s);
      if (hidden.length > 0) {
        setAsked({ selection: s, paths: hidden.map(({ path }) => path) });
        return;
      }
      send(s, 0);
    },
    [disabled, send],
  );

  const answer = useCallback(
    (choice: HiddenChoice) => {
      if (!asked) return;
      setAsked(null);
      if (choice === 'include') send(asked.selection, 0);
      else if (choice === 'skip') send(withoutHidden(asked.selection), asked.paths.length);
    },
    [asked, send],
  );

  const pick = useCallback((kind: 'files' | 'folder') => {
    (kind === 'folder' ? folderInput : filesInput).current?.click();
  }, []);

  const inputs = useMemo(() => {
    const chosen = (folder: boolean) => (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const selection = collectFromFileList(input.files ?? [], { folder });
      // Cleared so choosing the same files again is a change too.
      input.value = '';
      if (selection) start(selection);
    };
    return (
      <>
        <input ref={filesInput} type="file" multiple hidden onChange={chosen(false)} />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          onChange={chosen(true)}
          // Not in React's types; every current browser supports it.
          {...{ webkitdirectory: '' }}
        />
        <HiddenFilesDialog paths={asked?.paths ?? null} onChoose={answer} />
      </>
    );
  }, [start, asked, answer]);

  return { start, pick, inputs, projectName, started };
}
