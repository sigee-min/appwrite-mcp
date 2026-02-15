import { createHmac, timingSafeEqual } from "node:crypto";

interface ConfirmationTokenPayload {
  plan_hash: string;
  exp: number;
}

interface VerificationOk {
  ok: true;
}

interface VerificationFail {
  ok: false;
  reason: "expired" | "invalid" | "mismatch";
}

export type ConfirmationTokenVerification = VerificationOk | VerificationFail;

const toBase64Url = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const fromBase64Url = (value: string): string =>
  Buffer.from(value, "base64url").toString("utf8");

export class ConfirmationTokenService {
  constructor(private readonly secret: string) {}

  issue(planHash: string, expiresAtUnixSeconds: number): string {
    const payload: ConfirmationTokenPayload = {
      plan_hash: planHash,
      exp: expiresAtUnixSeconds
    };

    const payloadEncoded = toBase64Url(JSON.stringify(payload));
    const signature = createHmac("sha256", this.secret)
      .update(payloadEncoded)
      .digest("base64url");

    return `${payloadEncoded}.${signature}`;
  }

  verify(
    token: string,
    expectedPlanHash: string,
    nowUnixSeconds: number
  ): ConfirmationTokenVerification {
    const [payloadEncoded, signature] = token.split(".");

    if (!payloadEncoded || !signature) {
      return { ok: false, reason: "invalid" };
    }

    const expectedSignature = createHmac("sha256", this.secret)
      .update(payloadEncoded)
      .digest("base64url");

    const signatureBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return { ok: false, reason: "invalid" };
    }

    let payload: ConfirmationTokenPayload;
    try {
      payload = JSON.parse(fromBase64Url(payloadEncoded)) as ConfirmationTokenPayload;
    } catch {
      return { ok: false, reason: "invalid" };
    }

    if (payload.plan_hash !== expectedPlanHash) {
      return { ok: false, reason: "mismatch" };
    }

    if (payload.exp <= nowUnixSeconds) {
      return { ok: false, reason: "expired" };
    }

    return { ok: true };
  }
}
