import { Lock, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AdminPerson, AdminShareLink } from '../../api/dto.ts';
import { formatDate, formatRelativeTime } from '../../lib/format.ts';
import { Badge } from '../../ui/index.ts';

/*
 * The pieces of a share link that the list (a table and cards) and the look-up share, so both
 * name people, dates and options the same way. Every name here is text from another person, so
 * it renders as React text, never as markup.
 */

/** What to call a person: their name, else their email, else `unnamed`. */
export function personName(person: AdminPerson, unnamed: string): string {
  return person.name || person.email || unnamed;
}

/** A person's name with their email under it, or a quiet "No account" when nobody holds the role. */
export function PersonText({ person }: { person: AdminPerson | null }) {
  const { t } = useTranslation();
  if (person === null) return <span className="text-fg-muted">{t('web.admin.person.none')}</span>;
  // The name falls back to the email, so the email is printed once when it is all there is.
  const email = person.email && person.email !== person.name ? person.email : null;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="font-medium text-fg [overflow-wrap:anywhere]">
        {person.name || t('web.admin.person.unnamed')}
      </span>
      {email ? (
        <span className="text-fg-muted text-sm [overflow-wrap:anywhere]">{email}</span>
      ) : null}
    </span>
  );
}

/** Whether a link was made by someone other than whose space it is in. */
export function madeByOther(link: Pick<AdminShareLink, 'owner' | 'created_by'>): boolean {
  return (link.created_by?.id ?? null) !== (link.owner?.id ?? null);
}

/** "Made by Carol", or that the maker's account is gone; only for a link its owner did not make. */
export function MadeByLine({ link }: { link: Pick<AdminShareLink, 'owner' | 'created_by'> }) {
  const { t } = useTranslation();
  if (!madeByOther(link)) return null;
  return (
    <span className="text-fg-muted text-sm [overflow-wrap:anywhere]">
      {link.created_by === null
        ? t('web.admin.links.madeByGone')
        : t('web.admin.links.madeBy', {
            name: personName(link.created_by, t('web.admin.person.unnamed')),
          })}
    </span>
  );
}

/** A moment as time from now, with the date on hover; "Never" when there is none. */
export function When({ at }: { at: number | null }) {
  const { t } = useTranslation();
  if (at === null) return <span className="text-fg-muted">{t('web.admin.links.never')}</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDate(at)}>
      {formatRelativeTime(at)}
    </time>
  );
}

/** A day on the calendar, for when a link was made. */
export function Day({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{formatDate(at)}</time>;
}

/** What a link shows: the latest version, or one fixed version. */
export function ShowsText({ version }: { version: AdminShareLink['version'] }) {
  const { t } = useTranslation();
  return version === null
    ? t('web.share.scopeLatestShort')
    : t('web.share.scopeVersionShort', { number: version.number });
}

/** The two options that change what a link allows: a password, and comments. */
export function LinkBadges({
  link,
}: {
  link: Pick<AdminShareLink, 'has_password' | 'allow_comments'>;
}) {
  const { t } = useTranslation();
  if (!link.has_password && !link.allow_comments) {
    return <span className="text-fg-muted">{t('web.admin.links.noOptions')}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {link.has_password ? <Badge icon={<Lock />}>{t('web.admin.links.password')}</Badge> : null}
      {link.allow_comments ? (
        <Badge icon={<MessageSquare />}>{t('web.admin.links.comments')}</Badge>
      ) : null}
    </span>
  );
}
