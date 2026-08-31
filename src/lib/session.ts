import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  encodeSessionToken,
  verifySessionToken,
  type SessionPayload,
} from "@/lib/sessionToken";

export type { SessionPayload };

export const REMEMBER_EMAIL_COOKIE = "mn_remember_email";

export async function setSessionCookie(payload: Omit<SessionPayload, "exp">): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, encodeSessionToken(payload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

// 로그인 여부만 빠르게 판단한다(DB 조회 없음) — 살짝 늦게 반영돼도 되는 곳에서 쓴다.
export async function getCurrentUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE_NAME)?.value);
}

// Server Action 안에서 로그인 여부를 다시 확인한다 — proxy.ts가 페이지 접근은 막아주지만,
// Next.js 공식 안내대로 Server Action은 그것만 믿지 않고 액션 안에서도 확인한다. 정상적인
// 사용 흐름에서는 이 checker가 걸릴 일이 없다(이미 proxy를 통과했을 것이므로) — 방어선이
// 하나 더 있다는 의미의 안전장치다.
export async function requireLoggedIn(): Promise<SessionPayload> {
  const user = await getCurrentUser();
  if (!user) throw new Error("로그인이 필요합니다.");
  return user;
}

// role/canView*를 DB에서 다시 읽는다 — 관리자가 권한을 바꾼 게 즉시 반영돼야 하는 화면
// (손익조회·일반전표·관세전표·세금계산서·입출금내역·거래처 탭, 사용자 관리 화면, 사이드바
// 메뉴 노출)에서 쓴다.
export type ViewPermissions = {
  canViewPnl: boolean;
  canViewVouchers: boolean;
  canViewCustoms: boolean;
  canViewTaxInvoices: boolean;
  canViewBankLogs: boolean;
  canViewParties: boolean;
};

export async function getCurrentUserFresh(): Promise<(SessionPayload & ViewPermissions) | null> {
  const session = await getCurrentUser();
  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return null;

  return {
    ...session,
    role: user.role,
    canViewPnl: user.canViewPnl,
    canViewVouchers: user.canViewVouchers,
    canViewCustoms: user.canViewCustoms,
    canViewTaxInvoices: user.canViewTaxInvoices,
    canViewBankLogs: user.canViewBankLogs,
    canViewParties: user.canViewParties,
  };
}
