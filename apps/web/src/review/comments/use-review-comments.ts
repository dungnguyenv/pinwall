import { type UseQueryResult, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../api/client.ts';
import type { CommentThread, LiveEvent } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { usePref } from '../../lib/storage.ts';
import type { PickedAnchor, ViewerPin } from '../frame/use-frame-bridge.ts';
import type { CommentBackend, Permissions } from './backend.ts';
import {
  applyLiveEvent,
  countThreads,
  filterThreads,
  pinNumbers,
  type ThreadFilter,
  type ThreadScope,
  threadsForVersion,
} from './threads.ts';
import { useCommentActions, useThreads } from './use-threads.ts';

/**
 * A comment being written: the spot picked, and the id of the version shown
 * when it was picked. The thread is saved on that version, even when a newer
 * one is shown by the time it is sent.
 */
export interface Draft extends PickedAnchor {
  versionId: string | null;
}

/** Whose text a composer holds: the new comment, a thread's reply, or a comment being edited. */
export type TextKey = 'new' | `reply:${string}` | `edit:${string}`;

export interface ReviewComments {
  query: UseQueryResult<CommentThread[], ApiError>;
  actions: ReturnType<typeof useCommentActions>;
  permissions: Permissions;
  /** Where these comments live; a member's comments have links to copy. */
  scope: ThreadScope;
  /** The id of the version shown, which a resolve names. */
  versionId: string | null;
  /** The threads the filter lists. */
  visible: CommentThread[];
  /** Every thread written on the version shown or before it. */
  shownAll: CommentThread[];
  counts: { open: number; resolved: number };
  /** Each thread's pin number on the version shown. */
  numbers: Map<string, number>;
  /** The pins of the listed threads, plus `draft` while a comment is being written. */
  pins: ViewerPin[];
  filter: ThreadFilter;
  /** Changes the filter; threads kept listed by a resolve, a reopen or a selection drop out. */
  setFilter(f: ThreadFilter): void;
  selectedId: string | null;
  /** Selects a thread, which then stays listed until the filter changes. */
  select(id: string | null): void;
  draft: Draft | null;
  /** Starts a comment at `d`. A new pick while one is open moves it and keeps its text. */
  startDraft(d: PickedAnchor): void;
  /** Drops the comment being written and its text. */
  cancelDraft(): void;
  /** Whether any new comment, reply or edit holds text: switching what is shown would lose it. */
  composing: boolean;
  text(key: TextKey): string;
  setText(key: TextKey, text: string): void;
  /** Applies a live update to the cache. A thread resolved or reopened by anyone stays listed. */
  applyLive(e: LiveEvent): void;
}

const FILTERS = ['open', 'resolved', 'all'] as const;
const REPLY = 'reply:';
const EDIT = 'edit:';
const NOTHING: ReadonlySet<string> = new Set();
const NO_THREADS: CommentThread[] = [];

/** The ids of threads in both lists whose status differs between them. */
function statusChanges(before: CommentThread[] | undefined, after: CommentThread[] | undefined) {
  if (before === undefined || after === undefined) return [];
  const was = new Map(before.map((thread) => [thread.id, thread.status]));
  return after
    .filter((thread) => {
      const status = was.get(thread.id);
      return status !== undefined && status !== thread.status;
    })
    .map((thread) => thread.id);
}

/** Whether `text` is something worth keeping. */
const filled = (text: string | undefined) => text !== undefined && text.trim() !== '';

/**
 * The comments of one review, as the panel, the composer and the frame need
 * them: the threads of the version shown, filtered and numbered, their pins,
 * the selection, the comment being written, and every text being typed.
 *
 * A thread whose status changes (a resolve or reopen by anyone, or a resync
 * that finds one) and a thread that is selected stay listed whatever the
 * filter, so nothing vanishes under the reviewer's eyes; choosing a filter
 * lets them go. When the number of open threads changes, the artifact and the
 * library lists, which show that number, are marked stale.
 */
export function useReviewComments(o: {
  backend: CommentBackend;
  permissions: Permissions;
  shown: number;
  versionId: string | null;
  filterPrefKey: string | null;
}): ReviewComments {
  const { backend, permissions, shown, versionId } = o;
  const queryClient = useQueryClient();
  const query = useThreads(backend);
  const actions = useCommentActions(backend);
  const list = query.data;

  const [filter, writeFilter] = usePref<ThreadFilter>(o.filterPrefKey, FILTERS, 'open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [texts, setTexts] = useState<ReadonlyMap<string, string>>(new Map());

  // Threads kept listed, with the list they were worked out from. Adjusted during render, so a
  // thread resolved under the Open filter never leaves the list for a frame.
  const [kept, setKept] = useState({ list, sticky: NOTHING });
  let sticky = kept.sticky;
  if (kept.list !== list) {
    const changed = statusChanges(kept.list, list);
    if (changed.length > 0) sticky = new Set([...sticky, ...changed]);
    setKept({ list, sticky });
  }

  const shownAll = useMemo(() => threadsForVersion(list ?? NO_THREADS, shown), [list, shown]);
  const visible = useMemo(
    () => filterThreads(shownAll, filter, sticky),
    [shownAll, filter, sticky],
  );
  const counts = useMemo(() => countThreads(shownAll), [shownAll]);
  const numbers = useMemo(() => pinNumbers(shownAll), [shownAll]);
  const pins = useMemo(() => {
    const out: ViewerPin[] = visible.map((thread) => ({
      id: thread.id,
      number: numbers.get(thread.id) ?? 0,
      resolved: thread.status === 'resolved',
      anchor: thread.anchor,
    }));
    if (draft !== null) {
      out.push({ id: 'draft', number: shownAll.length + 1, resolved: false, anchor: draft.anchor });
    }
    return out;
  }, [visible, numbers, draft, shownAll.length]);

  // A reply or edit counts only while its thread or comment is still there to send it to.
  const composing = useMemo(() => {
    const threads = new Set<string>();
    const comments = new Set<string>();
    for (const thread of list ?? NO_THREADS) {
      threads.add(thread.id);
      comments.add(thread.id);
      for (const reply of thread.replies) comments.add(reply.id);
    }
    for (const [key, text] of texts) {
      if (!filled(text)) continue;
      if (key === 'new') {
        if (draft !== null) return true;
      } else if (key.startsWith(REPLY)) {
        if (threads.has(key.slice(REPLY.length))) return true;
      } else if (key.startsWith(EDIT)) {
        if (comments.has(key.slice(EDIT.length))) return true;
      }
    }
    return false;
  }, [texts, draft, list]);

  // Library cards and the artifact show how many threads are open.
  const open = list === undefined ? null : countThreads(list).open;
  const lastOpen = useRef(open);
  const artifactId = backend.scope.kind === 'artifact' ? backend.scope.artifactId : null;
  useEffect(() => {
    const before = lastOpen.current;
    lastOpen.current = open;
    if (artifactId === null || before === null || open === null || before === open) return;
    // Marked stale, not read now: nothing on the review screen shows the number.
    void queryClient.invalidateQueries({ queryKey: qk.artifact(artifactId), refetchType: 'none' });
    void queryClient.invalidateQueries({ queryKey: qk.artifactLists, refetchType: 'none' });
  }, [open, artifactId, queryClient]);

  const setFilter = useCallback(
    (f: ThreadFilter) => {
      writeFilter(f);
      setKept((k) => ({ ...k, sticky: NOTHING }));
    },
    [writeFilter],
  );

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id !== null) {
      setKept((k) => (k.sticky.has(id) ? k : { ...k, sticky: new Set([...k.sticky, id]) }));
    }
  }, []);

  const setText = useCallback((key: TextKey, text: string) => {
    setTexts((now) => {
      if ((now.get(key) ?? '') === text) return now;
      const next = new Map(now);
      if (text === '') next.delete(key);
      else next.set(key, text);
      return next;
    });
  }, []);

  const text = useCallback((key: TextKey) => texts.get(key) ?? '', [texts]);

  // The latest version id and create mutation, read by the stable callbacks below.
  const latest = useRef({ versionId, create: actions.create });
  useLayoutEffect(() => {
    latest.current = { versionId, create: actions.create };
  });

  // A new or dropped draft starts without the last failure's message. A post still on its way
  // is left alone: its answer selects the thread it made.
  const clearSendError = useCallback(() => {
    const { create } = latest.current;
    if (create.isError) create.reset();
  }, []);

  const startDraft = useCallback(
    (d: PickedAnchor) => {
      clearSendError();
      setDraft({ ...d, versionId: latest.current.versionId });
    },
    [clearSendError],
  );

  const cancelDraft = useCallback(() => {
    clearSendError();
    setDraft(null);
    setText('new', '');
  }, [clearSendError, setText]);

  const scope = backend.scope;
  const applyLive = useCallback(
    (e: LiveEvent) => {
      queryClient.setQueryData<CommentThread[]>(
        qk.threads(scope),
        (now) => now && applyLiveEvent(now, e),
      );
    },
    [queryClient, scope],
  );

  return {
    query,
    actions,
    permissions,
    scope,
    versionId,
    visible,
    shownAll,
    counts,
    numbers,
    pins,
    filter,
    setFilter,
    selectedId,
    select,
    draft,
    startDraft,
    cancelDraft,
    composing,
    text,
    setText,
    applyLive,
  };
}
