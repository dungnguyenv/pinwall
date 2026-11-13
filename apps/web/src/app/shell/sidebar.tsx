import type { UseQueryResult } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import {
  ChevronRight,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
} from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { type MouseEvent, type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type { Project } from '../../api/dto.ts';
import { useProjects, useRecent } from '../../api/library.ts';
import { splitProjects } from '../../api/spaces.ts';
import {
  ariaKeyShortcuts,
  Button,
  cn,
  ErrorState,
  IconButton,
  Kbd,
  LoadingRegion,
  Logo,
  Skeleton,
  Tooltip,
} from '../../ui/index.ts';
import { AccountMenu } from './account-menu.tsx';
import { useShellActions } from './shell-actions.ts';
import { useSidebarMode } from './sidebar-mode.ts';

const SEARCH_SHORTCUT = ['mod', 'k'];

// One row of the sidebar: a link or a button. The focus ring sits inside the
// row so the scrolling list never clips it.
const ROW =
  'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-base text-fg outline-offset-[-2px] transition-colors hover:bg-selected/70 [&_svg]:size-4 [&_svg]:shrink-0';
// NavLink marks the current page with aria-current. Styling on that attribute
// keeps class names static strings, which a tooltip trigger (Radix Slot) can
// merge; a className function would be turned into text.
const ROW_ACTIVE =
  'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:hover:bg-selected';

// The rail's square buttons, matched to IconButton's size.
const RAIL_ITEM = 'text-fg-muted hover:bg-selected/70 hover:text-fg';

function NavRow({
  to,
  end,
  icon,
  note,
  onNavigate,
  className,
  children,
}: {
  to: string;
  end?: boolean;
  icon?: ReactNode;
  /** A second, quieter line under the label. */
  note?: string;
  onNavigate?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={cn(ROW, note && 'h-auto py-1.5', className, ROW_ACTIVE)}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex text-fg-muted">
          {icon}
        </span>
      ) : null}
      {note ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate">{children}</span>
          <span className="block truncate text-fg-muted text-xs">{note}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
    </NavLink>
  );
}

/** A section label: small, upper-case and quiet, above its list. */
function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="px-2.5 pt-5 pb-1.5 font-medium text-fg-muted text-xs uppercase tracking-[0.06em]"
    >
      {children}
    </h2>
  );
}

interface LinkItem {
  id: string;
  to: string;
  label: string;
  note?: string;
}

/** The rows of a list of links, one per item. */
function LinkRows({
  items,
  labelledBy,
  onNavigate,
  rowClassName,
}: {
  items: LinkItem[];
  labelledBy: string;
  onNavigate?: () => void;
  rowClassName?: string;
}) {
  return (
    <ul aria-labelledby={labelledBy} className="flex flex-col gap-px">
      {items.map((item) => (
        <li key={item.id}>
          <NavRow to={item.to} note={item.note} onNavigate={onNavigate} className={rowClassName}>
            {item.label}
          </NavRow>
        </li>
      ))}
    </ul>
  );
}

/**
 * A list of sidebar links in whichever state its query is in: skeleton rows
 * while it loads, a line of text when it is empty, an error with Retry.
 * Data already shown stays when a later refresh fails.
 */
