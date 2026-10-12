/** HTTP composition: security, authentication, routes, WebSocket and static app. */
import type { Server } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createNodeWebSocket } from '@hono/node-ws';
import { NeoError, httpStatusForCode } from '@neo/protocol';
import type { NeoServices, NeoApp } from './index.js';
import type { StorageDeviceStore } from '@neo/storage';
import './types.js';
import { createAuthMiddleware, getClientIp, IpFailureLimiter, ownerOnly } from './auth.js';
import { registerHealth } from './routes/health.js';
import { registerTimeline } from './routes/conversations.js';
import { registerMemory } from './routes/memory.js';
import { registerReminders } from './routes/reminders.js';
import { registerTasks } from './routes/tasks.js';
import { registerNotes } from './routes/notes.js';
import { registerNotifications } from './routes/notifications.js';
import { registerProviders } from './routes/providers.js';
import { openRouterRoutes } from './routes/openrouter.js';
import { registerChatGPT } from './routes/chatgpt.js';
import { registerSettings } from './routes/settings.js';
import { registerTools } from './routes/tools.js';
import { registerDevices } from './routes/devices.js';
import { registerPush } from './routes/push.js';
import { createWsHandler, revokeDeviceWebSockets, WS_MAX_PAYLOAD } from './ws.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' ws: wss: https:; style-src 'self' 'unsafe-inline'; script-src 'self'";

export function createApp(services: NeoServices): NeoApp {
  const app = new Hono();
  const { config, devices } = services;
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
  // This adapter exposes the underlying server but no constructor option passthrough.
  // Set the limit before any socket can be upgraded or buffered.
  wss.options.maxPayload = WS_MAX_PAYLOAD;
  const limiter = new IpFailureLimiter(services.clock);
  const unsubscribeRevoke = (devices as Partial<StorageDeviceStore>).onRevoke?.(id => revokeDeviceWebSockets(services.events, id));
  if (unsubscribeRevoke) {
    const close = services.close.bind(services);
    services.close = () => { unsubscribeRevoke(); return close(); };
  }

  app.onError((err, c) => {
    const neo = NeoError.from(err);
    if (neo.code === 'internal') services.logger.error('Unhandled HTTP error', { error: String(err) });
    return c.newResponse(JSON.stringify(neo.toJSON()), httpStatusForCode(neo.code) as ContentfulStatusCode, {
      'Content-Type': 'application/json',
    });
  });

  // Header middleware wraps preflights as well. Node-ws owns upgrade headers.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return;
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (config.server.webDir && c.req.path !== '/api' && !c.req.path.startsWith('/api/')) {
      c.header('Content-Security-Policy', CSP);
    }
  });

  const allowedOrigins = new Set(config.server.corsOrigins);
  if (config.server.publicUrl) allowedOrigins.add(new URL(config.server.publicUrl).origin);
  app.use('*', async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next();
    return cors({
      origin: (origin) => {
        if (origin === new URL(c.req.url).origin || allowedOrigins.has(origin)) return origin;
        if (config.mode === 'local' && (
          /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
          || origin === 'capacitor://localhost' || origin === 'app://neo'
        )) return origin;
        return null;
      },
      allowHeaders: ['Authorization', 'Content-Type', 'Accept'],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Disposition'],
      credentials: true,
    })(c, next);
  });

  const openRouter = openRouterRoutes(services);
  openRouter.registerPublic(app);
  registerHealth(app, services);
  app.get('/api/ws', upgradeWebSocket(c => createWsHandler(devices, services.events, services.logger, {
    ip: getClientIp(c, config.server.trustProxy), limiter,
  }), { onError: error => services.logger.debug('WebSocket transport error', { error: String(error) }) }));
  app.use('/api/*', createAuthMiddleware(devices, config.server.trustProxy, services.clock, limiter));
  app.use('/api/*', bodyLimit({
    maxSize: config.server.maxBodyBytes,
    onError: () => { throw new NeoError('bad_request', 'Request body is too large'); },
  }));

  openRouter.registerPrivate(app);
  registerChatGPT(app, services);
  registerTimeline(app, services);
  registerMemory(app, services);
  registerReminders(app, services);
  registerTasks(app, services);
  registerNotes(app, services);
  registerNotifications(app, services);
  registerProviders(app, services);
  registerSettings(app, services);
  registerTools(app, services);
  app.on('POST', '/api/devices', ownerOnly());
  registerDevices(app, services);
  registerPush(app, services, config.push.vapidPublicKey ?? null);

  if (config.server.webDir) {
    const webDir = resolve(config.server.webDir);
    app.get('*', async (c) => {
      if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
        throw new NeoError('not_found', 'Route not found');
      }
      let pathname: string;
      try { pathname = decodeURIComponent(c.req.path); }
      catch { throw new NeoError('bad_request', 'Invalid path encoding'); }
      const root = await realpath(webDir).catch(() => { throw new NeoError('not_found', 'Web app not found'); });
      const candidate = resolve(root, `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new NeoError('not_found', 'File not found');
      const resolved = await realpath(candidate).catch(() => null);
      if (resolved && resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new NeoError('not_found', 'File not found');
      const isFile = resolved && await stat(resolved).then((s) => s.isFile(), () => false);
      const file = isFile ? resolved : resolve(root, 'index.html');
      // Verify fallback too: symlinks must never expose files outside the app.
      const actual = await realpath(file).catch(() => { throw new NeoError('not_found', 'Web app not found'); });
      if (!actual.startsWith(`${root}${sep}`)) throw new NeoError('not_found', 'File not found');
      const data = await readFile(actual);
      return new Response(data, {
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': ['index.html', 'sw.js'].includes(basename(file)) ? 'no-cache' : 'public, max-age=31536000, immutable',
        },
      });
    });
  }
  app.notFound((c) => c.json({ code: 'not_found', message: 'Route not found' }, 404));
  return { app, injectWebSocket(server: Server) { injectWebSocket(server); } };
}
