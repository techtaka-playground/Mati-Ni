import { prisma } from "@/lib/prisma";

// 로그인 이메일이 속한 EmailAccessGroup들의 전체 멤버 이메일 집합(본인 포함)을 반환.
// 세금계산서 열람 제한(Party.email)에서 그룹 멤버 중 누구의 거래처든 볼 수 있게 확장한다
// (2026-08-27, sol-mate의 이메일 그룹관리 기능 이식). 그룹에 속하지 않으면 본인 이메일만.
export async function getAccessibleEmails(email: string): Promise<Set<string>> {
  const normalized = email.trim().toLowerCase();

  const memberships = await prisma.emailGroupMember.findMany({
    where: { email: normalized },
    select: { groupId: true },
  });
  if (memberships.length === 0) return new Set([normalized]);

  const groupMembers = await prisma.emailGroupMember.findMany({
    where: { groupId: { in: memberships.map((m) => m.groupId) } },
    select: { email: true },
  });

  const emails = new Set(groupMembers.map((m) => m.email));
  emails.add(normalized);
  return emails;
}
