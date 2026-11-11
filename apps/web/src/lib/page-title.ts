import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Sets the tab title to "<title> · Pinwall", or "Pinwall" when `title` is
 * null (still loading, say). Leaving the page puts back "Pinwall", so a page
 * without a title never shows the previous one's.
 */
export function usePageTitle(title: string | null): void {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = title ? t('web.common.pageTitle', { title }) : t('app.name');
    return () => {
      document.title = t('app.name');
    };
  }, [title, t]);
}
