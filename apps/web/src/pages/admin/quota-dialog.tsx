import { CircleAlert } from 'lucide-react';
import { type FormEvent, type Ref, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BYTE_UNITS,
  fromQuota,
  type QuotaChoice,
  toQuota,
  useUpdateAdminUser,
} from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminUser } from '../../api/dto.ts';
import { Button, Dialog, Input, Select } from '../../ui/index.ts';
import { FormAlert } from '../auth/auth-layout.tsx';

type Kind = QuotaChoice['kind'];
type Unit = keyof typeof BYTE_UNITS;

const KINDS: Kind[] = ['instance', 'none', 'custom'];
const UNITS = Object.keys(BYTE_UNITS) as Unit[];

/** What one limit's controls hold: the kind chosen and, for a custom limit, the text typed. */
interface Limit {
  kind: Kind;
  text: string;
}

interface Form {
  storage: Limit & { unit: Unit };
  artifacts: Limit;
}

/** The kind of a limit, from text a Select handed back; unknown text keeps `fallback`. */
function kindOf(value: string, fallback: Kind): Kind {
  return KINDS.find((kind) => kind === value) ?? fallback;
}

function unitOf(value: string, fallback: Unit): Unit {
  return UNITS.find((unit) => unit === value) ?? fallback;
}

/** A stored count of artifacts as the controls show it. */
function artifactsLimit(stored: number | null | undefined): Limit {
  const choice = fromQuota(stored);
  return { kind: choice.kind, text: choice.kind === 'custom' ? String(choice.value) : '' };
}

/** A stored byte count in the largest unit that holds it whole: GB if it is a whole number of them, else MB. */
function storageLimit(stored: number | null | undefined): Form['storage'] {
  const choice = fromQuota(stored);
  if (choice.kind !== 'custom') return { kind: choice.kind, text: '', unit: 'GB' };
  const unit: Unit = choice.value % BYTE_UNITS.GB === 0 ? 'GB' : 'MB';
  return { kind: 'custom', text: String(choice.value / BYTE_UNITS[unit]), unit };
}

function initialForm(user: AdminUser): Form {
  return {
    storage: storageLimit(user.quota_bytes),
    artifacts: artifactsLimit(user.quota_artifacts),
  };
}

/** The whole number of at least 1 that `text` says, else `null`. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** What `limit` asks for, times `factor`; `null` when a custom amount is not a whole number of at least 1. */
function choiceOf(limit: Limit, factor = 1): QuotaChoice | null {
  if (limit.kind !== 'custom') return { kind: limit.kind };
  const n = wholeNumber(limit.text);
  const value = n === null ? null : n * factor;
  return value !== null && Number.isSafeInteger(value) ? { kind: 'custom', value } : null;
}

/**
 * What the storage controls ask for. A stored size that is not a whole number of megabytes
 * (the API takes any number of bytes) reads as a fraction; left alone, it is sent back as it is
 * rather than refused or rounded.
 */
function storageChoice(form: Form['storage'], user: AdminUser): QuotaChoice | null {
  const stored = storageLimit(user.quota_bytes);
  const untouched =
    form.kind === 'custom' &&
    stored.kind === 'custom' &&
    form.text === stored.text &&
    form.unit === stored.unit;
  return untouched ? fromQuota(user.quota_bytes) : choiceOf(form, BYTE_UNITS[form.unit]);
}

/**
 * Edits the limits an admin sets on one person: each of storage and artifacts is the instance's
 * limit, no limit, or a custom number. Save sends both, so what the dialog shows is what the
 * person gets. The controls start from the saved limits each time the dialog opens.
 */
