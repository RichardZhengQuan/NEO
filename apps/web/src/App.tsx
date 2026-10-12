/**
 * App root: theme, language, dialogs and link handling around the bootstrap
 * gate (connect → onboarding → the app), plus everything that runs once per
 * session: the event stream, platform hooks and keyboard shortcuts.
 */
import { Suspense, useEffect, useMemo, useRef, type ReactElement } from 'react';
import { ConfirmProvider, I18nProvider, LinkProvider, NeoAvatar, RemoteImageProvider, Spinner, ThemeProvider, resolveLocale, useLocale, useT, type ThemeSetting } from '@neo/ui';
import { appDictionaries } from './i18n.js';
import { openLink, openPairLink } from './actions/links.js';
import { bootstrap } from './actions/session.js';
import { Shell } from './components/Shell.js';
import { AppErrorBoundary, lazyScreen } from './components/ErrorBoundary.js';
import { Toaster } from './components/Toaster.js';
import { STORAGE_KEYS, readString } from './lib/storage.js';
import { getPlatform } from './platform/index.js';
import { navigate, useRoute, type Route } from './router.js';
import { TimelineScreen } from './screens/TimelineScreen.js';
import { ConnectScreen, OfflineScreen } from './screens/ConnectScreen.js';
import { loadPendingConfirmations, refreshAll, startEventStream } from './state/connection.js';
import { loadReminders } from './state/data.js';
import { runReminderAction, type EventContext } from './state/events.js';
import { onSessionEnd, useSession } from './state/session.js';
import { focusComposer, requestTimelineSearch, setDrawer } from './state/ui.js';
import { originOf, usePreferences } from './state/preferences.js';

// Secondary screens load on demand so the first paint stays light on phones.
const MemoryScreen = lazyScreen(() => import('./screens/MemoryScreen.js').then((m) => ({ default: m.MemoryScreen })));
const NotesScreen = lazyScreen(() => import('./screens/NotesScreen.js').then((m) => ({ default: m.NotesScreen })));
const OnboardingScreen = lazyScreen(() => import('./screens/OnboardingScreen.js').then((m) => ({ default: m.OnboardingScreen })));
const RemindersScreen = lazyScreen(() => import('./screens/RemindersScreen.js').then((m) => ({ default: m.RemindersScreen })));
const SettingsScreen = lazyScreen(() => import('./screens/SettingsScreen.js').then((m) => ({ default: m.SettingsScreen })));
const TasksScreen = lazyScreen(() => import('./screens/TasksScreen.js').then((m) => ({ default: m.TasksScreen })));
const PlanTomorrowScreen = lazyScreen(() => import('./screens/PlanTomorrowScreen.js').then((m) => ({ default: m.PlanTomorrowScreen })));

function ScreenFallback(): ReactElement {
  return (
    <div className="page" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Spinner size={20} />
    </div>
  );
}

function Splash(): ReactElement {
  const t = useT();
  return (
    <div className="center-screen" role="status" aria-label={t('common.loading')}>
      <NeoAvatar size={72} state="thinking" shape="squircle" />
      <Spinner size={18} className="mt-4" />
    </div>
  );
}

