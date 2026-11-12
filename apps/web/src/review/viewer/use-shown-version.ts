import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary } from '../../api/dto.ts';
import { followVersion } from '../live/follow.ts';

/**
 * Which version the review shows. `/a/:id/v/:n` (`versionParam` set) shows
 * version n and stays there. `/a/:id` follows the current version: when it
 * changes, the review moves to it, unless the reviewer is writing
 * (`composing`) and the new one is newer; then it is only offered as
 * `pending` until `switchNow()`. Each move made while following is put in
 * `announce`, for a polite live region.
 */
export function useShownVersion(
  artifact: ArtifactSummary | undefined,
  versionParam: number | null,
  composing: boolean,
): {
  follow: boolean;
  shown: number | null;
  pending: number | null;
  switchNow(): void;
  announce: string | null;
} {
  const { t } = useTranslation();
  const follow = versionParam === null;
  const current = artifact?.current_version?.number ?? null;
  // What a follower shows. Starting to follow (from a chosen version, say) starts afresh.
  const [state, setState] = useState<{
    follow: boolean;
    shown: number | null;
    announce: string | null;
  }>({ follow, shown: null, announce: null });

  let { shown, announce } = state;
  let pending: number | null = null;
  if (state.follow !== follow) {
    shown = null;
    announce = null;
  }
  if (follow) {
    const next = followVersion({ follow, shown, current, composing });
    pending = next.pending;
    if (next.shown !== shown) {
      if (shown !== null && next.shown !== null) {
        announce = t('web.review.live.switched', { number: next.shown });
      }
      shown = next.shown;
    }
  }
  if (state.follow !== follow || state.shown !== shown || state.announce !== announce) {
    // Adjusting state during render: React renders again at once with it.
    setState({ follow, shown, announce });
  }

  const switchNow = useCallback(() => {
    if (pending === null) return;
    setState({
      follow: true,
      shown: pending,
      announce: t('web.review.live.switched', { number: pending }),
    });
  }, [pending, t]);

  return {
    follow,
    shown: follow ? shown : versionParam,
    pending,
    switchNow,
    announce: follow ? announce : null,
  };
}
