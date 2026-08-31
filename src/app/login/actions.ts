"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { setSessionCookie, clearSessionCookie, REMEMBER_EMAIL_COOKIE } from "@/lib/session";

export type AuthResult = { ok: true } | { ok: false; message: string };

export async function createFirstAdmin(input: {
  email: string;
  password: string;
  confirm: string;
}): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) return { ok: false, message: "이메일과 비밀번호를 입력하세요." };
  if (input.password.length < 8) return { ok: false, message: "비밀번호는 8자 이상이어야 합니다." };
  if (input.password !== input.confirm) return { ok: false, message: "비밀번호가 일치하지 않습니다." };

  // 그 사이 다른 관리자가 먼저 생성됐을 수 있으니(레이스 가드) 한 번 더 확인한다.
  const count = await prisma.user.count();
  if (count > 0) return { ok: false, message: "이미 관리자 계정이 있습니다. 로그인해주세요." };

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: "admin",
      canViewPnl: true,
      canViewVouchers: true,
      canViewCustoms: true,
      canViewTaxInvoices: true,
      canViewBankLogs: true,
      canViewParties: true,
    },
  });

  await setSessionCookie({ userId: user.id, email: user.email, role: user.role });
  redirect("/pnl");
}

export async function login(input: {
  email: string;
  password: string;
  remember?: boolean;
}): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) return { ok: false, message: "이메일과 비밀번호를 입력하세요." };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    return { ok: false, message: "이메일 또는 비밀번호가 올바르지 않습니다." };
  }

  // 비밀번호는 절대 저장하지 않음 — 이메일만 기억해서 다음에 열 때 채워준다. 비밀번호
  // 저장/자동입력은 브라우저 자체 비밀번호 관리자(autocomplete)에 맡김.
  const store = await cookies();
  if (input.remember) {
    store.set(REMEMBER_EMAIL_COOKIE, email, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60,
      path: "/",
    });
  } else {
    store.delete(REMEMBER_EMAIL_COOKIE);
  }

  await setSessionCookie({ userId: user.id, email: user.email, role: user.role });
  redirect("/pnl");
}

export async function logout() {
  await clearSessionCookie();
  redirect("/login");
}
