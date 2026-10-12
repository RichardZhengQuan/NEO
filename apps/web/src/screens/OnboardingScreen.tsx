/**
 * First-run setup: Choose an avatar → Choose your AI → Notifications → Done.
 * Each step saves as you go, so leaving halfway keeps what was chosen; the current step survives a reload.
 */
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  AvatarPicker,
  Badge,
  Button,
  DEFAULT_AVATAR,
  Icon,
  NeoAvatar,
  NeoFigure,
  parseAvatar,
  serializeAvatar,
  Spinner,
  useT,
} from '@neo/ui';
import { PrintBackdrop } from '../components/cyber/PrintBackdrop.js';
import { PrintWordmark } from '../components/cyber/PrintWordmark.js';
import { StackedTabs } from '../components/cyber/PrintGraphics.js';
import { TerminalLine } from '../components/cyber/TerminalLine.js';
import { Hud } from '../components/cyber/Hud.js';
import { useReducedMotion } from '../components/cyber/useReducedMotion.js';
import { useSceneTransition } from '../components/cyber/useSceneTransition.js';
import { useModelLabel } from '../components/ModelLabel.js';
import { ProviderSetup } from '../components/ProviderSetup.js';
import { PairPhoneDialog } from '../components/PairPhoneDialog.js';
import { errorMessage } from '../lib/errors.js';
import { STORAGE_KEYS, readString, writeString } from '../lib/storage.js';
import { getPlatform, type NotificationStatus } from '../platform/index.js';
import { navigate } from '../router.js';
import { pushToast } from '../state/notifications.js';
import { loadProviders, requireClient, updateSettings, useSession } from '../state/session.js';

const STEPS = ['avatar', 'ai', 'notifications', 'done'] as const;
type Step = (typeof STEPS)[number];
const TransitionBusy = createContext(false);

/** Single composition switch for the avatar and done posters. */
export let POSTER_CARD_SIDE: 'left' | 'right' = 'right';
export function setPosterCardSide(side: typeof POSTER_CARD_SIDE): void {
  POSTER_CARD_SIDE = side;
}

function StepFrame(props: { title: ReactNode; lead?: ReactNode; children: ReactNode; footer: ReactNode; onSubmit?: () => void }): ReactElement {
  const persona = useSession((s) => s.settings?.persona);
  const heading = useRef<HTMLHeadingElement>(null);
  const moving = useContext(TransitionBusy);
  useEffect(() => { if (!moving) heading.current?.focus({ preventScroll: true }); }, [moving]);
  const body = (
    <>
      <div className="onboarding__body">
        <div className="cyber-step-heading">
          <StackedTabs className="print-heading-tabs" />
          <NeoAvatar avatar={persona?.avatar} size={44} animated={false} className="cyber-step-portrait" />
          <h1 ref={heading} tabIndex={-1} className="onboarding__title">
            {props.title}
          </h1>
        </div>
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
        if (!moving) props.onSubmit!();
      }}
      style={{ display: 'contents' }}
    >
      {body}
    </form>
  );
}

function Footer(props: { onBack?: () => void; next: ReactNode; onNext?: () => void; disabled?: boolean; loading?: boolean; extra?: ReactNode }): ReactElement {
  const t = useT();
  const moving = useContext(TransitionBusy);
  return (
    <>
      {props.onBack && (
        <Button variant="ghost" icon="arrow-left" onClick={props.onBack} disabled={props.loading || moving}>
          {t('common.back')}
        </Button>
      )}
      <span style={{ flex: 1 }} />
      {props.extra}
      <Button type={props.onNext ? 'button' : 'submit'} variant="primary" size="lg" onClick={props.onNext} disabled={props.disabled || moving} loading={props.loading}>
        {props.next}
      </Button>
    </>
  );
}

// ── steps ────────────────────────────────────────────────────────────────

