import { Flag } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicConfig } from '../api/dto.ts';
import { Button } from '../ui/index.ts';

/*
 * The abuse contact and the links to the terms and the privacy notice come from
 * the server's configuration, which the people who run a Pinwall write. They
 * become an `href` only as `mailto:`, `http:` or `https:`, checked here as well
 * as on the server. Anything else shows as plain text, or not at all.
 */

/** No whitespace or control character, which a URL or an address has no use for. */
const PLAIN = /^[^\s\p{Cc}]+$/u;
/**
 * What the part of an address before the `@` never holds: whitespace, a control character, or
 * one of RFC 5322's specials, which only a quoted address may hold. Anything else the server
 * takes is a link: `mailtoHref` encodes what a URL would read as more than the address.
 */
const NOT_IN_LOCAL = '\\s\\p{Cc}@()<>\\[\\]:;,\\\\"';
/** What a domain never holds: it would end the address, or turn it into more than one. */
const NOT_IN_DOMAIN = '\\s\\p{Cc}@:/?#<>"\'\\\\%';
const EMAIL = new RegExp(
  `^[^${NOT_IN_LOCAL}]+@[^${NOT_IN_DOMAIN}.]+(?:\\.[^${NOT_IN_DOMAIN}.]+)+$`,
  'u',
);
/** What RFC 6068 has a `mailto:` URL percent-encode in an address (beyond what a browser does). */
const MAILTO_ENCODED = /[%/?#[\]&;=^`{|}]/g;

/** `mailto:` and the address, each character the URL would read otherwise percent-encoded. */
function mailtoHref(address: string): string {
  const encoded = address.replace(
    MAILTO_ENCODED,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
  return `mailto:${encoded}`;
}

/** The URL when it is http(s), else null. */
export function safeHttpUrl(url: string | undefined): string | null {
  if (url === undefined || !PLAIN.test(url)) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** A `mailto:` URL for an email address, the URL for an http(s) URL, null for anything else. */
export function abuseHref(contact: string): string | null {
  if (EMAIL.test(contact)) return mailtoHref(contact);
  return safeHttpUrl(contact);
}

/** A link in the footer's line, underlined so it reads as one inside a sentence. */
const LINK_CLASS = 'rounded-sm underline underline-offset-2 hover:text-fg [overflow-wrap:anywhere]';

/**
 * How a link to `href` opens: a page elsewhere in a new tab, so a sign-in, a review or a shared
 * page is not left behind; an address in the mail app, with no tab, which would stay blank.
 */
function opening(href: string): { target?: '_blank'; rel?: string } {
  return href.startsWith('mailto:') ? {} : { target: '_blank', rel: 'noopener noreferrer' };
}

/** A link in the footer's line, to a page elsewhere or to an address. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={LINK_CLASS} {...opening(href)}>
      {children}
    </a>
  );
}

/**
 * What the people who run this Pinwall say about it: the terms of use, the
 * privacy notice (both only with `terms`) and "Report abuse: <contact>", each
 * only when set. Nothing at all when none is. A contact that is neither an
 * email address nor an http(s) URL shows as text.
 */
export function PolicyLinks({ config, terms = false }: { config: PublicConfig; terms?: boolean }) {
  const { t } = useTranslation();
  const termsUrl = terms ? safeHttpUrl(config.terms_url) : null;
  const privacyUrl = terms ? safeHttpUrl(config.privacy_url) : null;
  const contact = config.abuse_contact?.trim() || null;
  if (termsUrl === null && privacyUrl === null && contact === null) return null;

  const contactHref = contact === null ? null : abuseHref(contact);
  return (
    <nav
      aria-label={t('web.policy.nav')}
      className="flex flex-col items-center gap-1.5 text-center text-fg-muted text-sm"
    >
      {termsUrl !== null || privacyUrl !== null ? (
        <p className="flex flex-wrap justify-center gap-x-5 gap-y-1">
          {termsUrl === null ? null : (
            <ExternalLink href={termsUrl}>{t('web.policy.terms')}</ExternalLink>
          )}
          {privacyUrl === null ? null : (
            <ExternalLink href={privacyUrl}>{t('web.policy.privacy')}</ExternalLink>
          )}
        </p>
      ) : null}
      {contact === null ? null : (
        <p className="text-pretty">
          {t('pages.reportAbuse')}{' '}
          {contactHref === null ? (
            <span className="[overflow-wrap:anywhere]">{contact}</span>
          ) : (
            <ExternalLink href={contactHref}>{contact}</ExternalLink>
          )}
        </p>
      )}
    </nav>
  );
}

/**
 * The share bar's flag link: "Report abuse", to the contact the people who
 * run this Pinwall gave. Nothing without a contact that is an email address or
 * an http(s) URL. On a phone only the flag shows.
 */
export function ReportAbuseLink({ config }: { config: PublicConfig }) {
  const { t } = useTranslation();
  const href = abuseHref(config.abuse_contact?.trim() ?? '');
  if (href === null) return null;
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      leadingIcon={<Flag />}
      className="px-2.5 text-fg-muted hover:text-fg"
    >
      <a href={href} {...opening(href)}>
        <span className="max-md:sr-only">{t('web.policy.reportAbuse')}</span>
      </a>
    </Button>
  );
}
