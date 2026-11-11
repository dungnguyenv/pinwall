import { useCallback, useState } from 'react';
import type { Comment } from '../../api/dto.ts';
import { readText, writeText } from '../../lib/storage.ts';

/** The header that proves a guest wrote a comment: the same name the server reads. */
export const GUEST_TOKEN_HEADER = 'X-Pinwall-Guest-Token';
/** How long after writing a comment its guest may edit or delete it. The server enforces the same 15 minutes. */
export const GUEST_EDIT_WINDOW_MS = 900_000;

/** The longest name the server accepts for a guest. */
const GUEST_NAME_MAX = 60;
const GUEST_NAME_KEY = 'pinwall:guest-name';
const tokenKey = (commentId: string) => `pinwall:guest-token:${commentId}`;

/*
 * A guest's edit token is shown once, when the comment is written. It lives in
 * this tab's sessionStorage, never in localStorage or the query cache, and it
 * is worth nothing after the 15-minute window.
 */

export function rememberGuestToken(commentId: string, token: string): void {
  writeText(tokenKey(commentId), token, { session: true });
}

export function guestTokenFor(commentId: string): string | null {
  return readText(tokenKey(commentId), { session: true });
}

export function forgetGuestToken(commentId: string): void {
  writeText(tokenKey(commentId), null, { session: true });
}

/** Whether this browser's guest may still edit or delete `c`: a guest's comment, a token held, inside the window. */
export function guestMayChange(c: Comment, now: number): boolean {
  return (
    c.author.type === 'guest' &&
    guestTokenFor(c.id) !== null &&
    now < c.created_at + GUEST_EDIT_WINDOW_MS
  );
}

/**
 * The name this browser's guest signs comments with, remembered across visits.
 * Names are trimmed and cut to 60 characters when set, so the form should keep
 * what is typed in its own field and set the name when the guest is done
 * (blur or send), not on every key. Without storage the name lasts while the
 * page is open.
 */
export function useGuestName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => readText(GUEST_NAME_KEY, { max: GUEST_NAME_MAX }) ?? '');
  const set = useCallback((next: string) => {
    const clean = next.trim().slice(0, GUEST_NAME_MAX).trim();
    setName(clean);
    writeText(GUEST_NAME_KEY, clean === '' ? null : clean);
  }, []);
  return [name, set];
}
