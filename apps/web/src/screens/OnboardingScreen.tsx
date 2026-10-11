/**
 * First-run setup: Welcome → Choose your AI → Memory → Make it yours →
 * Notifications → Done. Each step saves as you go, so leaving halfway keeps
 * what was chosen; the current step survives a reload.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import type { MemoryPolicy, Persona } from '@neo/protocol';
import {
  AvatarPicker,
  Badge,
  Button,
  Icon,
  NeoAvatar,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  TextArea,
  TextField,
  useT,
  type AvatarState,
} from '@neo/ui';
import { ChipInput } from '../components/ChipInput.js';
import { MemoryNetArt } from '../components/MemoryNetArt.js';
import { useModelLabel } from '../components/ModelPicker.js';
import { ProviderSetup } from '../components/ProviderSetup.js';
import { PairPhoneDialog } from '../components/PairPhoneDialog.js';
import { errorMessage } from '../lib/errors.js';
import { STORAGE_KEYS, readString, writeString } from '../lib/storage.js';
import { getPlatform, type NotificationStatus } from '../platform/index.js';
import { navigate } from '../router.js';
import { pushToast } from '../state/notifications.js';
import { loadProviders, requireClient, updateSettings, useSession } from '../state/session.js';

const STEPS = ['welcome', 'ai', 'memory', 'persona', 'notifications', 'done'] as const;
type Step = (typeof STEPS)[number];

export const TRAIT_SUGGESTIONS = ['curious', 'warm', 'direct', 'witty', 'patient', 'concise', 'encouraging', 'honest', 'calm', 'playful'];
export const BLOCKED_SUGGESTIONS = ['health', 'finances', 'politics', 'religion', 'relationships', 'work'];
export const LANGUAGES = ['auto', 'en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'it', 'ru'];

function StepFrame(props: { title: ReactNode; lead?: ReactNode; children: ReactNode; footer: ReactNode; onSubmit?: () => void }): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const body = (
    <>
      <div className="onboarding__body neo-animate-in">
        <h1 ref={heading} tabIndex={-1} className="onboarding__title" style={{ outline: 'none' }}>
          {props.title}
        </h1>
        {props.lead && <p className="onboarding__lead">{props.lead}</p>}
        {props.children}
      </div>
      <div className="onboarding__footer">{props.footer}</div>
    </>
  );
  if (!props.onSubmit) return body;
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        props.onSubmit!();
      }}
      style={{ display: 'contents' }}
    >
      {body}
    </form>
  );
}

function Footer(props: { onBack?: () => void; next: ReactNode; nextIcon?: string; onNext?: () => void; disabled?: boolean; loading?: boolean; extra?: ReactNode }): ReactElement {
  const t = useT();
  return (
    <>
      {props.onBack && (
        <Button variant="ghost" icon="arrow-left" onClick={props.onBack} disabled={props.loading}>
          {t('common.back')}
        </Button>
      )}
      <span style={{ flex: 1 }} />
      {props.extra}
      <Button type={props.onNext ? 'button' : 'submit'} variant="primary" size="lg" iconRight={props.nextIcon ?? 'arrow-right'} onClick={props.onNext} disabled={props.disabled} loading={props.loading}>
        {props.next}
      </Button>
    </>
  );
}

// ── steps ────────────────────────────────────────────────────────────────

function WelcomeStep({ next, skip }: { next: () => void; skip: () => void }): ReactElement {
  const t = useT();
  const persona = useSession((s) => s.settings?.persona);
  const [state, setState] = useState<AvatarState>('speaking');
  useEffect(() => {
    const id = setTimeout(() => setState('idle'), 2400);
    return () => clearTimeout(id);
  }, []);
  const pillars = [
    { icon: 'cpu', title: t('onboarding.welcome.p1_title'), text: t('onboarding.welcome.p1_text') },
    { icon: 'brain', title: t('onboarding.welcome.p2_title'), text: t('onboarding.welcome.p2_text') },
    { icon: 'server', title: t('onboarding.welcome.p3_title'), text: t('onboarding.welcome.p3_text') },
  ];
  return (
    <StepFrame
      title={
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1.25rem' }}>
          <NeoAvatar avatar={persona?.avatar ?? null} size={104} state={state} shape="squircle" title={persona?.name ?? 'NEO'} />
          {t('onboarding.welcome.title', { name: persona?.name ?? 'NEO' })}
        </span>
      }
      lead={t('onboarding.welcome.lead')}
      footer={<Footer onNext={next} next={t('onboarding.welcome.start')} extra={<Button variant="ghost" onClick={skip}>{t('onboarding.skip_all')}</Button>} />}
    >
      <div className="pillars">
        {pillars.map((p) => (
          <div key={p.icon} className="option-card" style={{ cursor: 'default' }}>
            <span className="option-card__icon" style={{ background: 'var(--neo-accent-muted)', color: 'var(--neo-accent-text)' }}>
              <Icon name={p.icon} size={18} />
            </span>
            <span>
              <span className="option-card__title">{p.title}</span>
              <span className="option-card__text">{p.text}</span>
            </span>
          </div>
        ))}
      </div>
    </StepFrame>
  );
}

function AiStep({ next, back }: { next: () => void; back: () => void }): ReactElement {
  const t = useT();
  const providers = useSession((s) => s.providers);
  const defaultModel = useSession((s) => s.settings?.defaultModel ?? null);
  const current = useModelLabel(defaultModel);
  useEffect(() => {
    void loadProviders().catch(() => undefined);
  }, []);
  return (
    <StepFrame
      title={t('onboarding.ai.title')}
      lead={t('onboarding.ai.lead')}
      footer={<Footer onBack={back} onNext={next} next={defaultModel ? t('common.continue') : t('onboarding.ai.later')} />}
    >
      {defaultModel && (
        <div className="neo-callout" data-tone="success" style={{ marginBottom: '1rem' }}>
          <span className="neo-callout__icon">
            <Icon name="check-circle" size={17} />
          </span>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>{t('onboarding.ai.current', { model: current })}</p>
        </div>
      )}
      {providers ? (
        <ProviderSetup
          existing={providers.items}
          offerExisting
          onDone={async ({ provider, model }) => {
            await updateSettings({ defaultModel: { provider: provider.id, model } });
            next();
          }}
        />
      ) : (
        <Spinner size={20} />
      )}
    </StepFrame>
  );
}

const MODE_ICON: Record<MemoryPolicy['mode'], string> = { auto: 'sparkles', approve: 'check-square', off: 'eye-off' };

function MemoryStep({ next, back }: { next: () => void; back: () => void }): ReactElement {
  const t = useT();
  const policy = useSession((s) => s.settings!.memory);
  const [mode, setMode] = useState(policy.mode);
  const [blocked, setBlocked] = useState(policy.blockedTopics);
  const [cloud, setCloud] = useState(policy.sendSensitiveToCloud);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await updateSettings({ memory: { mode, blockedTopics: blocked, sendSensitiveToCloud: cloud } });
      next();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <StepFrame title={t('onboarding.memory.title')} lead={t('onboarding.memory.lead')} onSubmit={() => void save()} footer={<Footer onBack={back} next={t('common.continue')} loading={saving} />}>
      <figure style={{ margin: '0 0 1.25rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
        <MemoryNetArt label={t('onboarding.memory.art')} />
        <figcaption className="neo-help" style={{ textAlign: 'center', maxWidth: '30rem' }}>
          {t('onboarding.memory.art_caption')}
        </figcaption>
      </figure>
      <div role="radiogroup" aria-label={t('onboarding.memory.mode')} style={{ display: 'grid', gap: '0.5rem' }}>
        {(['auto', 'approve', 'off'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className="option-card" onClick={() => setMode(m)}>
            <span className="option-card__icon">
              <Icon name={MODE_ICON[m]} size={18} />
            </span>
            <span style={{ flex: 1 }}>
              <span className="option-card__title">
                {t(`memoryMode.${m}.title`)} {m === 'auto' && <Badge tone="accent">{t('onboarding.recommended')}</Badge>}
              </span>
              <span className="option-card__text">{t(`memoryMode.${m}.text`)}</span>
            </span>
            {mode === m && <Icon name="check" size={16} className="option-check" />}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '1.5rem' }}>
        <ChipInput label={t('memoryPolicy.blocked')} values={blocked} onChange={setBlocked} placeholder={t('memoryPolicy.blocked_placeholder')} suggestions={BLOCKED_SUGGESTIONS.map((k) => t(`topic.${k}`))} help={t('memoryPolicy.blocked_help')} max={50} maxLength={100} />
        <Switch checked={cloud} onChange={setCloud} label={t('memoryPolicy.sensitive_cloud')} description={t('memoryPolicy.sensitive_cloud_help')} />
      </div>
    </StepFrame>
  );
}

export function PersonaFields({ persona, onChange, compactAvatar }: { persona: Persona; onChange: (p: Persona) => void; compactAvatar?: boolean }): ReactElement {
  const t = useT();
  const set = <K extends keyof Persona>(key: K, value: Persona[K]) => onChange({ ...persona, [key]: value });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
      <AvatarPicker compact={compactAvatar} value={persona.avatar} onChange={(encoded) => set('avatar', encoded)} />
      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' }}>
        <TextField label={t('persona.name')} value={persona.name} onChange={(v) => set('name', v)} maxLength={60} required placeholder="NEO" />
        <TextField label={t('persona.tagline')} value={persona.tagline} onChange={(v) => set('tagline', v)} maxLength={200} placeholder={t('persona.tagline_placeholder')} />
      </div>
      <div className="neo-field">
        <span className="neo-label">{t('persona.tone')}</span>
        <SegmentedControl
          label={t('persona.tone')}
          value={persona.tone === 'custom' ? 'warm' : persona.tone}
          onChange={(v) => set('tone', v)}
          options={(['warm', 'professional', 'playful', 'concise'] as const).map((v) => ({ value: v, label: t(`persona.tone_${v}`) }))}
        />
      </div>
      <ChipInput label={t('persona.traits')} values={persona.traits} onChange={(v) => set('traits', v)} suggestions={TRAIT_SUGGESTIONS.map((k) => t(`trait.${k}`))} max={12} placeholder={t('persona.traits_placeholder')} />
      <TextArea label={t('persona.instructions')} value={persona.instructions} onChange={(v) => set('instructions', v)} rows={3} maxLength={8000} placeholder={t('persona.instructions_placeholder')} help={t('persona.instructions_help')} />
      <Select label={t('persona.language')} value={LANGUAGES.includes(persona.language) ? persona.language : 'auto'} onChange={(v) => set('language', v)} options={LANGUAGES.map((l) => ({ value: l, label: t(`language.${l}`) }))} help={t('persona.language_help')} />
    </div>
  );
}

function PersonaStep({ next, back }: { next: () => void; back: () => void }): ReactElement {
  const t = useT();
  const saved = useSession((s) => s.settings!.persona);
  const [persona, setPersona] = useState<Persona>(saved);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!persona.name.trim()) return;
    setSaving(true);
    try {
      await updateSettings({ persona: { ...persona, name: persona.name.trim(), traits: persona.traits } });
      next();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <StepFrame title={t('onboarding.persona.title')} lead={t('onboarding.persona.lead')} onSubmit={() => void save()} footer={<Footer onBack={back} next={t('common.continue')} loading={saving} disabled={!persona.name.trim()} />}>
      <div className="neo-card" style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', marginBottom: '1.25rem' }} aria-live="polite">
        <NeoAvatar avatar={persona.avatar} size={52} shape="squircle" state="speaking" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650 }}>{persona.name || 'NEO'}</div>
          <div className="neo-help" style={{ fontSize: '0.875rem' }}>
            {t(`persona.sample_${persona.tone === 'custom' ? 'warm' : persona.tone}`, { name: persona.name || 'NEO' })}
          </div>
        </div>
      </div>
      <PersonaFields persona={persona} onChange={setPersona} compactAvatar />
    </StepFrame>
  );
}

export function notificationCopy(t: (k: string, v?: Record<string, string | number>) => string, kind: string, status: NotificationStatus | null): { title: string; text: string; problem?: string } {
  const title = t(`notify.${kind}.title`);
  const text = t(`notify.${kind}.text`);
  if (!status) return { title, text };
  if (status.reason) return { title, text, problem: t(`notify.reason.${status.reason}`) };
  if (status.permission === 'denied') return { title, text, problem: t(`notify.${kind}.denied`) };
  return { title, text };
}

function NotificationsStep({ next, back }: { next: () => void; back: () => void }): ReactElement {
  const t = useT();
  const platform = getPlatform();
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void platform.notificationStatus(requireClient()).then(setStatus).catch(() => undefined);
  }, [platform]);
  const enable = async () => {
    setBusy(true);
    try {
      setStatus(await platform.enableNotifications(requireClient()));
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  };
  const copy = notificationCopy(t, platform.kind, status);
  const enabled = status?.enabled ?? false;
  return (
    <StepFrame title={copy.title} lead={copy.text} footer={<Footer onBack={back} onNext={next} next={enabled ? t('common.continue') : t('onboarding.skip_for_now')} />}>
      <div className="neo-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '1.75rem 1rem', textAlign: 'center' }}>
        <span className="neo-empty__icon" style={{ width: '3.5rem', height: '3.5rem' }}>
          <Icon name={enabled ? 'bell-ring' : 'bell'} size={26} />
        </span>
        {status === null ? (
          <Spinner size={18} />
        ) : enabled ? (
          <Badge tone="success" icon="check">
            {platform.kind === 'electron' ? t('notify.os_managed') : t('notify.enabled')}
          </Badge>
        ) : (
          <Button variant="primary" icon="bell" onClick={() => void enable()} loading={busy} disabled={status.permission === 'unsupported' || status.permission === 'denied' || Boolean(status.reason)}>
            {t('notify.enable')}
          </Button>
        )}
        {copy.problem && (
          <p className="neo-help" style={{ margin: 0, maxWidth: '26rem' }}>
            {copy.problem}
          </p>
        )}
      </div>
    </StepFrame>
  );
}

function DoneStep({ back, finish }: { back: () => void; finish: () => Promise<void> }): ReactElement {
  const t = useT();
  const settings = useSession((s) => s.settings!);
  const model = useModelLabel(settings.defaultModel);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const rows = [
    { icon: 'cpu', label: t('onboarding.done.ai'), value: model || t('onboarding.done.no_ai') },
    { icon: 'brain', label: t('onboarding.done.memory'), value: t(`memoryMode.${settings.memory.mode}.title`) },
    { icon: 'smile', label: t('onboarding.done.persona'), value: `${settings.persona.name} · ${t(`persona.tone_${settings.persona.tone === 'custom' ? 'warm' : settings.persona.tone}`)}` },
  ];
  return (
    <StepFrame
      title={
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1.25rem' }}>
          <NeoAvatar avatar={settings.persona.avatar} size={104} state="speaking" shape="squircle" />
          {t('onboarding.done.title', { name: settings.persona.name })}
        </span>
      }
      lead={t('onboarding.done.lead')}
      footer={
        <Footer
          onBack={back}
          onNext={() => {
            setBusy(true);
            void finish().finally(() => setBusy(false));
          }}
          next={t('onboarding.done.start')}
          nextIcon="message"
          loading={busy}
        />
      }
    >
      <div className="row-list">
        {rows.map((r) => (
          <div key={r.icon} className="row">
            <Icon name={r.icon} size={18} style={{ color: 'var(--neo-accent-text)' }} />
            <div className="row__main">
              <div className="neo-help">{r.label}</div>
              <div className="row__title">{r.value}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="neo-help" style={{ marginTop: '1rem' }}>
        {t('onboarding.done.hint')}
      </p>
      {getPlatform().kind !== 'capacitor' && <Button variant="secondary" icon="qr-code" disabled={busy} onClick={() => setPairing(true)}>{t('devices.pair')}</Button>}
      {pairing && <PairPhoneDialog onClose={() => setPairing(false)} onPaired={() => undefined} />}
    </StepFrame>
  );
}

// ── the wizard ───────────────────────────────────────────────────────────

export function OnboardingScreen(): ReactElement {
  const t = useT();
  const onboarded = useSession((s) => s.settings?.onboarded ?? false);
  const [step, setStepState] = useState<Step>(() => {
    const saved = readString(STORAGE_KEYS.onboardingStep, 'session') as Step | null;
    return saved && STEPS.includes(saved) ? saved : 'welcome';
  });
  const index = STEPS.indexOf(step);
  const setStep = (s: Step) => {
    setStepState(s);
    writeString(STORAGE_KEYS.onboardingStep, s, 'session');
    window.scrollTo?.({ top: 0 });
  };
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);

  const finish = async () => {
    try {
      if (!onboarded) await updateSettings({ onboarded: true });
      writeString(STORAGE_KEYS.onboardingStep, null, 'session');
      navigate({ name: 'chat' }, { replace: true });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding__top">
        <div className="onboarding__progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={index + 1} aria-label={t('onboarding.progress', { n: index + 1, total: STEPS.length })}>
          {STEPS.map((s, i) => (
            <span key={s} data-done={i <= index} />
          ))}
        </div>
        <span className="neo-help" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {index + 1}/{STEPS.length}
        </span>
      </div>
      {step === 'welcome' && <WelcomeStep next={next} skip={() => void finish()} />}
      {step === 'ai' && <AiStep next={next} back={back} />}
      {step === 'memory' && <MemoryStep next={next} back={back} />}
      {step === 'persona' && <PersonaStep next={next} back={back} />}
      {step === 'notifications' && <NotificationsStep next={next} back={back} />}
      {step === 'done' && <DoneStep back={back} finish={finish} />}
    </div>
  );
}
