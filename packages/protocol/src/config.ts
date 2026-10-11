/**
 * Configuration.
 * - NeoConfig: boot-time config (config file + NEO_* env vars). Where and how NEO runs.
 * - NeoSettings: runtime settings the user changes in the app (persona, models,
 *   memory policy, tool permissions). Persisted in the database.
 */
import { z } from 'zod';
import { ModelRefSchema } from './content.js';
import { MemoryPolicySchema } from './memory.js';
import { ProviderConfigSchema, type ProviderConfig } from './providers.js';
import { PermissionLevelSchema } from './tools.js';
import { DEFAULT_TUNNEL_PORT } from './tunnel.js';

export const PersonaSchema = z.object({
  name: z.string().min(1).max(60).default('NEO'),
  tagline: z.string().max(200).default('Your personal AI'),
  /** Emoji or https/data image URL. */
  avatar: z.string().max(200_000).nullable().default(null),
  tone: z.enum(['warm', 'professional', 'playful', 'concise', 'custom']).default('warm'),
  traits: z.array(z.string().max(60)).max(12).default(['curious', 'warm', 'direct']),
  /** Free-form instructions the user writes ("Call me Rich. Keep answers short."). */
  instructions: z.string().max(8000).default(''),
  /** 'auto' answers in the user's language; otherwise a BCP-47 tag like 'zh-CN'. */
  language: z.string().max(20).default('auto'),
  greeting: z.string().max(500).nullable().default(null),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const AgentSettingsSchema = z.object({
  maxSteps: z.number().int().min(1).max(50).default(8),
  maxOutputTokens: z.number().int().min(256).max(128_000).default(8192),
  temperature: z.number().min(0).max(2).nullable().default(null),
  /** History budget (tokens) before old turns are dropped from the front. */
  contextTokenBudget: z.number().int().min(2000).max(1_000_000).default(48_000),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  autoTitle: z.boolean().default(true),
  /** How long a tool confirmation waits before it counts as denied. */
  confirmationTimeoutSec: z.number().int().min(10).max(3600).default(300),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const NeoSettingsSchema = z.object({
  persona: PersonaSchema.prefault({}),
  /** null → first enabled provider's default model. */
  defaultModel: ModelRefSchema.nullable().default(null),
  /** Model used for memory extraction/consolidation; null → defaultModel. */
  memoryModel: ModelRefSchema.nullable().default(null),
  /** Embedding model; null → built-in offline hashing embedder. */
  embedding: z.object({ provider: z.string(), model: z.string() }).nullable().default(null),
  memory: MemoryPolicySchema.prefault({}),
  tools: z
    .object({
      permissions: z.record(z.string(), PermissionLevelSchema).default({}),
    })
    .prefault({}),
  agent: AgentSettingsSchema.prefault({}),
  /** IANA timezone; the server fills this from the host at first boot. */
  timezone: z.string().default('UTC'),
  locale: z.string().default('en'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  onboarded: z.boolean().default(false),
  /**
   * Phones reaching this server through the end-to-end-encrypted tunnel (see tunnel.ts).
   * Only the owner changes it, with PATCH /api/phone-access.
   */
  phoneAccess: z
    .object({
      enabled: z.boolean().default(false),
      /** null → the server's default relay (config `tunnel.relayUrl`); '' → no relay; otherwise a ws(s):// URL. */
      relayUrl: z.string().max(500).nullable().default(null),
    })
    .prefault({}),
});
export type NeoSettings = z.infer<typeof NeoSettingsSchema>;
export const DEFAULT_SETTINGS: NeoSettings = NeoSettingsSchema.parse({});

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | undefined }
    : T;

export type NeoSettingsPatch = DeepPartial<NeoSettings>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Deep-merge `patch` into `base` (objects merge, arrays/primitives/null replace, undefined is ignored). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Apply a patch and re-validate. Throws ZodError on invalid values. */
export function applySettingsPatch(base: NeoSettings, patch: NeoSettingsPatch): NeoSettings {
  return NeoSettingsSchema.parse(deepMerge(base, patch));
}

// ───────────────────────────── boot config ─────────────────────────────

export const DEMO_PROVIDER: ProviderConfig = { id: 'demo', kind: 'mock', label: 'Demo mode', enabled: true, defaultModel: 'neo-demo' };

export const NeoConfigSchema = z.object({
  /**
   * local:  on-device — binds to 127.0.0.1, desktop app embeds the server.
   * server: self-hosted — binds to server.host, requires TLS termination in front for remote access.
   */
  mode: z.enum(['local', 'server']).default('local'),
  /** Where the database, key file and plugins live. `~` is expanded. */
  dataDir: z.string().default('~/.neo'),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      /** 0 = pick a free port (desktop app). */
      port: z.number().int().min(0).max(65535).default(7777),
      /** Public URL clients use (pairing links, push notification clicks). */
      publicUrl: z.string().url().optional(),
      corsOrigins: z.array(z.string()).default([]),
      /** Owner token. Generated and stored in dataDir on first boot when unset. */
      authToken: z.string().min(16).optional(),
      /** Directory of the built web app to serve at "/" (desktop & Docker). */
      webDir: z.string().nullable().default(null),
      trustProxy: z.boolean().default(false),
      maxBodyBytes: z.number().int().positive().default(20 * 1024 * 1024),
    })
    .prefault({}),
  /** The encrypted phone tunnel (see tunnel.ts). Active while settings.phoneAccess.enabled is on. */
  tunnel: z
    .object({
      /** Accept direct tunnel connections on the local network (the listener speaks only the encrypted protocol). */
      lan: z.boolean().default(true),
      host: z.string().default('0.0.0.0'),
      /** Kept stable because phones remember the address from the QR code. 0 = any free port. */
      port: z.number().int().min(0).max(65535).default(DEFAULT_TUNNEL_PORT),
      /** host:port addresses to advertise instead of the detected ones (Docker, port forwarding). */
      advertise: z.array(z.string()).default([]),
      /** Default relay (ws(s)://…). Empty until the NEO project runs a public relay; anyone can self-host one. */
      relayUrl: z.string().default(''),
    })
    .prefault({}),
  /** Providers from the config file. Providers added in the app are stored in the database. */
  providers: z.array(ProviderConfigSchema).default([DEMO_PROVIDER]),
  /** Initial settings (applied once at first boot; afterwards the database wins). */
  settings: z.record(z.string(), z.unknown()).optional(),
  webSearch: z
    .object({
      provider: z.enum(['none', 'searxng', 'brave', 'tavily']).default('none'),
      baseUrl: z.string().url().optional(),
      apiKey: z.string().optional(),
    })
    .prefault({}),
  push: z
    .object({
      vapidPublicKey: z.string().optional(),
      vapidPrivateKey: z.string().optional(),
      subject: z.string().default('mailto:neo@localhost'),
    })
    .prefault({}),
  plugins: z
    .object({
      enabled: z.boolean().default(false),
      dir: z.string().optional(),
    })
    .prefault({}),
  log: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    })
    .prefault({}),
});
export type NeoConfig = z.infer<typeof NeoConfigSchema>;
export type NeoConfigInput = z.input<typeof NeoConfigSchema>;

export function parseConfig(input: unknown): NeoConfig {
  return NeoConfigSchema.parse(input ?? {});
}