/** Session-wide wiring: WebSocket events, platform hooks, initial data. */
function useSessionWiring(route: Route): void {
  const client = useSession((s) => s.client);
  const t = useT();
  const locale = useLocale();
  const routeRef = useRef(route);
  routeRef.current = route;
  const tRef = useRef(t);
  tRef.current = t;
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    if (!client) return;
    const platform = getPlatform();
    let disposed = false;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const debounce = (key: string, fn: () => void, ms: number) => {
      if (disposed) return;
      const prev = timers.get(key);
      if (prev) clearTimeout(prev);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fn();
        }, ms),
      );
    };
    const active = () => routeRef.current.name === 'timeline';
    const syncReminders = () => debounce('sync-reminders', () => void platform.syncReminders(client), 800);
    const context = (): EventContext => ({
      client,
      t: tRef.current,
      locale: localeRef.current,
      assistantName: () => 'NEO',
      timelineActive: active,
      openLink,
      syncReminders,
      debounce,
    });

    const stopEvents = startEventStream({ client, context, timelineActive: active, onResync: syncReminders });
    const stopPlatform = platform.init({
      openLink,
      onPairLink: openPairLink,
      onReminderAction: (id, action) => void runReminderAction(client, id, action, tRef.current),
      onResume: () => debounce('resume', () => void refreshAll(client).finally(syncReminders), 500),
    });

    void loadPendingConfirmations(client).catch(() => undefined);
    void loadReminders(client).catch(() => undefined);
    syncReminders();

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      stopEvents();
      stopPlatform();
      for (const timer of timers.values()) clearTimeout(timer);
    };
    const unregister = onSessionEnd(cleanup);
    return () => {
      unregister();
      cleanup();
    };
  }, [client]);

  useEffect(() => {
    getPlatform().setLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDrawer(false);
        navigate({ name: 'timeline' });
        requestTimelineSearch();
      } else if (e.key === '/') {
        e.preventDefault();
        setDrawer(false);
        const route = window.location.hash;
        if (!route.startsWith('#/timeline') && route !== '' && route !== '#/') navigate({ name: 'timeline' });
        focusComposer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Screen({ route }: { route: Route }): ReactElement {
  switch (route.name) {
    case 'plan-tomorrow':
      return <PlanTomorrowScreen date={route.date} />;
    case 'memory':
      return <MemoryScreen tab={route.tab} nodeId={route.nodeId} />;
    case 'reminders':
      return <RemindersScreen highlightId={route.reminderId} />;
    case 'tasks':
      return <TasksScreen listId={route.listId} taskId={route.taskId} />;
    case 'notes':
      return <NotesScreen noteId={route.noteId} />;
    case 'settings':
      return <SettingsScreen section={route.section} />;
    case 'timeline':
      return <TimelineScreen messageId={route.messageId} />;
    default:
      return <TimelineScreen />;
  }
}

function ReadyApp(): ReactElement {
  const route = useRoute();
  const onboarded = useSession((s) => s.settings?.onboarded ?? false);
  useSessionWiring(route);
  useShortcuts();

  useEffect(() => {
    if (route.name === 'pair') {
      if (route.token || route.code) {
        const q = new URLSearchParams();
        if (route.version) q.set('v', route.version);
        if (route.code) q.set('code', route.code);
        if (route.token) q.set('token', route.token);
        const server = route.serverUrl ?? (/^https?:$/.test(window.location.protocol) ? window.location.origin : undefined);
        if (server) q.set('server', server);
        openPairLink(`neo://pair?${q.toString()}`);
      }
      navigate({ name: 'timeline' }, { replace: true });
    } else if (route.name === 'connect') {
      navigate({ name: 'timeline' }, { replace: true });
    }
  }, [route]);

  if (!onboarded || route.name === 'onboarding') {
    return (
      <Suspense fallback={<Splash />}>
        <OnboardingScreen />
      </Suspense>
    );
  }
  return (
    <Shell route={route}>
      <Suspense fallback={<ScreenFallback />}>
        <Screen route={route} />
      </Suspense>
    </Shell>
  );
}

function Gate(): ReactElement {
  const phase = useSession((s) => s.phase);
  useEffect(() => {
    void bootstrap();
  }, []);
  switch (phase) {
    case 'booting':
      return <Splash />;
    case 'connect':
      return <ConnectScreen />;
    case 'offline':
      return <OfflineScreen />;
    case 'ready':
      return <ReadyApp />;
  }
}

export function App(): ReactElement {
  const settings = useSession((s) => s.settings);
  const theme = (settings?.theme ?? readString(STORAGE_KEYS.theme) ?? 'system') as ThemeSetting;
  const locale = resolveLocale(settings?.locale ?? readString(STORAGE_KEYS.locale) ?? 'auto');
  const remoteImages = usePreferences((s) => s.remoteImages);
  const serverOrigin = originOf(useSession((s) => s.serverUrl));
  // The NEO server is the app's own origin even when the app runs from Electron/Capacitor.
  const trusted = useMemo(() => (serverOrigin ? [serverOrigin] : []), [serverOrigin]);
  return (
    <ThemeProvider theme={theme === 'light' || theme === 'dark' ? theme : 'system'}>
      <I18nProvider locale={locale} messages={appDictionaries}>
        <ConfirmProvider>
          <LinkProvider onLink={openLink}>
            <RemoteImageProvider autoLoad={remoteImages} trustedOrigins={trusted}>
              <AppErrorBoundary>
                <Gate />
              </AppErrorBoundary>
              <Toaster />
            </RemoteImageProvider>
          </LinkProvider>
        </ConfirmProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
