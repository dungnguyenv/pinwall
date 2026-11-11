import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '../app/shell/page-header.tsx';
import { usePageTitle } from '../lib/page-title.ts';
import { Button } from '../ui/index.ts';
import { LibraryPage } from './library-page.tsx';

/** Any address inside the app that names no page. */
export function NotFoundPage() {
  const { t } = useTranslation();
  const title = t('web.notFound.title');
  usePageTitle(title);
  return (
    <LibraryPage>
      <PageHeader title={title} description={t('web.notFound.body')}>
        <div>
          <Button asChild variant="secondary">
            <Link to="/">{t('web.library.goToAll')}</Link>
          </Button>
        </div>
      </PageHeader>
    </LibraryPage>
  );
}
