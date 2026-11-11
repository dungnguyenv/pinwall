import { Monitor, RulerDimensionLine, Smartphone, Tablet } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  Field,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToggleGroup,
} from '../../ui/index.ts';
import { CUSTOM_WIDTH, clampCustomWidth, DEVICE_WIDTH, type Device } from '../frame/device.ts';
import { keysOf } from './shortcuts.ts';

/**
 * The screen size the page is shown at: Desktop fills the stage, Tablet and
 * Phone are their widths, and Custom width takes any width in range. After
 * them, the custom width while it is in use, and the scale when the frame is
 * drawn smaller to fit.
 */
export function DevicePicker({
  device,
  customWidth,
  scale,
  onDevice,
  onCustomWidth,
}: {
  device: Device;
  customWidth: number;
  scale: number;
  onDevice(d: Device): void;
  onCustomWidth(width: number): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const statusId = useId();
  const width = (n: number) => t('web.review.device.width', { width: n });
  const percent = Math.round(scale * 100);
  const custom = device === 'custom';

  return (
    <div className="flex shrink-0 items-center gap-1">
      <ToggleGroup
        label={t('web.review.device.label')}
        value={device}
        onValueChange={onDevice}
        items={[
          {
            value: 'desktop',
            label: t('web.review.device.desktop'),
            icon: <Monitor />,
            shortcut: keysOf('desktop'),
          },
          {
            value: 'tablet',
            label: t('web.review.device.tablet'),
            icon: <Tablet />,
            detail: width(DEVICE_WIDTH.tablet),
            shortcut: keysOf('tablet'),
          },
          {
            value: 'phone',
            label: t('web.review.device.phone'),
            icon: <Smartphone />,
            detail: width(DEVICE_WIDTH.phone),
            shortcut: keysOf('phone'),
          },
        ]}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <IconButton
            label={t('web.review.customWidth')}
            icon={<RulerDimensionLine />}
            size="sm"
            aria-describedby={custom ? statusId : undefined}
            className={cn(
              'text-fg-muted hover:text-fg',
              custom && 'bg-selected text-fg hover:bg-selected',
            )}
          />
        </PopoverTrigger>
        <PopoverContent align="end">
          <CustomWidthForm
            width={customWidth}
            onApply={(n) => {
              onCustomWidth(n);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {custom || percent < 100 ? (
        <span
          id={statusId}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap pr-1 text-fg-muted text-xs tabular-nums"
        >
          {/* Narrow bars keep the scale only; the width is in the popover and the description. */}
          {custom ? <span className="max-lg:sr-only">{width(customWidth)}</span> : null}
          {percent < 100 ? (
            <span
              title={t('web.review.scaleTitle', { percent })}
              className="rounded-sm bg-surface-muted px-1 py-0.5 font-medium"
            >
              {t('web.review.scale', { percent })}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** The custom width field. Enter or Apply uses it, clamped to the range. */
function CustomWidthForm({ width, onApply }: { width: number; onApply(width: number): void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(String(width));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const n = Number.parseInt(text, 10);
    onApply(clampCustomWidth(Number.isNaN(n) ? width : n));
  };
  return (
    // Out of range is clamped, not refused.
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <Field
        label={t('web.review.customWidthField')}
        description={t('web.review.customWidthHint', {
          min: CUSTOM_WIDTH.min,
          max: CUSTOM_WIDTH.max,
        })}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={CUSTOM_WIDTH.min}
            max={CUSTOM_WIDTH.max}
            step={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="tabular-nums"
          />
        )}
      </Field>
      <Button type="submit" size="sm" className="self-end">
        {t('web.review.apply')}
      </Button>
    </form>
  );
}
