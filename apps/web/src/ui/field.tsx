import { CircleAlert } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';

/** Props a Field hands to its control so label, hint and error are wired up. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/**
 * A labelled form control with an optional hint and error. The control comes
 * from a render function so any input can take the ids:
 * `<Field label="Name">{(control) => <Input {...control} />}</Field>`.
 */
export function Field({
  label,
  description,
  error,
  optional = false,
  children,
}: {
  label: string;
  description?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-baseline gap-1.5 font-medium text-fg text-sm">
        {label}
        {optional ? (
          <span className="font-normal text-fg-muted">{t('web.common.optional')}</span>
        ) : null}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {description ? (
        <div id={descriptionId} className="text-fg-muted text-sm">
          {description}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-danger text-sm">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