function LinkList({
  query,
  items,
  labelledBy,
  loadingLabel,
  emptyText,
  onNavigate,
  rowClassName,
}: {
  query: UseQueryResult<unknown, ApiError>;
  items: LinkItem[];
  labelledBy: string;
  loadingLabel: string;
  emptyText: string;
  onNavigate?: () => void;
  rowClassName?: string;
}) {
  const { t } = useTranslation();
  if (query.data !== undefined) {
    if (items.length === 0) {
      return <p className="px-2.5 py-1.5 text-fg-muted text-sm">{emptyText}</p>;
    }
    return (
      <LinkRows
        items={items}
        labelledBy={labelledBy}
        onNavigate={onNavigate}
        rowClassName={rowClassName}
      />
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        compact
        message={errorMessage(query.error, t)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return (
    <LoadingRegion label={loadingLabel}>
      <div className="flex flex-col gap-3 px-2.5 py-2">
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </LoadingRegion>
  );
}

/** The default project leads; the rest keep the server's order (oldest first). */
function defaultFirst(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => Number(b.is_default) - Number(a.is_default));
}

/**
 * What a project shared with the person says under its name: whose it is and
 * what they may do in it. Their own projects, and every project in team mode,
 * say nothing.
 */
function sharedNote(project: Project, t: TFunction): string | undefined {
  if (project.role !== 'editor' && project.role !== 'viewer') return undefined;
  return t('web.sidebar.sharedBy', {
    owner: project.owner?.name ?? t('web.project.someone'),
    role: project.role === 'editor' ? t('web.role.editor') : t('web.role.viewer'),
  });
}

function projectLinks(projects: Project[], t: TFunction): LinkItem[] {
  return projects.map((project) => ({
    id: project.id,
    to: `/projects/${project.id}`,
    label: project.name,
    note: sharedNote(project, t),
  }));
}

function ProjectsSection({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const projects = useProjects(false);
  const headingId = useId();
  const sharedHeadingId = useId();
  const archivedId = useId();
  const archivedButtonId = useId();
  // The archived list loads only once someone asks for it.
  const [archivedOpen, setArchivedOpen] = useState(false);
  // In team mode every project is the person's own, so nothing is shared.
  const { own, shared } = splitProjects(projects.data?.items ?? []);

  return (
    <div>
      <SectionHeading id={headingId}>{t('web.sidebar.projects')}</SectionHeading>
      <LinkList
        query={projects}
        items={projectLinks(defaultFirst(own), t)}
        labelledBy={headingId}
        loadingLabel={t('web.sidebar.loadingProjects')}
        emptyText={t('web.sidebar.noProjects')}
        onNavigate={onNavigate}
      />
      {/* Shown only once there is something shared; the Projects list above already loads and fails for both. */}
      {shared.length > 0 ? (
        <>
          <SectionHeading id={sharedHeadingId}>{t('web.sidebar.shared')}</SectionHeading>
          <LinkRows
            items={projectLinks(shared, t)}
            labelledBy={sharedHeadingId}
            onNavigate={onNavigate}
          />
        </>
      ) : null}
      <button
        id={archivedButtonId}
        type="button"
        aria-expanded={archivedOpen}
        aria-controls={archivedId}
        onClick={() => setArchivedOpen((open) => !open)}
        className={cn(ROW, 'mt-1 h-7 gap-1.5 text-fg-muted text-sm hover:text-fg')}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'transition-transform duration-(--duration-fast)',
            archivedOpen && 'rotate-90',
          )}
        />
        {t('web.sidebar.archived')}
      </button>
      <div id={archivedId} hidden={!archivedOpen}>
        {archivedOpen ? (
          <ArchivedProjects buttonId={archivedButtonId} onNavigate={onNavigate} />
        ) : null}
      </div>
    </div>
  );
}

/** The archived list, labelled by the disclosure button that shows it. */
function ArchivedProjects({ buttonId, onNavigate }: { buttonId: string; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const projects = useProjects(true);
  return (
    <LinkList
      query={projects}
      items={projectLinks(defaultFirst(projects.data?.items ?? []), t)}
      labelledBy={buttonId}
      loadingLabel={t('web.sidebar.loadingArchived')}
      emptyText={t('web.sidebar.noArchived')}
      onNavigate={onNavigate}
      rowClassName="text-fg-muted"
    />
  );
}

function RecentSection({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const recent = useRecent();
  const headingId = useId();
  const items = (recent.data?.items ?? []).map((artifact) => ({
    id: artifact.id,
    to: `/a/${artifact.id}`,
    label: artifact.name,
  }));
  return (
    <div>
      <SectionHeading id={headingId}>{t('web.sidebar.recent')}</SectionHeading>
      <LinkList
        query={recent}
        items={items}
        labelledBy={headingId}
        loadingLabel={t('web.sidebar.loadingRecent')}
        emptyText={t('web.sidebar.noRecent')}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/**
 * The app's navigation. `full` is the wide-screen column, `rail` its icon-only
 * form, and `drawer` the full column inside the drawer's Radix Dialog, whose
 * close button it renders. `onNavigate` runs when a link is followed, so the
 * drawer can close.
 */
export function Sidebar({
  variant,
  onNavigate,
}: {
  variant: 'full' | 'rail' | 'drawer';
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { toggle } = useSidebarMode();
  const { openSearch, openNewProject } = useShellActions();

  // Collapsing swaps the toggle for its twin in the other form. A keyboard or
  // screen reader user, whose click has no pointer position, keeps focus on it:
  // the twin takes focus as it mounts.
  const refocusToggle = useRef(false);
  const toggleButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button || !refocusToggle.current) return;
    refocusToggle.current = false;
    button.focus();
  }, []);
  const onToggle = (event: MouseEvent) => {
    refocusToggle.current = event.detail === 0;
    toggle();
  };

  const label = t('web.sidebar.navLabel');

  if (variant === 'rail') {
    return (
      <nav aria-label={label} className="flex h-full flex-col items-center gap-1 pb-3">
        <div className="flex h-(--topbar-height) shrink-0 items-center">
          <IconButton
            ref={toggleButton}
            label={t('web.sidebar.open')}
            icon={<PanelLeftOpen />}
            tooltipSide="right"
            className={RAIL_ITEM}
            onClick={onToggle}
          />
        </div>
        <IconButton
          label={t('web.sidebar.newProject')}
          icon={<Plus />}
          tooltipSide="right"
          className={RAIL_ITEM}
          onClick={openNewProject}
        />
        <IconButton
          label={t('web.sidebar.search')}
          icon={<Search />}
          shortcut={SEARCH_SHORTCUT}
          tooltipSide="right"
          className={RAIL_ITEM}
          onClick={openSearch}
        />
        <Tooltip content={t('web.sidebar.allArtifacts')} side="right">
          <NavLink
            to="/"
            end
            aria-label={t('web.sidebar.allArtifacts')}
            className={cn(
              'inline-grid size-9 place-items-center rounded-full transition-colors [&_svg]:size-4.5',
              RAIL_ITEM,
              'aria-[current=page]:bg-selected aria-[current=page]:text-fg aria-[current=page]:hover:bg-selected',
            )}
          >
            <LayoutGrid aria-hidden="true" />
          </NavLink>
        </Tooltip>
        <div className="mt-auto">
          <AccountMenu compact />
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label={label} className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--topbar-height) shrink-0 items-center justify-between gap-2 pr-2 pl-2.5">
        <Link to="/" onClick={onNavigate} className="rounded-md px-1.5 py-1 outline-offset-0">
          <Logo size="sm" />
        </Link>
        {variant === 'drawer' ? (
          <RadixDialog.Close asChild>
            <IconButton
              label={t('web.sidebar.closeMenu')}
              icon={<PanelLeftClose />}
              tooltip={false}
              className={RAIL_ITEM}
            />
          </RadixDialog.Close>
        ) : (
          <IconButton
            ref={toggleButton}
            label={t('web.sidebar.close')}
            icon={<PanelLeftClose />}
            tooltipSide="right"
            className={RAIL_ITEM}
            onClick={onToggle}
          />
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-px px-2">
        <Button
          variant="secondary"
          leadingIcon={<Plus />}
          className="mb-2 w-full justify-start px-3"
          onClick={openNewProject}
        >
          {t('web.sidebar.newProject')}
        </Button>
        <button
          type="button"
          aria-keyshortcuts={ariaKeyShortcuts(SEARCH_SHORTCUT)}
          className={ROW}
          onClick={openSearch}
        >
          <Search aria-hidden="true" className="text-fg-muted" />
          <span className="min-w-0 flex-1 truncate">{t('web.sidebar.search')}</span>
          <span aria-hidden="true" className="pointer-coarse:hidden">
            <Kbd keys={SEARCH_SHORTCUT} />
          </span>
        </button>
        <NavRow to="/" end icon={<LayoutGrid />} onNavigate={onNavigate}>
          {t('web.sidebar.allArtifacts')}
        </NavRow>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        <ProjectsSection onNavigate={onNavigate} />
        <RecentSection onNavigate={onNavigate} />
      </div>

      <div className="shrink-0 border-border border-t p-2">
        <AccountMenu compact={false} />
      </div>
    </nav>
  );
}