function AvatarStep({ next, finish, avatar, onAvatarChange, figureFrameRef, orbitAreaRef, cardRef, orbitHost, reducedMotion }: { next: () => void; finish: () => Promise<void>; avatar: string; onAvatarChange: (avatar: string) => void; figureFrameRef: RefObject<HTMLDivElement | null>; orbitAreaRef: RefObject<HTMLDivElement | null>; cardRef: RefObject<HTMLDivElement | null>; orbitHost: HTMLDivElement | null; reducedMotion: boolean }): ReactElement {
  const t = useT();
  const savedPersona = useSession((s) => s.settings!.persona);
  const [initialAvatar] = useState(() => serializeAvatar(parseAvatar(savedPersona.avatar) ?? DEFAULT_AVATAR));
  const [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);
  const moving = useContext(TransitionBusy);
  useEffect(() => { if (!moving) heading.current?.focus({ preventScroll: true }); }, [moving]);
  const save = async (skip = false) => {
    if (savingRef.current || moving) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (!skip || avatar !== initialAvatar) {
        await updateSettings({ persona: { avatar } });
      }
      if (skip) await finish();
      else next();
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };
  return (
    <>
      {orbitHost && createPortal(
        <form className="cyber-avatar-form" onSubmit={submit} style={{ display: 'contents' }}>
          <fieldset className="cyber-orbit" disabled={saving || moving}>
            <AvatarPicker layout="orbit" value={avatar} onChange={onAvatarChange} orbitFrameRef={figureFrameRef} orbitAreaRef={orbitAreaRef} orbitClearanceRef={cardRef} reducedMotion={reducedMotion}>
              {({ characters }) => <div className="cyber-orbit-characters">{characters}</div>}
            </AvatarPicker>
          </fieldset>
        </form>, orbitHost,
      )}
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <h1 ref={heading} tabIndex={-1} className="onboarding__title cyber-avatar-title">
          {t('onboarding.avatar.title')}
        </h1>
        <p className="onboarding__lead">{t('onboarding.avatar.lead')}</p>
        <div className="cyber-avatar-actions">
          <Button type="submit" variant="primary" size="sm" className="cyber-avatar-continue" loading={saving} disabled={moving}>{t('common.continue')}</Button>
          <button type="button" className="cyber-avatar-skip" onClick={() => void save(true)} disabled={saving || moving}>{t('onboarding.skip_all')}</button>
        </div>
      </form>
    </>
  );
}

