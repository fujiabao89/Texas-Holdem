import { describe, expect, it } from "vitest";
import {
  computePlayerTokenDigest,
  playerTokenDigestsEqual,
  PLAYER_TOKEN_DIGEST_LENGTH,
} from "./player-token";

describe("computePlayerTokenDigest", () => {
  const base = {
    roomId: "0b9d0a1e-1111-4222-8333-444455556666",
    playerId: "1c2e3f4a-5555-4666-8777-888899990000",
    token: "high-entropy-token-value",
    keyId: "k1",
    secret: "server-hmac-secret",
  };

  it("produces a 32-byte digest (SHA-256)", () => {
    const digest = computePlayerTokenDigest(base);
    expect(digest).toBeInstanceOf(Buffer);
    expect(digest.length).toBe(PLAYER_TOKEN_DIGEST_LENGTH);
  });

  it("is deterministic for identical inputs", () => {
    expect(computePlayerTokenDigest(base).equals(computePlayerTokenDigest(base))).toBe(true);
  });

  it("differs when any binding component changes", () => {
    for (const override of [
      { roomId: "0b9d0a1e-1111-4222-8333-444455556667" },
      { playerId: "1c2e3f4a-5555-4666-8777-888899990001" },
      { token: "another-token" },
      { secret: "other-secret" },
    ]) {
      expect(
        computePlayerTokenDigest({ ...base, ...override }).equals(computePlayerTokenDigest(base)),
      ).toBe(false);
    }
  });

  it("does not mix keyId into the HMAC input (keyId only selects the secret)", () => {
    // keyId 是密钥版本标识（用于轮换），不参与消息绑定（docs/03 §5.2）。
    expect(
      computePlayerTokenDigest({ ...base, keyId: "k2" }).equals(computePlayerTokenDigest(base)),
    ).toBe(true);
  });

  it("is unambiguous about field boundaries (roomId:playerId:token)", () => {
    // `ab` + `c` vs `a` + `bc` 若无分隔符会产生相同输入；分隔符保证区分。
    const a = computePlayerTokenDigest({
      ...base,
      roomId: "ab",
      playerId: "c",
      token: "t",
    });
    const b = computePlayerTokenDigest({
      ...base,
      roomId: "a",
      playerId: "bc",
      token: "t",
    });
    expect(a.equals(b)).toBe(false);
  });
});

describe("playerTokenDigestsEqual", () => {
  it("returns true only for equal digests", () => {
    const a = computePlayerTokenDigest({
      roomId: "r",
      playerId: "p",
      token: "t",
      keyId: "k",
      secret: "s",
    });
    const b = computePlayerTokenDigest({
      roomId: "r",
      playerId: "p",
      token: "t",
      keyId: "k",
      secret: "s",
    });
    const c = computePlayerTokenDigest({
      roomId: "r",
      playerId: "p",
      token: "other",
      keyId: "k",
      secret: "s",
    });
    expect(playerTokenDigestsEqual(a, b)).toBe(true);
    expect(playerTokenDigestsEqual(a, c)).toBe(false);
  });

  it("rejects wrong-length inputs instead of throwing", () => {
    const digest = computePlayerTokenDigest({
      roomId: "r",
      playerId: "p",
      token: "t",
      keyId: "k",
      secret: "s",
    });
    expect(playerTokenDigestsEqual(digest, Buffer.alloc(16))).toBe(false);
    expect(playerTokenDigestsEqual(Buffer.alloc(16), digest)).toBe(false);
  });
});
