import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { isServerRoute } from './return-to.ts';

/** Full page loads go through here, so tests can watch them instead of jsdom refusing them. */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * Goes to `path`: inside the app with the router, or with a full page load
 * when the server answers that path (raw links, OIDC, OAuth).
 */
export function useGoTo(): (path: string, o?: { replace?: boolean }) => void {
  const navigate = useNavigate();
  return useCallback(
    (path, o) => {
      if (isServerRoute(path)) browser.assign(path);
      else void navigate(path, { replace: o?.replace ?? false });
    },
    [navigate],
  );
}