function AiStep({ next, back }: { next: () => void; back: () => void }): ReactElement {
  const t = useT();
  const providers = useSession((s) => s.providers);
  const defaultModel = useSession((s) => s.settings?.ai.capabilities.text ?? null);
  const current = useModelLabel(defaultModel);
  const connected = !!defaultModel && !!providers?.items.some((p) => p.id === defaultModel.provider && p.enabled && !p.needsReauthorization && p.kind !== 'mock');
  useEffect(() => {
    void loadProviders().catch(() => undefined);
  }, []);
  return (
    <StepFrame
      title={t('onboarding.ai.title')}
      lead={t('onboarding.ai.lead')}
      footer={<Footer onBack={back} onNext={next} next={connected ? t('common.continue') : t('onboarding.skip_for_now')} />}
    >
      {connected && (
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
          onDone={() => next()}
        />
      ) : (
        <Spinner size={20} />
      )}
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
  const providers = useSession((s) => s.providers);
  const fallback = providers?.items.find((p) => p.enabled && !p.needsReauthorization && p.kind !== 'mock' && p.defaultModel?.trim());
  const modelRef = settings.ai.capabilities.text ?? (fallback ? { provider: fallback.id, model: fallback.defaultModel! } : null);
  const model = useModelLabel(modelRef);
  const connected = !!modelRef && !!providers?.items.some((p) => p.id === modelRef.provider && p.enabled && !p.needsReauthorization && p.kind !== 'mock');
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
    void loadProviders().catch(() => undefined);
  }, []);
  const rows = [
    { icon: 'cpu', label: t('onboarding.done.ai'), value: connected ? model : t('onboarding.done.no_ai') },
  ];
  return (
    <StepFrame
      title={t('onboarding.done.title')}
      lead={t('onboarding.done.lead')}
      footer={
        <Footer
          onBack={back}
          onNext={() => {
            setBusy(true);
            void finish().finally(() => setBusy(false));
          }}
          next={t('onboarding.done.start')}
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
  const persona = useSession((s) => s.settings!.persona);
  const [draftAvatar, setDraftAvatar] = useState(() => serializeAvatar(parseAvatar(persona.avatar) ?? DEFAULT_AVATAR));
  const [figureBurst, setFigureBurst] = useState(0);
  const reducedMotion = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const figureFrameRef = useRef<HTMLDivElement>(null);
  const orbitAreaRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [orbitHost, setOrbitHost] = useState<HTMLDivElement | null>(null);
  const transition = useSceneTransition(root, reducedMotion);
  const finishing = useRef(false);
  const [step, setStepState] = useState<Step>(() => {
    const saved = readString(STORAGE_KEYS.onboardingStep, 'session');
    if (saved === 'welcome') return 'ai';
    if (saved === 'persona' || saved === 'memory') return 'notifications';
    return STEPS.find((s) => s === saved) ?? 'avatar';
  });
  const stepRef = useRef(step);
  const [previousIndex, setPreviousIndex] = useState(STEPS.indexOf(step));
  const index = STEPS.indexOf(step);
  const poster = step === 'avatar' || step === 'done';
  const avatar = step === 'avatar' ? draftAvatar : persona.avatar;
  const setStep = (s: Step) => {
    if (s === stepRef.current || finishing.current) return;
    transition.run({
      key: s,
      direction: STEPS.indexOf(s) > STEPS.indexOf(stepRef.current) ? 'forward' : 'back',
      commit: () => {
        setPreviousIndex(STEPS.indexOf(stepRef.current));
        if (s === 'avatar') setDraftAvatar(serializeAvatar(parseAvatar(useSession.getState().settings!.persona.avatar) ?? DEFAULT_AVATAR));
        stepRef.current = s;
        setStepState(s);
        writeString(STORAGE_KEYS.onboardingStep, s, 'session');
        window.scrollTo?.({ top: 0 });
      },
    });
  };
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);

  const finish = async () => {
    if (finishing.current || transition.isLocked()) return;
    finishing.current = true;
    try {
      // The explicit route keeps the scene mounted during the optimistic settings save.
      flushSync(() => navigate({ name: 'onboarding' }, { replace: true }));
      if (!useSession.getState().settings?.onboarded) await updateSettings({ onboarded: true });
      await new Promise<void>((resolve) => transition.run({
        key: 'finish', direction: 'forward', exit: true, commit: () => {},
        settled: () => {
          writeString(STORAGE_KEYS.onboardingStep, null, 'session');
          navigate({ name: 'timeline' }, { replace: true });
          resolve();
        },
      }));
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      finishing.current = false;
    }
  };

  return (
    <TransitionBusy.Provider value={transition.busy}>
      <div ref={root} className={`onboarding cyber-onboarding cyber-onboarding--${poster ? 'poster' : 'content'}${transition.mode ? ` cyber-transition--${transition.mode}` : ''}${transition.exit && transition.mode === 'crossfade' ? ' cyber-transition--finish' : ''}`} data-step={step} data-card-side={POSTER_CARD_SIDE} data-window-anchor={poster && POSTER_CARD_SIDE === 'left' ? 'bottom-left' : 'bottom-right'} data-motion={reducedMotion ? 'off' : 'on'} data-direction={transition.direction} data-transition={transition.busy} aria-busy={transition.busy}>
        <Hud />
        <div ref={orbitAreaRef} className="cyber-stage" aria-hidden="true">
          <PrintBackdrop badges={step !== 'avatar'} persistent />
          <PrintWordmark />
          <div
            className="cyber-figure-hit"
            onMouseEnter={() => setFigureBurst((value) => value + 1)}
            onPointerDown={() => setFigureBurst((value) => value + 1)}
          />
          <div ref={figureFrameRef} className="cyber-figure-frame">
            <NeoFigure avatar={avatar} variant="glitch" glitchTrigger={transition.burst + figureBurst} className="cyber-figure" />
          </div>
        </div>
        <div ref={setOrbitHost} className="cyber-orbit-host" />
        <div ref={cardRef} data-window-anchor={poster && POSTER_CARD_SIDE === 'left' ? 'bottom-left' : 'bottom-right'} className={`cyber-card${!poster ? ' cyber-card--translucent' : ''}${step === 'avatar' ? ' cyber-avatar-card' : ''}`}>
          <div hidden={step === 'avatar'}><StackedTabs className="print-card-tabs" /></div>
          <div className={step === 'avatar' ? 'onboarding__top cyber-avatar-progress' : 'onboarding__top'}>
            {step !== 'avatar' && <span className="cyber-step-label">{t('onboarding.cyber.step', { n: String(index + 1).padStart(2, '0'), total: String(STEPS.length).padStart(2, '0') })}</span>}
            {step === 'avatar' && <span className="cyber-step-count">{String(index + 1).padStart(2, '0')}/{String(STEPS.length).padStart(2, '0')}</span>}
            <div className="onboarding__progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={index + 1} aria-label={t('onboarding.progress', { n: index + 1, total: STEPS.length })}>
              {STEPS.map((s, i) => <span key={s} data-done={i <= index} data-changing={transition.busy && (i <= index) !== (i <= previousIndex)} />)}
            </div>
            {step !== 'avatar' && <span className="neo-help cyber-step-count">{index + 1}/{STEPS.length}</span>}
          </div>
          <div hidden={step === 'avatar'}><TerminalLine text={t(`onboarding.terminal.${step}`)} animateOnMount={false} /></div>
          <div className={`cyber-card-content${transition.started ? ' cyber-card-content--incoming' : ''}`} inert={transition.busy}>
            {step === 'avatar' && <AvatarStep next={next} finish={finish} avatar={draftAvatar} onAvatarChange={setDraftAvatar} figureFrameRef={figureFrameRef} orbitAreaRef={orbitAreaRef} cardRef={cardRef} orbitHost={orbitHost} reducedMotion={reducedMotion} />}
            {step === 'ai' && <AiStep next={next} back={back} />}
            {step === 'notifications' && <NotificationsStep next={next} back={back} />}
            {step === 'done' && <DoneStep back={back} finish={finish} />}
          </div>
        </div>
      </div>
    </TransitionBusy.Provider>
  );
}
