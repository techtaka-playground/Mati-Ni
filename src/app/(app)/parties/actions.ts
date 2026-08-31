"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { DeleteActionResult } from "@/components/DeleteButton";
import { requireLoggedIn, getCurrentUserFresh } from "@/lib/session";
import { formatBizNo, bizNoDigits } from "@/lib/format";

// 거래처 화면 자체(수기 등록·삭제)는 canViewParties로 막는다 — ensurePartyByName 등
// 다른 화면(세금계산서 자동 매칭)에서 쓰는 내부 헬퍼들은 그대로 requireLoggedIn만 쓴다
// (canViewParties가 없는 사용자도 세금계산서 자동 거래처 매칭은 계속 동작해야 한다).
async function requirePartiesAccess() {
  const user = await getCurrentUserFresh();
  if (!user?.canViewParties) throw new Error("거래처 열람 권한이 없습니다.");
  return user;
}

export async function createParty(formData: FormData) {
  await requirePartiesAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const note = String(formData.get("note") ?? "").trim();
  const bizNoInput = String(formData.get("bizNo") ?? "").trim();
  const bizNo = bizNoInput ? formatBizNo(bizNoInput) : null;
  if (bizNoInput && !bizNo) return; // 형식이 이상하면 조용히 무시(다른 수기 등록 폼과 동일한 처리)

  if (await prisma.party.findUnique({ where: { name } })) return; // 이미 있는 거래처명
  if (bizNo && (await prisma.party.findUnique({ where: { bizNo } }))) return; // 이미 있는 사업자번호

  await prisma.party.create({
    data: { name, note, bizNo, code: bizNo ? await nextPartyCode() : null, source: "manual" },
  });
  revalidatePath("/parties");
}

export type EnsurePartyResult =
  | { ok: true; party: { id: string; name: string }; created: boolean }
  | { ok: false; message: string };

// PDF에서 추출한 거래처명이 기존 거래처와 매칭되지 않을 때, 업로드 화면에서 그 이름으로
// 바로 새 거래처를 등록한다 — 더존 업로드에서 신규 거래처코드를 자동등록하던 것과 같은
// 패턴. 이름이 정확히 같은 거래처가 이미 있으면(동시 업로드 등) 새로 만들지 않고 재사용한다.
export async function ensurePartyByName(name: string): Promise<EnsurePartyResult> {
  await requireLoggedIn();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "거래처명이 비어 있습니다." };

  const existing = await prisma.party.findUnique({ where: { name: trimmed } });
  if (existing) {
    return { ok: true, party: { id: existing.id, name: existing.name }, created: false };
  }

  try {
    const created = await prisma.party.create({ data: { name: trimmed } });
    revalidatePath("/parties");
    return { ok: true, party: { id: created.id, name: created.name }, created: true };
  } catch {
    const retry = await prisma.party.findUnique({ where: { name: trimmed } });
    if (retry) return { ok: true, party: { id: retry.id, name: retry.name }, created: false };
    return { ok: false, message: "거래처 자동등록에 실패했습니다." };
  }
}

// 거래처 코드 채번 — 4자리 순번(0001, 0002, ...). 코드가 있는 거래처 중 가장 큰 값 다음
// 번호를 쓴다. 호출부(ensurePartyByBizNo/ensurePartiesFromTaxInvoiceRows)가 한 번에 하나씩
// 순차 실행해야 동시 생성 시 코드가 겹치지 않는다.
async function nextPartyCode(): Promise<string> {
  const withCode = await prisma.party.findMany({
    where: { code: { not: null } },
    select: { code: true },
  });
  const max = withCode.reduce((m, p) => Math.max(m, Number(p.code) || 0), 0);
  return String(max + 1).padStart(4, "0");
}

export type EnsurePartyByBizNoResult =
  | { ok: true; party: { id: string; name: string; code: string | null }; created: boolean }
  | { ok: false; message: string };