export function QuotaDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const update = useUpdateAdminUser();
  const formId = useId();
  const storageInput = useRef<HTMLInputElement>(null);
  const artifactsInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState(() => initialForm(user));
  const [invalid, setInvalid] = useState({ storage: false, artifacts: false });
  const [failure, setFailure] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  // Starting over when the dialog opens, in the same render, so no stale frame shows.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(initialForm(user));
      setInvalid({ storage: false, artifacts: false });
      setFailure(null);
    }
  }

  const kindOptions = KINDS.map((kind) => ({
    value: kind,
    label: t(kind === 'custom' ? 'web.admin.quota.customOption' : `web.admin.quota.${kind}`),
  }));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (update.isPending) return;
    const storage = storageChoice(form.storage, user);
    const artifacts = choiceOf(form.artifacts);
    setInvalid({ storage: storage === null, artifacts: artifacts === null });
    if (storage === null || artifacts === null) {
      (storage === null ? storageInput : artifactsInput).current?.focus();
      return;
    }
    setFailure(null);
    update.mutate(
      {
        id: user.id,
        patch: { quota_bytes: toQuota(storage), quota_artifacts: toQuota(artifacts) },
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => setFailure(errorMessage(error, t)),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('web.admin.quota.title', { name: user.name })}
      description={
        user.effective_role === 'admin'
          ? t('web.admin.quota.adminExempt', { name: user.name })
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('web.common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={update.isPending}>
            {t('web.common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-5">
        <LimitControls
          label={t('web.usage.storage')}
          amountLabel={t('web.admin.quota.storageAmount')}
          kindOptions={kindOptions}
          limit={form.storage}
          invalid={invalid.storage}
          inputRef={storageInput}
          onChange={(next) => {
            setForm((current) => ({ ...current, storage: { ...current.storage, ...next } }));
            setInvalid((current) => ({ ...current, storage: false }));
          }}
          unit={{
            label: t('web.admin.quota.unit'),
            value: form.storage.unit,
            onChange: (unit) =>
              setForm((current) => ({
                ...current,
                storage: { ...current.storage, unit: unitOf(unit, current.storage.unit) },
              })),
          }}
        />
        <LimitControls
          label={t('web.usage.artifacts')}
          amountLabel={t('web.admin.quota.artifactsAmount')}
          kindOptions={kindOptions}
          limit={form.artifacts}
          invalid={invalid.artifacts}
          inputRef={artifactsInput}
          onChange={(next) => {
            setForm((current) => ({ ...current, artifacts: { ...current.artifacts, ...next } }));
            setInvalid((current) => ({ ...current, artifacts: false }));
          }}
        />
        {failure ? <FormAlert>{failure}</FormAlert> : null}
      </form>
    </Dialog>
  );
}

/** One limit: what kind it is, and for a custom one the amount (with a unit, for storage). */
function LimitControls({
  label,
  amountLabel,
  kindOptions,
  limit,
  invalid,
  inputRef,
  onChange,
  unit,
}: {
  label: string;
  amountLabel: string;
  kindOptions: { value: Kind; label: string }[];
  limit: Limit;
  invalid: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChange(next: Partial<Limit>): void;
  unit?: { label: string; value: Unit; onChange(unit: string): void };
}) {
  const { t } = useTranslation();
  const errorId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44 max-sm:w-full">
          <Select
            label={label}
            value={limit.kind}
            options={kindOptions}
            onValueChange={(value) => onChange({ kind: kindOf(value, limit.kind) })}
          />
        </div>
        {limit.kind === 'custom' ? (
          <>
            <Input
              ref={inputRef}
              aria-label={amountLabel}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? errorId : undefined}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={limit.text}
              onChange={(event) => onChange({ text: event.target.value })}
              className="min-w-24 flex-1"
            />
            {unit ? (
              <div className="w-24 shrink-0">
                <Select
                  label={unit.label}
                  hideLabel
                  value={unit.value}
                  options={UNITS.map((value) => ({ value, label: value }))}
                  onValueChange={unit.onChange}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {invalid ? (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-danger text-sm">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('web.admin.quota.wholeNumber')}</span>
        </p>
      ) : null}
    </div>
  );
}
