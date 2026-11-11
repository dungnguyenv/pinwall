import { CircleAlert } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import { CreateProjectRequest } from '../../api/dto.ts';
import { useCreateProject } from '../../api/library.ts';
import { Button, Dialog, Field, Input, Textarea } from '../../ui/index.ts';

const MAX_NAME = 100;
const MAX_INSTRUCTIONS = 20_000;

/**
 * Creates a project from a name and optional instructions for agents, then
 * opens it. Each opening starts blank; a refusal from the server is shown as
 * the server worded it and the dialog stays open.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateProject();
  const formId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // After creating, the project page focuses its own heading.
  const leaving = useRef(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('');
      setInstructions('');
      setNameError(null);
      setFormError(null);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const parsed = CreateProjectRequest.safeParse({ name, instructions });
    if (!parsed.success) {
      setNameError(t('web.newProject.nameRequired'));
      nameInput.current?.focus();
      return;
    }
    setFormError(null);
    create.mutate(parsed.data, {
      onSuccess: (project) => {
        leaving.current = true;
        onOpenChange(false);
        void navigate(`/projects/${project.id}`);
      },
      onError: (error) => setFormError(errorMessage(error, t)),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('web.newProject.title')}
      description={t('web.newProject.description')}
      onCloseAutoFocus={(event) => {
        if (leaving.current) event.preventDefault();
        leaving.current = false;
      }}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('web.common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            {t('web.newProject.create')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-5">
        <Field label={t('web.newProject.name')} error={nameError}>
          {(control) => (
            <Input
              {...control}
              ref={nameInput}
              value={name}
              maxLength={MAX_NAME}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          )}
        </Field>
        <Field
          label={t('web.newProject.instructions')}
          description={t('web.newProject.instructionsHint')}
          optional
        >
          {(control) => (
            <Textarea
              {...control}
              autosize
              rows={4}
              value={instructions}
              maxLength={MAX_INSTRUCTIONS}
              onChange={(event) => setInstructions(event.target.value)}
            />
          )}
        </Field>
        {formError ? (
          <p role="alert" className="flex items-start gap-1.5 text-danger text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{formError}</span>
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