// 세금계산서의 사업자등록번호(bizNo) 기준으로 거래처를 찾거나 새로 만든다 — 이름 기준
// ensurePartyByName과 달리, 세금계산서 조회/업로드로 목록이 뜰 때마다 자동으로 호출된다.
// 이름이 같은 거래처가 이미 있는데 사업자번호가 없던 경우(수기 등록 등)엔 새로 만들지 않고
// 그 거래처에 사업자번호·코드를 채워준다.
export async function ensurePartyByBizNo(bizNo: string, name: string): Promise<EnsurePartyByBizNoResult> {
  await requireLoggedIn();
  // 들어오는 형식이 하이픈 유무로 갈리므로(엑셀=있음, 바로빌 API=없음) 항상 000-00-00000으로
  // 통일해서 저장·조회한다 — 안 그러면 같은 사업자가 형식만 달라 두 번 등록된다(실제로
  // 프로라인해운이 0001/0037로 중복 등록된 적 있음).
  const trimmedBizNo = formatBizNo(bizNo);
  const trimmedName = name.trim();
  if (!trimmedBizNo || !trimmedName) {
    return { ok: false, message: "사업자등록번호 또는 거래처명이 비어 있습니다." };
  }

  const existingByBizNo = await prisma.party.findUnique({ where: { bizNo: trimmedBizNo } });
  if (existingByBizNo) return { ok: true, party: existingByBizNo, created: false };

  const existingByName = await prisma.party.findUnique({ where: { name: trimmedName } });
  if (existingByName) {
    if (existingByName.bizNo && bizNoDigits(existingByName.bizNo) !== bizNoDigits(trimmedBizNo)) {
      // 이름은 같은데 이미 다른 사업자번호가 등록돼 있다 — 덮어쓰지 않고 그대로 사용.
      return { ok: true, party: existingByName, created: false };
    }
    if (existingByName.bizNo && existingByName.code) {
      return { ok: true, party: existingByName, created: false };
    }
    const updated = await prisma.party.update({
      where: { id: existingByName.id },
      data: {
        bizNo: existingByName.bizNo ?? trimmedBizNo,
        code: existingByName.code ?? (await nextPartyCode()),
        // 수기로 등록해뒀던 거래처라도, 실제 세금계산서 사업자번호와 매칭되는 순간부터는
        // 세금계산서 연동 거래처로 취급한다(삭제 제한 대상이 된다).
        source: "tax_invoice",
      },
    });
    revalidatePath("/parties");
    return { ok: true, party: updated, created: false };
  }

  try {
    const code = await nextPartyCode();
    const created = await prisma.party.create({ data: { name: trimmedName, bizNo: trimmedBizNo, code } });
    revalidatePath("/parties");
    return { ok: true, party: created, created: true };
  } catch {
    const retry = await prisma.party.findUnique({ where: { bizNo: trimmedBizNo } });
    if (retry) return { ok: true, party: retry, created: false };
    return { ok: false, message: "거래처 자동등록에 실패했습니다." };
  }
}

