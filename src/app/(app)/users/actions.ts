"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserFresh } from "@/lib/session";
import type { DeleteActionResult } from "@/components/DeleteButton";
import { PERMISSION_FIELDS, type PermissionField } from "@/lib/permissions";

const INVITE_EXPIRY_DAYS = 7;

async function requireAdmin() {
  const me = await getCurrentUserFresh();
  if (!me || me.role !== "admin") throw new Error("관리자만 접근할 수 있습니다.");
  return me;
}

function revalidateAll() {
  revalidatePath("/users");
}

export type CreateInviteResult = { ok: true } | { ok: false; message: string };

function readPermissions(formData: FormData): Record<PermissionField, boolean> {
  return Object.fromEntries(
    PERMISSION_FIELDS.map((f) => [f, formData.get(f) === "on"])
  ) as Record<PermissionField, boolean>;
}

// 이메일 발송 인프라가 없어서, 초대 링크만 만들어두고 관리자가 직접(카톡·메일 등으로)
// 전달한다. 링크의 토큰은 URL에 노출되므로 cuid가 아니라 별도의 무작위 값을 쓴다.
export async function createInvite(formData: FormData): Promise<CreateInviteResult> {
  const me = await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "user");
  const permissions = readPermissions(formData);

  if (!email) return { ok: false, message: "이메일을 입력하세요." };

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) return { ok: false, message: "이미 가입된 이메일입니다." };

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await prisma.userInvite.upsert({
    where: { email },
    create: { email, token, role, ...permissions, invitedByEmail: me.email, expiresAt },
    update: { token, role, ...permissions, invitedByEmail: me.email, expiresAt },
  });

  revalidateAll();
  return { ok: true };
}

export async function deleteInvite(formData: FormData): Promise<DeleteActionResult> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  await prisma.userInvite.delete({ where: { id } });
  revalidateAll();
  return { ok: true };
}

// 탭 하나의 열람 권한을 켜고/끈다 — 어느 탭이든 이 하나의 액션으로 처리한다(hidden input
// "field"로 어느 필드인지 넘긴다).
export async function togglePermission(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const field = String(formData.get("field") ?? "");
  if (!id || !PERMISSION_FIELDS.includes(field as PermissionField)) return;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return;

  const key = field as PermissionField;
  await prisma.user.update({ where: { id }, data: { [key]: !user[key] } });
  revalidateAll();
}

export async function setUserRole(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "user");

  if (role !== "admin") {
    const target = await prisma.user.findUnique({ where: { id } });
    if (target?.role === "admin") {
      const adminCount = await prisma.user.count({ where: { role: "admin" } });
      if (adminCount <= 1) return; // 마지막 admin은 강등 불가
    }
  }

  await prisma.user.update({ where: { id }, data: { role } });
  revalidateAll();
}

export async function deleteUser(formData: FormData): Promise<DeleteActionResult> {
  const me = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };
  if (id === me.userId) return { ok: false, reason: "self" };

  const target = await prisma.user.findUnique({ where: { id } });
  if (target?.role === "admin") {
    const adminCount = await prisma.user.count({ where: { role: "admin" } });
    if (adminCount <= 1) return { ok: false, reason: "last_admin" };
  }

  await prisma.user.delete({ where: { id } });
  revalidateAll();
  return { ok: true };
}

// ===== 이메일 그룹 =====
// 같은 그룹에 속한 이메일끼리는 세금계산서 담당자 열람 제한(Party.email)에서 서로의
// 거래처 내역까지 볼 수 있다(src/lib/email-groups.ts의 getAccessibleEmails가 실제 판단).

export async function createGroup(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  await prisma.emailAccessGroup.create({ data: { name: name || null } });
  revalidateAll();
}

export async function deleteGroup(formData: FormData): Promise<DeleteActionResult> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  await prisma.emailAccessGroup.delete({ where: { id } });
  revalidateAll();
  return { ok: true };
}

// 가입 여부와 무관하게 이메일 문자열만 추가 — 아직 초대받지 않은 이메일도 그룹에 넣을 수
// 있어야 나중에 초대·가입할 때 자동으로 그룹 권한이 적용된다.
export async function addGroupMember(formData: FormData) {
  await requireAdmin();
  const groupId = String(formData.get("groupId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!groupId || !email) return;

  await prisma.emailGroupMember.upsert({
    where: { groupId_email: { groupId, email } },
    update: {},
    create: { groupId, email },
  });
  revalidateAll();
}

export async function removeGroupMember(formData: FormData): Promise<DeleteActionResult> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  await prisma.emailGroupMember.delete({ where: { id } });
  revalidateAll();
  return { ok: true };
}
