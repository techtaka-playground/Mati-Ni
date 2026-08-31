"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";

export type AcceptInviteResult = { ok: true } | { ok: false; message: string };

// 초대받은 사람이 직접 비밀번호를 정해 가입을 완료한다 — 관리자가 만든 UserInvite를
// 실제 User로 바꾸고, 초대는 재사용되지 않도록 지운다(만료·이미 가입된 경우도 마찬가지).
export async function acceptInvite(input: {
  token: string;
  password: string;
  confirm: string;
}): Promise<AcceptInviteResult> {
  if (!input.password) return { ok: false, message: "비밀번호를 입력하세요." };
  if (input.password.length < 8) return { ok: false, message: "비밀번호는 8자 이상이어야 합니다." };
  if (input.password !== input.confirm) return { ok: false, message: "비밀번호가 일치하지 않습니다." };

  const invite = await prisma.userInvite.findUnique({ where: { token: input.token } });
  if (!invite) return { ok: false, message: "유효하지 않은 초대 링크입니다. 관리자에게 새 링크를 요청하세요." };

  if (invite.expiresAt < new Date()) {
    await prisma.userInvite.delete({ where: { id: invite.id } });
    return { ok: false, message: "만료된 초대 링크입니다. 관리자에게 새 링크를 요청하세요." };
  }

  const existingUser = await prisma.user.findUnique({ where: { email: invite.email } });
  if (existingUser) {
    await prisma.userInvite.delete({ where: { id: invite.id } });
    return { ok: false, message: "이미 가입된 이메일입니다. 로그인해주세요." };
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: invite.email,
      passwordHash,
      role: invite.role,
      canViewPnl: invite.canViewPnl,
      canViewVouchers: invite.canViewVouchers,
      canViewCustoms: invite.canViewCustoms,
      canViewTaxInvoices: invite.canViewTaxInvoices,
      canViewBankLogs: invite.canViewBankLogs,
      canViewParties: invite.canViewParties,
    },
  });
  await prisma.userInvite.delete({ where: { id: invite.id } });

  await setSessionCookie({ userId: user.id, email: user.email, role: user.role });
  redirect("/pnl");
}