// 세금계산서 목록(조회/엑셀업로드)에 나온 공급자/공급받는자들을 한 번에 거래처 마스터에
// 반영한다 — 이미 있는 사업자번호는 건드리지 않고, 없는 것만 순서대로(한 번에 하나씩) 새로
// 만든다. Promise.all로 동시에 돌리면 채번(nextPartyCode)이 겹칠 수 있어 반드시 순차 실행.
//
// staffEmail(세금계산서에 적힌 "우리 쪽" 담당자 이메일 — barobill.ts의 ourStaffEmail)이
// 있고 거래처에 아직 담당자 이메일이 없으면 그걸로 채운다(2026-08-31, "sol-mate엔 이메일이
// 나온다"는 지적을 확인해보니 API 응답에 이미 있던 값이었다). 이미 담당자가 지정된
// 거래처는 절대 덮어쓰지 않는다 — 열람권한을 좌우하는 값이라 실수로 바뀌면 안 된다. 같은
// 거래처가 이번 배치에 여러 번 나오면(다른 세금계산서에서 담당자가 다를 수 있다) 작성일자가
// 가장 최근인 것을 쓴다.
export async function ensurePartiesFromTaxInvoiceRows(
  entries: { corpNum: string; corpName: string; staffEmail?: string; writeDate?: string }[]
): Promise<void> {
  const user = await requireLoggedIn();
  const distinct = new Map<string, { name: string; staffEmail: string; writeDate: string }>();
  for (const e of entries) {
    const bizNo = formatBizNo(e.corpNum); // 하이픈 유무와 무관하게 000-00-00000으로 통일해서 대조
    const name = e.corpName.trim();
    if (!bizNo || !name) continue;
    const staffEmail = (e.staffEmail ?? "").trim();
    const writeDate = e.writeDate ?? "";
    const current = distinct.get(bizNo);
    if (!current) {
      distinct.set(bizNo, { name, staffEmail, writeDate });
    } else if (staffEmail && writeDate > current.writeDate) {
      distinct.set(bizNo, { name: current.name, staffEmail, writeDate });
    }
  }
  if (distinct.size === 0) return;

  const existing = await prisma.party.findMany({
    where: { bizNo: { in: [...distinct.keys()] } },
    select: { id: true, bizNo: true, email: true, contactName: true, contactPhone: true },
  });
  const existingByBizNo = new Map(existing.map((p) => [p.bizNo as string, p]));

  for (const [bizNo, info] of distinct) {
    const party = existingByBizNo.get(bizNo);
    if (!party) {
      const created = await ensurePartyByBizNo(bizNo, info.name);
      if (created.ok && info.staffEmail) {
        await fillPartyStaffEmail(created.party.id, info.staffEmail, user.email);
      }
      continue;
    }
    if (!party.email && info.staffEmail) {
      await fillPartyStaffEmail(party.id, info.staffEmail, user.email, {
        contactName: party.contactName,
        contactPhone: party.contactPhone,
      });
    }
  }
}

// 거래처에 담당자 이메일이 아직 없을 때만 세금계산서에서 찾은 값으로 채우고, 다른
// 수정과 똑같이 이력을 남긴다(누가 왜 바뀐 게 아니라 "세금계산서 데이터에서 자동으로
// 채워졌다"는 사실을 남긴다) — updatePartyContact와 달리 관리자가 아니어도(세금계산서를
// 조회한 사람이면 누구나) 실행되지만, **비어있을 때만** 쓰기 때문에 자기 이메일로
// 임의로 덮어쓸 수는 없다(진짜 세금계산서에 그 사람 이메일이 담당자로 찍혀 있어야 한다).
async function fillPartyStaffEmail(
  partyId: string,
  staffEmail: string,
  triggeredByEmail: string,
  previous: { contactName: string | null; contactPhone: string | null } = { contactName: null, contactPhone: null }
): Promise<void> {
  const email = staffEmail.toLowerCase();
  await prisma.$transaction([
    prisma.party.update({ where: { id: partyId }, data: { email } }),
    prisma.partyContactEditHistory.create({
      data: {
        partyId,
        previousContactName: previous.contactName,
        previousContactPhone: previous.contactPhone,
        previousEmail: null,
        newContactName: previous.contactName,
        newContactPhone: previous.contactPhone,
        newEmail: email,
        reason: `세금계산서 담당자 이메일 자동 연동 (조회: ${triggeredByEmail})`,
        isInitial: !previous.contactName && !previous.contactPhone,
        changedByEmail: "system",
      },
    }),
  ]);
  revalidatePath("/parties");
}

export type PartyContactEditHistoryEntry = {
  previousContactName: string | null;
  previousContactPhone: string | null;
  previousEmail: string | null;
  newContactName: string | null;
  newContactPhone: string | null;
  newEmail: string | null;
  reason: string;
  isInitial: boolean;
  changedByEmail: string;
  createdAt: string;
};

export type UpdatePartyContactResult =
  | { ok: true; contactName: string | null; contactPhone: string | null; email: string | null }
  | { ok: false; message: string };

