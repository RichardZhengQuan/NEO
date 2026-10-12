import { describe, expect, it } from 'vitest';
import { NOISE_MAX_MESSAGE, RelayOp, TUNNEL_FRAME_HEADER, TUNNEL_MAX_FRAME, TunnelFrameType } from '@neo/protocol';
import {
  decodeFrame, decodeJson, decodeRelayFrame, encodeFrame, encodeJson, encodeRelayFrame, TunnelProtocolError,
} from './frames.js';

describe('tunnel frames', () => {
  it('round-trips every frame type with a big-endian u32 stream', () => {
    for (const type of Object.values(TunnelFrameType)) {
      const frame = { type, stream: 0x12345678, payload: new Uint8Array([1, 2, 3]) };
      const bytes = encodeFrame(frame);
      expect([...bytes.slice(0, 5)]).toEqual([type, 0x12, 0x34, 0x56, 0x78]);
      expect(decodeFrame(bytes)).toEqual(frame);
      // Byte views can begin at any offset inside a larger link buffer.
      const padded = new Uint8Array(bytes.length + 3);
      padded.set(bytes, 2);
      expect(decodeFrame(padded.subarray(2, 2 + bytes.length))).toEqual(frame);
    }
  });

  it('accepts the maximum plaintext frame and rejects lengths or ids outside the contract', () => {
    const valid = { type: TunnelFrameType.RequestBody, stream: 0xffffffff, payload: new Uint8Array(TUNNEL_MAX_FRAME - TUNNEL_FRAME_HEADER) };
    expect(decodeFrame(encodeFrame(valid))).toEqual(valid);
    expect(() => encodeFrame({ ...valid, payload: new Uint8Array(valid.payload.length + 1) })).toThrow(TunnelProtocolError);
    expect(() => decodeFrame(new Uint8Array(TUNNEL_MAX_FRAME + 1))).toThrow(TunnelProtocolError);
    for (const stream of [-1, 1.1, 0x100000000, NaN, Infinity]) {
      expect(() => encodeFrame({ ...valid, stream })).toThrow(TunnelProtocolError);
    }
  });

  it('rejects short or unknown frames and malformed JSON', () => {
    for (let length = 0; length < TUNNEL_FRAME_HEADER; length++) {
      expect(() => decodeFrame(new Uint8Array(length))).toThrow(TunnelProtocolError);
    }
    expect(() => decodeFrame(new Uint8Array([255, 0, 0, 0, 1]))).toThrow(TunnelProtocolError);
    expect(() => encodeFrame({ type: 255 as never, stream: 1, payload: new Uint8Array() })).toThrow(TunnelProtocolError);
    expect(decodeJson(encodeJson({ text: '中文', count: 3 }))).toEqual({ text: '中文', count: 3 });
    expect(() => decodeJson(new Uint8Array([123]))).toThrow(TunnelProtocolError);
    expect(() => decodeJson(new Uint8Array([34, 255, 34]))).toThrow(TunnelProtocolError);
    expect(() => encodeJson(undefined)).toThrow(TunnelProtocolError);
    expect(() => encodeJson(1n)).toThrow(TunnelProtocolError);
  });
});

describe('relay frames', () => {
  it('round-trips all operations, including a full Noise message', () => {
    for (const op of Object.values(RelayOp)) {
      const frame = { op, connection: 0xfedcba98, payload: new Uint8Array(op === RelayOp.Close ? 0 : 11) };
      expect(decodeRelayFrame(encodeRelayFrame(frame))).toEqual(frame);
    }
    const frame = { op: RelayOp.Data, connection: 1, payload: new Uint8Array(NOISE_MAX_MESSAGE) };
    expect(decodeRelayFrame(encodeRelayFrame(frame))).toEqual(frame);
  });

  it('rejects unknown operations, short frames, oversized data and nonempty closes', () => {
    expect(() => decodeRelayFrame(new Uint8Array(4))).toThrow(TunnelProtocolError);
    expect(() => decodeRelayFrame(new Uint8Array([255, 0, 0, 0, 1]))).toThrow(TunnelProtocolError);
    expect(() => encodeRelayFrame({ op: RelayOp.Data, connection: 1, payload: new Uint8Array(NOISE_MAX_MESSAGE + 1) })).toThrow(TunnelProtocolError);
    expect(() => encodeRelayFrame({ op: RelayOp.Close, connection: 1, payload: new Uint8Array(1) })).toThrow(TunnelProtocolError);
    expect(() => encodeRelayFrame({ op: RelayOp.Open, connection: -1, payload: new Uint8Array() })).toThrow(TunnelProtocolError);
  });
});
