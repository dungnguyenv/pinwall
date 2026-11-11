import { AppWindow, FileText } from 'lucide-react';
import { useState } from 'react';
import type { ArtifactSummary } from '../api/dto.ts';
import { cn } from '../ui/index.ts';
import { generatedCardColors } from './colors.ts';

export type ThumbSize = 'card' | 'row' | 'hero';

/**
 * The app-origin URL of the artifact's raster thumbnail, or `null` when its
 * current version has none. The version id makes a new version a new URL, so
 * a cached image never outlives the version it shows.
 */
export function thumbnailUrl(a: ArtifactSummary): string | null {
  const version = a.current_version;
  if (!version?.has_thumbnail) return null;
  return `/api/v1/artifacts/${encodeURIComponent(a.id)}/thumbnail?v=${encodeURIComponent(version.id)}`;
}

export function KindGlyph({ kind }: { kind: ArtifactSummary['kind'] }) {
  return kind === 'markdown' ? <FileText /> : <AppWindow />;
}

const FRAME: Record<ThumbSize, string> = {
  card: '',
  row: 'rounded-md border border-border',
  hero: 'rounded-xl border border-border shadow-card',
};

const TILE: Record<ThumbSize, string> = {
  card: 'size-8 rounded-md [&_svg]:size-4',
  row: 'size-6 rounded-sm [&_svg]:size-3.5',
  hero: 'size-12 rounded-lg [&_svg]:size-6',
};

/**
 * A card drawn from the artifact itself: its page's theme color (or a hue of
 * its own), the kind of page as a glyph, and its title set large. It repeats
 * what the name already says, so assistive technology skips it.
 */
function GeneratedCard({ artifact, size }: { artifact: ArtifactSummary; size: ThumbSize }) {
  const version = artifact.current_version;
  const colors = generatedCardColors(artifact.id, version?.theme_color ?? null);
  const title = version?.title?.trim() || artifact.name;
  return (
    <div
      aria-hidden="true"
      data-thumb="generated"
      style={{ backgroundColor: colors.background, color: colors.foreground }}
      className={cn(
        '@container flex size-full select-none flex-col',
        size === 'row' && 'items-center justify-center',
        size === 'card' && 'justify-between p-4',
        size === 'hero' && 'justify-between p-6 sm:p-10',
      )}
    >
      <span
        style={{ backgroundColor: colors.accent }}
        className={cn('grid shrink-0 place-items-center', TILE[size])}
      >
        <KindGlyph kind={artifact.kind} />
      </span>
      {size === 'row' ? null : (
        <span
          className={cn(
            'line-clamp-3 text-balance font-semibold tracking-tight [overflow-wrap:anywhere]',
            size === 'card' ? 'text-lg @[18rem]:text-xl' : 'text-2xl @[36rem]:text-3xl',
          )}
        >
          {title}
        </span>
      )}
    </div>
  );
}

/**
 * The artifact's picture on a fixed 16:10 box: its raster thumbnail when it
 * has one, else, or when the image fails to load, the generated card.
 */
export function ArtifactThumb({ artifact, size }: { artifact: ArtifactSummary; size: ThumbSize }) {
  const url = thumbnailUrl(artifact);
  // The URL that failed; a new version brings a new URL, which gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = url !== null && failed !== url;
  return (
    <div
      className={cn(
        'relative aspect-[16/10] w-full shrink-0 overflow-hidden bg-surface-muted',
        FRAME[size],
      )}
    >
      {showImage ? (
        <img
          src={url}
          alt=""
          loading={size === 'hero' ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onError={() => setFailed(url)}
          className="size-full object-cover object-top"
        />
      ) : (
        <GeneratedCard artifact={artifact} size={size} />
      )}
    </div>
  );
}
