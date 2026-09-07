import { prisma } from "@/lib/prisma";

// 로그인 이메일이 속한 EmailAccessGroup들의 전체 멤버 이메일 집합(본인 포함)을 반환.
// 세금계산서 열람 제한(Party.email)에서 그룹 멤버 중 누구의 거래처든 볼 수 있게 확장한다
// (2026-08-27, sol-mate의 이메일 그룹관리 기능 이식). 그룹에 속하지 않으면 본인 이메일만.
export async function getAccessibleEmails(email: string): Promise<Set<string>> {
  const normalized = email.trim().toLowerCase();

  // 대소문자를 구분하지 않고 찾는다 — addGroupMember는 저장할 때 소문자로 정규화하지만,
  // 옛날에 다른 경로로 들어간 값이나 수기로 손댄 값이 대문자로 남아있으면 정확히 일치하는
  // 문자열만 찾는 쿼리로는 "가입은 돼 있는데 그룹이 안 잡히는" 것처럼 보인다(2026-09-04).
  const memberships = await prisma.emailGroupMember.findMany({
    where: { email: { equals: normalized, mode: "insensitive" } },
    select: { groupId: true },
  });
  if (memberships.length === 0) return new Set([normalized]);

  const groupMembers = await prisma.emailGroupMember.findMany({
    where: { groupId: { in: memberships.map((m) => m.groupId) } },
    select: { email: true },
  });

  // 이 Set은 나중에 다른 곳에서 항상 .trim().toLowerCase()로 정규화한 값과 비교되므로
  // (tax-invoices/actions.ts), 여기서도 반드시 소문자로 통일해서 담아야 한다.
  const emails = new Set(groupMembers.map((m) => m.email.trim().toLowerCase()));
  emails.add(normalized);
  return emails;
}
