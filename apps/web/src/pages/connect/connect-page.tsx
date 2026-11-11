import { Download, KeyRound } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '../../app/shell/page-header.tsx';
import { usePageTitle } from '../../lib/page-title.ts';
import { Button, CopyField, Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/index.ts';
import { skillText } from './skill.ts';
import { CODEX_SIGN_IN, connectSnippets, SKILL_INSTALL } from './snippets.ts';

/** Inline code in a line of guidance: a command, a flag or a file. */
function Code({ children }: { children?: ReactNode }) {
  return (
    <code className="rounded-sm bg-surface-muted px-1 py-px font-mono text-[0.92em] text-fg">
      {children}
    </code>
  );
}

/** A line of guidance whose `<code>` parts are set as code. */
function Guide({ i18nKey }: { i18nKey: string }) {
  return (
    <p className="text-pretty text-base text-fg-muted">
      <Trans i18nKey={i18nKey} components={{ code: <Code /> }} />
    </p>
  );
}

/** A section below the agents: a heading, what it is for, then what to do. */
function Section({
  title,
  body,
  children,
}: {
  title: string;
  body: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4 border-border border-t pt-8">
      <div>
        <h2 id={titleId} className="font-semibold text-fg text-md">
          {title}
        </h2>
        <div className="mt-1">{body}</div>
      </div>
      {children}
    </section>
  );
}

/**
 * Hands the bundled SKILL.md over as a download. The object URL lives until
 * the next download or until the page closes.
 */
function useSkillDownload(text: string): () => void {
  const lastUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    },
    [],
  );
  return () => {
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    lastUrl.current = url;
    const link = document.createElement('a');
    link.href = url;
    link.download = 'SKILL.md';
    link.click();
  };
}

function SkillSection({ text }: { text: string }) {
  const { t } = useTranslation();
  const download = useSkillDownload(text);
  return (
    <Section
      title={t('web.connect.skillTitle')}
      body={<p className="text-pretty text-base text-fg-muted">{t('web.connect.skillBody')}</p>}
    >
      <div>
        <Button variant="secondary" leadingIcon={<Download />} onClick={download}>
          {t('web.connect.skillDownload')}
        </Button>
      </div>
      <CopyField label={t('web.connect.skillInstall')} value={SKILL_INSTALL} mono />
    </Section>
  );
}

/**
 * `/connect`: how to add this Pinwall to an agent. The SPA only works at the
 * public origin, so the page's own origin is the address agents need.
 */
export function ConnectPage() {
  const { t } = useTranslation();
  const title = t('web.connect.title');
  usePageTitle(title);
  const snippets = connectSnippets(window.location.origin);

  return (
    <div className="mx-auto w-full max-w-(--content-form) px-4 pb-16 md:px-8">
      <PageHeader title={title} description={t('web.connect.intro')} />

      <div className="flex flex-col gap-10">
        <Tabs defaultValue="claude-code" className="rounded-lg border border-border bg-surface">
          <TabsList aria-label={t('web.connect.agents')} className="px-4 sm:px-5">
            <TabsTrigger value="claude-code">{t('web.connect.claudeCode')}</TabsTrigger>
            <TabsTrigger value="cursor">{t('web.connect.cursor')}</TabsTrigger>
            <TabsTrigger value="codex">{t('web.connect.codex')}</TabsTrigger>
            <TabsTrigger value="other">{t('web.connect.other')}</TabsTrigger>
          </TabsList>
          <TabsContent value="claude-code" className="flex flex-col gap-4 px-4 pb-5 sm:px-5">
            <CopyField label={t('web.connect.runInTerminal')} value={snippets.claudeCode} mono />
            <Guide i18nKey="web.connect.claudeCodeSignIn" />
            <Guide i18nKey="web.connect.claudeCodeScope" />
          </TabsContent>
          <TabsContent value="cursor" className="flex flex-col gap-4 px-4 pb-5 sm:px-5">
            <Guide i18nKey="web.connect.cursorFile" />
            <CopyField
              label={t('web.connect.cursorConfig')}
              value={snippets.cursor}
              multiline
              mono
            />
            <Guide i18nKey="web.connect.cursorSignIn" />
          </TabsContent>
          <TabsContent value="codex" className="flex flex-col gap-4 px-4 pb-5 sm:px-5">
            <Guide i18nKey="web.connect.codexFile" />
            <CopyField label={t('web.connect.codexConfig')} value={snippets.codex} multiline mono />
            <CopyField label={t('web.connect.signInCommand')} value={CODEX_SIGN_IN} mono />
          </TabsContent>
          <TabsContent value="other" className="flex flex-col gap-4 px-4 pb-5 sm:px-5">
            <CopyField label={t('web.connect.mcpUrl')} value={snippets.mcpUrl} mono />
            <Guide i18nKey="web.connect.otherHint" />
          </TabsContent>
        </Tabs>

        {skillText === null ? null : <SkillSection text={skillText} />}

        <Section
          title={t('web.connect.tokensTitle')}
          body={<Guide i18nKey="web.connect.tokensBody" />}
        >
          <div>
            <Button asChild variant="secondary" leadingIcon={<KeyRound />}>
              <Link to="/settings/tokens">{t('web.connect.tokensLink')}</Link>
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
