import { type JSX, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, cn } from '../ui/index.ts';

/** The two settings, each with the values it takes and the sentence that says what each does. */
const SETTINGS = [
  {
    env: 'PINWALL_VISIBILITY',
    values: [
      { value: 'team', text: 'web.config.visibility.team' },
      { value: 'personal', text: 'web.config.visibility.personal' },
    ],
  },
  {
    env: 'PINWALL_SHARE_LINKS',
    values: [
      { value: 'members', text: 'web.config.shareLinks.members' },
      { value: 'approved', text: 'web.config.shareLinks.approved' },
    ],
  },
] as const;

/**
 * Who sees which projects and who may share outside Pinwall, in plain words: the two values of
 * each setting side by side, with the one in force marked Current. `visibility` and `shareLinks`
 * are the settings' values from the configuration, `null` when the server does not send them; no
 * value is marked then.
 */
export function SpacesExplainer({
  visibility,
  shareLinks,
}: {
  visibility: string | null;
  shareLinks: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  const headingId = useId();
  const current: Record<(typeof SETTINGS)[number]['env'], string | null> = {
    PINWALL_VISIBILITY: visibility,
    PINWALL_SHARE_LINKS: shareLinks,
  };
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="font-semibold text-fg text-lg">
        {t('web.config.spaces.title')}
      </h2>
      <div className="mt-3 flex flex-col gap-5">
        {SETTINGS.map((setting) => (
          <div key={setting.env}>
            <h3 className="mb-2">
              <code className="font-medium font-mono text-fg-muted text-sm">{setting.env}</code>
            </h3>
            <ul className="grid gap-3 sm:grid-cols-2">
              {setting.values.map((option) => {
                const isCurrent = option.value === current[setting.env];
                return (
                  <li
                    key={option.value}
                    className={cn(
                      'flex items-start justify-between gap-3 rounded-lg border bg-surface p-4 text-base',
                      isCurrent ? 'border-accent' : 'border-border',
                    )}
                  >
                    <p className="min-w-0 text-pretty text-fg-muted">{t(option.text)}</p>
                    {isCurrent ? (
                      <span className="shrink-0">
                        <Badge tone="accent">{t('web.isolation.current')}</Badge>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
