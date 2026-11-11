import { useTranslation } from 'react-i18next';
import { PageHeader } from '../app/shell/page-header.tsx';

/** Stands in for the library pages inside the shell until they exist. */
export function PlaceholderPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-(--content-library) px-4 md:px-8">
      <PageHeader title={t('app.name')} />
    </div>
  );
}
