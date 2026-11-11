import { useTranslation } from 'react-i18next';
import { useMe } from '../../api/session.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { PasskeysCard } from './passkeys-card.tsx';
import { PasswordCard } from './password-card.tsx';

/** `/settings/security`, for the owner account: how it signs in. */
export function SecurityPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.settings.security'));
  const { data: me } = useMe();
  if (!me?.credentials) return null;
  return (
    <>
      <PasswordCard hasPassword={me.credentials.password} passkeyCount={me.credentials.passkeys} />
      <PasskeysCard />
    </>
  );
}
