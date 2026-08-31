import crypto from "crypto";

// Prisma/next-headers 의존성이 전혀 없는 순수 서명·검증 로직. proxy.ts(Node 런타임이지만
// "렌더링 코드와 분리해서 실행되니 공유 모듈에 기대지 말라"는 안내를 따름)와
// src/lib/session.ts(next/headers 쿠키 + DB 조회) 양쪽에서 이 파일만 공유한다.

export const SESSION_COOKIE_NAME = "mati_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7일

export type SessionPayload = {
  userId: string;
  email: string;
  role: string;
  exp: number; // 만료 시각(초 단위 유닉스 타임스탬프)
};

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET 환경변수가 설정되지 않았습니다.");
  return secret;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return base64url(crypto.createHmac("sha256", getSecret()).update(data).digest());
}

export function encodeSessionToken(payload: Omit<SessionPayload, "exp">): string {
  const full: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const data = base64url(JSON.stringify(full));
  return `${data}.${sign(data)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [data, signature] = token.split(".");
  if (!data || !signature) return null;
  if (sign(data) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf-8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
