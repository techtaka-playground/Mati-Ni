"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { requireLoggedIn } from "@/lib/session";

export async function changePasswordAction(formData: FormData) {
  const session = await requireLoggedIn();

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const newPasswordConfirm = String(formData.get("newPasswordConfirm") ?? "");

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    redirect("/account?error=current");
  }
  if (newPassword.length < 8) {
    redirect("/account?error=short");
  }
  if (newPassword !== newPasswordConfirm) {
    redirect("/account?error=mismatch");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  redirect("/account?done=1");
}
