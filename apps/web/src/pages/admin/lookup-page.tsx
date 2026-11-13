import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLookup } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminLookup } from '../../api/dto.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { Button, Field, Input } from '../../ui/index.ts';
import { LookupResult } from './lookup-result.tsx';

/**
 * `/admin/lookup`: paste an address from an abuse report and see whose it is and what it points
 * to, then act on it. The address stays in the field as text, and nothing here links to it or to
 * the content behind it.
 */
export function LookupPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.admin.lookup'));
  const lookup = useLookup();
  const [address, setAddress] = useState('');
  const [emptyTried, setEmptyTried] = useState(false);
  // The answer, and the address it is for: an action looks that same address up again.
  const [found, setFound] = useState<{ address: string; result: AdminLookup } | null>(null);

  function run(url: string) {
    lookup.mutate(url, {
      onSuccess: (result) => setFound({ address: url, result }),
      onError: () => setFound(null),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = address.trim();
    if (url === '') {
      setEmptyTried(true);
      setFound(null);
      return;
    }
    setEmptyTried(false);
    run(url);
  }

  // The server's message for a refusal, as it wrote it; an empty field gets the same guidance.
  const problem = emptyTried
    ? t('moderation.lookup.badUrl')
    : lookup.isError
      ? errorMessage(lookup.error, t)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-pretty text-base text-fg-muted">
        {t('web.admin.lookup.hint')}
      </p>

      <form onSubmit={submit} noValidate className="flex max-w-xl flex-col gap-3">
        <Field label={t('web.admin.lookup.field')} error={problem}>
          {(control) => (
            <Input
              {...control}
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setEmptyTried(false);
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </Field>
        <div>
          <Button type="submit" loading={lookup.isPending}>
            {t('web.admin.lookup.submit')}
          </Button>
        </div>
      </form>

      {found ? <LookupResult result={found.result} onChanged={() => run(found.address)} /> : null}
    </div>
  );
}
