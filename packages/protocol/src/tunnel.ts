/**
 * The end-to-end-encrypted tunnel between a phone and its NEO server.
 *
 * The phone pins the server's static X25519 key from the pairing QR code and
 * runs a Noise handshake (Noise_NK_25519_ChaChaPoly_SHA256) with the server,
 * either directly on the local network (`ws://<lan address>/v1/tunnel`) or
 * through a relay (`wss://<relay>/v1/connect/<serverId>`) that only forwards
 * ciphertext. NK authenticates the server and gives forward secrecy; the
 * phone still authenticates with its device token inside the channel.
 *
 * Inside the channel, HTTP requests/responses and the event WebSocket are
 * multiplexed as frames. The server answers them with its normal HTTP app, so
 * every route and every auth check applies unchanged.
 *
 * Wire format. Each WebSocket binary message carries exactly one Noise message.
 *   handshake   -> e, es    payload: empty
 *               <- e, ee    payload: empty
 *   transport   every plaintext is one frame: [type u8][stream u32 BE][payload]
 * Streams are opened by the phone (ids 1, 2, 3 …); stream 0 is the session.
 *
 * Relay. A server keeps one outbound WebSocket to `<relay>/v1/server`. The
 * relay sends a challenge, and the server registers its `serverId` by signing
 * it with its Ed25519 relay key (serverId = first 16 bytes of
 * SHA-256(SERVER_ID_CONTEXT ‖ key), hex), so nobody else can claim the id.
 * Afterwards, binary messages are `[op u8][connection u32 BE][payload]`: the
 * relay announces each phone connection (`open`, payload = the phone's IP as
 * UTF-8, for rate limiting only), then pipes `data` (one Noise message) both
 * ways until either side sends `close`.
 */
import { z } from 'zod';
import { ServerIdSchema } from './pairing.js';

export const TUNNEL_NOISE_PROTOCOL = 'Noise_NK_25519_ChaChaPoly_SHA256';
/** Noise prologue = this prefix + serverId, so a session is bound to the id the phone expects. */
export const TUNNEL_PROLOGUE_PREFIX = 'NEO-tunnel-v1\n';
/** Mixed into the hash that derives a serverId from the relay signing key. */
export const SERVER_ID_CONTEXT = 'NEO-server-id-v1\n';
/** Prefix of the message a server signs to register with a relay (followed by the raw challenge bytes). */
export const RELAY_REGISTER_CONTEXT = 'NEO-relay-register-v1\n';

/** LAN listener path (`ws://host:port/v1/tunnel`). */
export const TUNNEL_LAN_PATH = '/v1/tunnel';
export const RELAY_SERVER_PATH = '/v1/server';
/** Phones connect to RELAY_CONNECT_PATH + serverId. */
export const RELAY_CONNECT_PATH = '/v1/connect/';
/** Default port of the LAN listener (the HTTP API defaults to 7777). */
export const DEFAULT_TUNNEL_PORT = 7778;

/** Noise caps a message at 65535 bytes, including the 16-byte AEAD tag. */
export const NOISE_MAX_MESSAGE = 65535;
export const TUNNEL_FRAME_HEADER = 5;
/** Largest frame plaintext (header included). */
export const TUNNEL_MAX_FRAME = NOISE_MAX_MESSAGE - 16;
/** Body bytes per RequestBody/ResponseBody frame. */
export const TUNNEL_BODY_CHUNK = 16 * 1024;
/** Relay binary header: [op u8][connection u32 BE]. */
export const RELAY_HEADER = 5;

