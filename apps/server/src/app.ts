import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { NO_PROVIDERS, type Providers } from '@helm/providers';
import type { Config } from './config.ts';
import { HelmError, type ErrorCode } from './core/errors.ts';
import { eventRoutes } from './core/events/sse.ts';
import type { ServiceContext, Services } from './core/services/index.ts';
import { authenticate, authRoutes, passwordFingerprint, type TokenResolver } from './http/auth.ts';
import { timeZoneOf, type AppEnv } from './http/env.ts';
import { apiRoutes } from './http/routes.ts';
import type { HelmModule } from './modules/module.ts';

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported_media: 415,
  unavailable: 503,
  upstream: 502,
};

/** Notes run to 20,000 characters and a request can carry 50 changes; this leaves plenty of room. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface AppDeps {
  config: Config;
  ctx: ServiceContext;
  services: Services;
  modules?: HelmModule[];
  /** AI adapters for modules (voice, assistant). Defaults to none. */
  providers?: Providers;
  resolveToken?: TokenResolver;
}

export async function createApp({
  config,
  ctx,
  services,
  modules = [],
  providers = NO_PROVIDERS,
  resolveToken = (secret) => services.tokens.resolve(secret),
}: AppDeps) {
  const app = new Hono();
  // A new owner password signs out every device that was signed in with the old one.
  services.settings.syncPassword(passwordFingerprint(config));

  app.onError((err, c) => {
    if (err instanceof HelmError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, STATUS[err.code]);
    }
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      // The CSRF check throws a bare 403; say what to do about it.
      const message =
        err.message ||
        (status === 403
          ? 'Cross-site request blocked. Send JSON (Content-Type: application/json) or use a bearer token.'
          : 'Request failed');
      return c.json({ error: { code: status === 403 ? 'forbidden' : 'http_error', message } }, status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });

  // The app loads only its own scripts, styles and data, and can't be framed by another site.
  // (React sets inline style attributes, hence 'unsafe-inline' for styles only.)
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: 'DENY',
      referrerPolicy: 'same-origin',
      // Only when served over HTTPS (tailscale serve); meaningless and unwanted on plain localhost.
      strictTransportSecurity: config.cookieSecure ? 'max-age=15552000' : false,
    }),
  );

  // Nothing but a voice recording (which has its own, larger limit) needs a big request body.
  const smallBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HelmError('too_large', 'That request is too large.');
    },
  });
  app.use('/api/*', (c, next) => (c.req.path.endsWith('/voice/parse') ? next() : smallBody(c, next)));
  app.use('/mcp', smallBody);

  // Rejects cross-site form-style posts made with the session cookie. Requests with a bearer token
  // skip it: a browser can't attach that header cross-site without CORS (which Helm doesn't allow),
  // and a bearer header is never answered with the cookie's rights (see `authenticate`).
  const csrfCheck = csrf();
  app.use('/api/*', (c, next) =>
    /^bearer\s/i.test(c.req.header('authorization') ?? '') ? next() : csrfCheck(c, next),
  );

  app.get('/api/v1/health', (c) => c.json({ ok: true }));
  app.route('/api/v1/auth', authRoutes(config, services.settings));

  const api = new Hono<AppEnv>();
  api.use('*', authenticate(config, resolveToken, services.settings));
  // Remembered for agents, which send no zone: their "today" is then the owner's day.
  api.use('*', (c, next) => {
    if (c.var.principal.kind === 'owner') {
      const zone = timeZoneOf(c);
      if (zone) services.settings.rememberOwnerZone(zone);
    }
    return next();
  });
  api.route('/', apiRoutes(services));
  api.route('/', eventRoutes(ctx.db, ctx.bus, () => services.settings.eventsPrunedThrough()));

  for (const m of modules) {
    await m.register({ config, services, bus: ctx.bus, providers, api, root: app });
  }

  app.route('/api/v1', api);
  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404));
  return app;
}
