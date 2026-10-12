import {
  NOISE_MAX_MESSAGE,
  RELAY_HEADER,
  RelayOp,
  TUNNEL_FRAME_HEADER,
  TUNNEL_MAX_FRAME,
  TunnelFrameType,
  type RelayOpValue,
  type TunnelFrameTypeValue,
} from '@neo/protocol';

export interface Frame {
  type: TunnelFrameTypeValue;
  stream: number;
  payload: Uint8Array;
}

export interface RelayFrame {
  op: RelayOpValue;
  connection: number;
  payload: Uint8Array;
}

export class TunnelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelProtocolError';
  }
}

const frameTypes = new Set<number>(Object.values(TunnelFrameType));
const relayOps = new Set<number>(Object.values(RelayOp));

function checkId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new TunnelProtocolError('Stream or connection id must be a u32');
  }
}

function encode(type: number, id: number, payload: Uint8Array, header: number): Uint8Array {
  checkId(id);
  const result = new Uint8Array(header + payload.length);
  result[0] = type;
  new DataView(result.buffer).setUint32(1, id, false);
  result.set(payload, header);
  return result;
}

export function encodeFrame(frame: Frame): Uint8Array {
  if (!frameTypes.has(frame.type)) throw new TunnelProtocolError('Unknown frame type');
  if (frame.payload.length + TUNNEL_FRAME_HEADER > TUNNEL_MAX_FRAME) {
    throw new TunnelProtocolError('Frame is too large');
  }
  return encode(frame.type, frame.stream, frame.payload, TUNNEL_FRAME_HEADER);
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < TUNNEL_FRAME_HEADER || bytes.length > TUNNEL_MAX_FRAME) {
    throw new TunnelProtocolError('Invalid frame length');
  }
  const type = bytes[0]!;
  if (!frameTypes.has(type)) throw new TunnelProtocolError('Unknown frame type');
  const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  return { type: type as TunnelFrameTypeValue, stream, payload: bytes.slice(TUNNEL_FRAME_HEADER) };
}

export function encodeJson(value: unknown): Uint8Array {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('Value has no JSON representation');
    return new TextEncoder().encode(text);
  } catch {
    throw new TunnelProtocolError('Invalid JSON value');
  }
}

export function decodeJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new TunnelProtocolError('Invalid JSON payload');
  }
}

function checkRelay(op: number, payloadLength: number): void {
  if (!relayOps.has(op)) throw new TunnelProtocolError('Unknown relay operation');
  if (payloadLength > NOISE_MAX_MESSAGE || (op === RelayOp.Close && payloadLength !== 0)) {
    throw new TunnelProtocolError('Invalid relay payload length');
  }
}

export function encodeRelayFrame(frame: RelayFrame): Uint8Array {
  checkRelay(frame.op, frame.payload.length);
  return encode(frame.op, frame.connection, frame.payload, RELAY_HEADER);
}

export function decodeRelayFrame(bytes: Uint8Array): RelayFrame {
  if (bytes.length < RELAY_HEADER) throw new TunnelProtocolError('Short relay frame');
  const op = bytes[0]!;
  checkRelay(op, bytes.length - RELAY_HEADER);
  const connection = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  return { op: op as RelayOpValue, connection, payload: bytes.slice(RELAY_HEADER) };
}
