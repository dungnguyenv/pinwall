import { LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../api/session.ts';
import { usePref } from '../lib/storage.ts';
import { ToggleGroup } from '../ui/index.ts';

export type LibraryView = 'grid' | 'list';

const VIEWS: readonly LibraryView[] = ['grid', 'list'];

/** Each person who signs in on this browser keeps their own choice. */
export function libraryViewPrefKey(userId: string): string {
  return `pinwall:library-view:${userId}`;
}

/** Grid or list for every library page, remembered per person; grid until they choose. */
export function useLibraryView(): [LibraryView, (v: LibraryView) => void] {
  const { data: me } = useMe();
  return usePref(me ? libraryViewPrefKey(me.id) : null, VIEWS, 'grid');
}

export function ViewToggle({
  value,
  onChange,
}: {
  value: LibraryView;
  onChange(v: LibraryView): void;
}) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      label={t('web.library.view')}
      value={value}
      onValueChange={onChange}
      items={[
        { value: 'grid', label: t('web.library.grid'), icon: <LayoutGrid /> },
        { value: 'list', label: t('web.library.list'), icon: <List /> },
      ]}
    />
  );
}
