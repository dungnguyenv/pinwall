import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * How full screen is shown: the browser's own (`native`), a layer over the
 * window where the browser has no Fullscreen API or refused (`layer`), or
 * not at all.
 */
export type FullScreenMode = 'off' | 'native' | 'layer';

/**
 * Full screen for the element `target` points at. `enter` asks the browser
 * (its own Escape then works wherever focus is, even inside a frame) and keeps
 * in step with it through `fullscreenchange`. Without the API, or when the
 * browser refuses, it falls back to a fixed layer over the window, which
 * Escape leaves. The caller lays the element out as that layer when `mode` is
 * `layer`.
 */
export function useFullScreen(target: RefObject<HTMLElement | null>): {
  active: boolean;
  mode: FullScreenMode;
  enter(): void;
  exit(): void;
} {
  const [mode, setMode] = useState<FullScreenMode>('off');
  const current = useRef(mode);
  useLayoutEffect(() => {
    current.current = mode;
  });

  useEffect(() => {
    const onChange = () => {
      const el = target.current;
      if (el !== null && document.fullscreenElement === el) setMode('native');
      else if (current.current === 'native') setMode('off');
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [target]);

  useEffect(() => {
    if (mode !== 'layer') return;
    const onKeyDown = (e: KeyboardEvent) => {
      // A dialog or menu above the layer takes its own Escape.
      if (e.key === 'Escape' && !e.defaultPrevented) setMode('off');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode]);

  const enter = useCallback(() => {
    const el = target.current;
    if (el === null || current.current !== 'off') return;
    if (typeof el.requestFullscreen !== 'function') {
      setMode('layer');
      return;
    }
    el.requestFullscreen().then(
      () => setMode('native'),
      () => setMode('layer'),
    );
  }, [target]);

  const exit = useCallback(() => {
    if (current.current === 'off') return;
    if (current.current === 'native' && typeof document.exitFullscreen === 'function') {
      // Already out by the browser's own Escape is fine.
      document.exitFullscreen().catch(() => {});
    }
    current.current = 'off';
    setMode('off');
  }, []);

  return { active: mode !== 'off', mode, enter, exit };
}
