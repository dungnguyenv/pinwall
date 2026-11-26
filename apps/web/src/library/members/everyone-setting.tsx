import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import type { Project } from '../../api/dto.ts';
import { useUpdateProject } from '../../api/library.ts';
import { useMe, usePublicConfig } from '../../api/session.ts';
import { mayExpose } from '../../api/spaces.ts';
import { Switch, toast } from '../../ui/index.ts';

/**
 * The owner's switch that lets everyone who signs in view the project, where this Pinwall allows
 * it (`everyone_projects`). A default project cannot be, and an owner who may not make share
 * links cannot turn it on, though they can always turn it off. Nothing for anyone else, nor where
 * the Pinwall does not allow it.
 */
export function EveryoneSetting({ project }: { project: Project }) {
  const { t } = useTranslation();
  const allowed = usePublicConfig().data?.everyone_projects === true;
  const me = useMe().data;
  const update = useUpdateProject(project.id);
  if (!allowed || project.role !== 'owner') return null;

  const chosen = update.isPending
    ? update.variables.visible_to_everyone === true
    : project.visible_to_everyone === true;
  const approved = me == null || mayExpose(me);
  const note = project.is_default
    ? t('web.members.everyone.default')
    : !approved
      ? chosen
        ? t('web.members.everyone.paused')
        : t('web.members.everyone.notApproved')
      : null;

  return (
    <Switch
      label={t('web.members.everyone.label')}
      description={
        <>
          <span className="block">{t('web.members.everyone.hint')}</span>
          {note ? <span className="mt-1 block">{note}</span> : null}
        </>
      }
      checked={chosen && !project.is_default}
      disabled={update.isPending || project.is_default || (!approved && !chosen)}
      onCheckedChange={(on) =>
        update.mutate(
          { visible_to_everyone: on },
          { onError: (error) => toast.error(errorMessage(error, t)) },
        )
      }
    />
  );
}