// 거래처 담당자 정보(담당자명·연락처·이메일) 수정 — 바뀔 때마다 수정 전/후 값과 사유를
// PartyContactEditHistory에 남긴다.
//  - 세 값이 **모두 비어있던 상태에서 처음 채우는 것**은 "초기설정"으로 기록하고 사유를
//    받지 않는다(사용자가 매번 "초기설정"이라고 타이핑할 필요 없게).
//  - 그 뒤 수정은 사유를 반드시 받는다 — 담당자 이메일은 세금계산서 열람권한을 좌우하는
//    값이라 누가 왜 바꿨는지 남는 게 중요하다.
// admin만 수정 가능한 이유도 같다: 아무나 자기 이메일을 아무 거래처에 걸어 열람권한을
// 얻을 수 없어야 한다.
export async function updatePartyContact(input: {
  partyId: string;
  contactName: string;
  contactPhone: string;
  email: string;
  reason: string;
}): Promise<UpdatePartyContactResult> {
  const user = await getCurrentUserFresh();
  if (user?.role !== "admin") {
    return { ok: false, message: "담당자 정보는 관리자만 수정할 수 있습니다." };
  }

  const party = await prisma.party.findUnique({ where: { id: input.partyId } });
  if (!party) return { ok: false, message: "이미 삭제된 거래처입니다." };

  const contactName = input.contactName.trim() || null;
  const contactPhone = input.contactPhone.trim() || null;
  const email = input.email.trim() || null;

  const wasEmpty = !party.contactName && !party.contactPhone && !party.email;
  const unchanged =
    contactName === party.contactName && contactPhone === party.contactPhone && email === party.email;
  if (unchanged) return { ok: false, message: "변경된 내용이 없습니다." };

  const reason = input.reason.trim();
  if (!wasEmpty && !reason) return { ok: false, message: "수정 사유를 입력하세요." };

  await prisma.$transaction([
    prisma.party.update({ where: { id: party.id }, data: { contactName, contactPhone, email } }),
    prisma.partyContactEditHistory.create({
      data: {
        partyId: party.id,
        previousContactName: party.contactName,
        previousContactPhone: party.contactPhone,
        previousEmail: party.email,
        newContactName: contactName,
        newContactPhone: contactPhone,
        newEmail: email,
        reason: wasEmpty ? "초기설정" : reason,
        isInitial: wasEmpty,
        changedByEmail: user.email,
      },
    }),
  ]);

  revalidatePath("/parties");
  return { ok: true, contactName, contactPhone, email };
}

export async function getPartyContactHistory(
  partyId: string
): Promise<{ ok: true; entries: PartyContactEditHistoryEntry[] } | { ok: false; message: string }> {
  const user = await getCurrentUserFresh();
  if (user?.role !== "admin") return { ok: false, message: "관리자만 볼 수 있습니다." };

  const rows = await prisma.partyContactEditHistory.findMany({
    where: { partyId },
    orderBy: { createdAt: "desc" },
  });
  return {
    ok: true,
    entries: rows.map((r) => ({
      previousContactName: r.previousContactName,
      previousContactPhone: r.previousContactPhone,
      previousEmail: r.previousEmail,
      newContactName: r.newContactName,
      newContactPhone: r.newContactPhone,
      newEmail: r.newEmail,
      reason: r.reason,
      isInitial: r.isInitial,
      changedByEmail: r.changedByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function deleteParty(formData: FormData): Promise<DeleteActionResult> {
  await requirePartiesAccess();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  const party = await prisma.party.findUnique({ where: { id }, select: { source: true } });
  if (!party) return { ok: false, reason: "not_found" };
  // 세금계산서 조회/업로드나 PDF 인식으로 자동 등록된 거래처는 삭제할 수 없다 — 거래처
  // 관리 화면에서 사람이 직접 등록한 것만 지울 수 있다(2026-08-27).
  if (party.source !== "manual") return { ok: false, reason: "from_tax_invoice" };

  const [saleCount, purchaseCount] = await Promise.all([
    prisma.sale.count({ where: { partyId: id } }),
    prisma.purchase.count({ where: { partyId: id } }),
  ]);
  if (saleCount > 0 || purchaseCount > 0) return { ok: false, reason: "in_use" };

  await prisma.party.delete({ where: { id } });
  revalidatePath("/parties");
  return { ok: true };
}