export const TunnelFrameType = {
  /** phone → server, payload TunnelRequestHead (JSON). */
  Request: 0x01,
  /** phone → server, raw body bytes. */
  RequestBody: 0x02,
  /** phone → server, empty: the request body is complete. */
  RequestEnd: 0x03,
  /** server → phone, payload TunnelResponseHead (JSON). */
  Response: 0x04,
  /** server → phone, raw body bytes (streams, e.g. SSE). */
  ResponseBody: 0x05,
  /** server → phone, empty. */
  ResponseEnd: 0x06,
  /** either way, payload TunnelReset (JSON): abandon the stream. */
  Reset: 0x07,
  /** phone → server, payload TunnelWsOpen (JSON). */
  WsOpen: 0x10,
  /** server → phone, empty. */
  WsOpened: 0x11,
  /** either way, one UTF-8 text message. */
  WsMessage: 0x12,
  /** either way, payload TunnelWsClose (JSON). */
  WsClose: 0x13,
  /** stream 0, either way, opaque payload echoed by Pong. */
  Ping: 0x20,
  Pong: 0x21,
} as const;
export type TunnelFrameTypeValue = (typeof TunnelFrameType)[keyof typeof TunnelFrameType];

export interface TunnelRequestHead {
  method: string;
  /** Path + query, always under /api/. */
  path: string;
  headers: [string, string][];
}

export interface TunnelResponseHead {
  status: number;
  headers: [string, string][];
}

export interface TunnelReset {
  code: 'aborted' | 'too_large' | 'limit' | 'bad_request' | 'not_found' | 'unavailable' | 'internal';
  message?: string;
}

export interface TunnelWsOpen {
  /** Only /api/ws. */
  path: string;
}

export interface TunnelWsClose {
  code: number;
  reason: string;
}

export const RelayOp = {
  /** relay → server, payload: the phone's IP (UTF-8). */
  Open: 0x01,
  /** either way, payload: one Noise message. */
  Data: 0x02,
  /** either way, empty. */
  Close: 0x03,
} as const;
export type RelayOpValue = (typeof RelayOp)[keyof typeof RelayOp];

/** Text messages on the relay's server socket before registration completes. */
export const RelayControlMessageSchema = z.discriminatedUnion('type', [
  /** relay → server: 32 random bytes, base64url. */
  z.object({ type: z.literal('challenge'), version: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  /** server → relay. key: Ed25519 public key; signature over RELAY_REGISTER_CONTEXT ‖ nonce bytes. Both base64url. */
  z.object({
    type: z.literal('register'),
    serverId: ServerIdSchema,
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }),
  /** relay → server. */
  z.object({ type: z.literal('registered'), serverId: ServerIdSchema }),
  /** relay → server, then the relay closes the socket. */
  z.object({ type: z.literal('error'), code: z.string().max(64), message: z.string().max(500) }),
]);
export type RelayControlMessage = z.infer<typeof RelayControlMessageSchema>;

/** WebSocket close codes used by the relay and the LAN listener. */
export const TunnelCloseCode = {
  /** No server is registered under this id (phone side). */
  UnknownServer: 4404,
  /** Too many connections or messages. */
  RateLimited: 4429,
  /** Registration failed or a frame broke the protocol. */
  ProtocolError: 4400,
  /** A newer registration for the same serverId replaced this one. */
  Replaced: 4409,
  /** Handshake or decryption failed. */
  CryptoError: 4401,
} as const;

// ───────────────────────────── phone access (HTTP API) ─────────────────────────────

/** `GET /api/phone-access`: whether phones can reach this server through the tunnel, and how. */
export interface PhoneAccessStatus {
  enabled: boolean;
  serverId: string;
  /** The server's static X25519 key (base64url), as pinned by phones. */
  publicKey: string;
  lan: {
    listening: boolean;
    port: number | null;
    /** `host:port` addresses advertised to phones. */
    addresses: string[];
    error: string | null;
  };
  relay: {
    /** The relay in use, or null when none is set. */
    url: string | null;
    status: 'off' | 'connecting' | 'connected' | 'error';
    error: string | null;
  };
  /** The server's configured default relay (`tunnel.relayUrl`), '' when there is none. */
  defaultRelayUrl: string;
}

/** `PATCH /api/phone-access` (owner only). relayUrl: null → the default relay, '' → no relay. */
export const UpdatePhoneAccessRequestSchema = z.object({
  enabled: z.boolean().optional(),
  relayUrl: z.string().trim().max(500).nullable().optional(),
});
export type UpdatePhoneAccessRequest = z.input<typeof UpdatePhoneAccessRequestSchema>;
