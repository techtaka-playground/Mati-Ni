import { prisma } from "@/lib/prisma";
import { matchPartyForRemark, type PartyLite } from "@/lib/bankPartyMatch";

// 전표(매출/매입B/L배분/관세대납) ↔ 은행거래 사이의 **실제 배분**을 다루는 공용 모듈
// (2026-08-31, bankMatch.ts의 그 자리 계산식 매칭을 대체).
//
// 예전에는 "금액이 똑같은 은행거래가 있나"를 매번 그 자리에서 계산만 했다 — 그래서 부분입금·
// 분할출금처럼 금액이 정확히 안 맞는 경우를 표현할 방법이 없었고, 사람이 "이게 그 거래다"라고
// 직접 지정할 수도 없었다. 이제는 그 연결을 `BankAllocation`에 저장한다.
//
// **자동 매칭은 "완전히 미배분인 대상"에만, 정확히 같은 금액인 경우에만** 시도한다(예전
// 계산식과 같은 규칙). 하나라도 배분이 생기면(자동이든 수기든) 그 대상은 더 이상 자동매칭
// 대상이 아니다 — 남은 금액을 채우는 건 전부 수기 매칭의 몫이다. 그래서 세액(VAT) 후보 계산이
// "전액 미배분" 상황에서만 필요해 예전 로직보다 단순하다.
//
// 매입은 B/L별 배분(PurchaseAllocation) 단위로 매칭한다 — 세금계산서 부가세는 전표(매입) 전체
// 합계라 특정 B/L 하나에 몰아 붙일 근거가 없으므로, 매입은 **공급가액(배분액) 그대로 일치하는
// 경우만** 자동매칭 후보로 삼는다. 부가세를 포함한 금액이나 여러 B/L에 걸친 출금은 수기 매칭으로
// 사람이 직접 나눠 배분한다.

// customsAdvance는 출금(대납 지급), customsAdvanceRecovery는 입금(회수) — 같은
// CustomsAdvance 행을 가리키지만 방향이 반대인 별개의 배분 대상이다(2026-09-03 추가,
// 관세전표 입금 매칭). 하나의 kind가 항상 한 방향으로만 고정되는 게 이 모듈 전체의 전제라서
// (directionForKind가 그 전제 위에 있다) "customsAdvance"를 양방향으로 겹쳐 쓰지 않고
// 새 kind를 추가했다.
export type AllocationKind = "sale" | "purchaseAllocation" | "customsAdvance" | "customsAdvanceRecovery";

// 금액은 원 단위 정수라 반올림 오차만 허용한다.
const EPS = 0.5;

export function directionForKind(kind: AllocationKind): "deposit" | "withdraw" {
  return kind === "sale" || kind === "customsAdvanceRecovery" ? "deposit" : "withdraw";
}

// "YYYYMMDDHHMMSS" → "YYYY-MM-DD"
function toDate(transDT: string): string {
  const d = transDT.replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : transDT;
}

export type AllocationDetail = {
  id: string;
  transRefKey: string;
  amount: number;
  date: string;
  auto: boolean;
  createdByEmail: string;
};

// 배치로 여러 대상의 배분 내역을 읽어온다 — 화면 하나에 수십~수백 행이 있어 대상마다 따로
// 쿼리하면 느리다.
export async function getAllocationsByTargets(
  kind: AllocationKind,
  targetIds: string[]
): Promise<Map<string, AllocationDetail[]>> {
  const out = new Map<string, AllocationDetail[]>();
  if (targetIds.length === 0) return out;
  const rows = await prisma.bankAllocation.findMany({
    where: { kind, targetId: { in: targetIds } },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return out;
  const transRefKeys = [...new Set(rows.map((r) => r.transRefKey))];
  const bankRows = await prisma.bankTransaction.findMany({
    where: { transRefKey: { in: transRefKeys } },
    select: { transRefKey: true, transDT: true },
  });
  const dateByKey = new Map(bankRows.map((b) => [b.transRefKey, toDate(b.transDT)]));
  for (const r of rows) {
    const list = out.get(r.targetId) ?? [];
    list.push({
      id: r.id,
      transRefKey: r.transRefKey,
      amount: r.amount,
      date: dateByKey.get(r.transRefKey) ?? "",
      auto: r.auto,
      createdByEmail: r.createdByEmail,
    });
    out.set(r.targetId, list);
  }
  return out;
}

export function sumAllocated(details: AllocationDetail[] | undefined): number {
  return (details ?? []).reduce((s, d) => s + d.amount, 0);
}

export function isFullyAllocated(amount: number, allocated: number): boolean {
  return allocated >= amount - EPS;
}

// 예전 BankMatchBasis와 같은 개념 — 배분 합계가 전표 금액(공급가액) 그대로인지, 부가세가
// 더해진 금액인지. 여러 은행거래에 나눠 배분됐어도 합계만 보면 되므로 그대로 재사용한다.
export type AllocBasis = "supply" | "withVat";
export function basisFor(amount: number, allocatedTotal: number): AllocBasis {
  return Math.round(allocatedTotal) === Math.round(amount) ? "supply" : "withVat";
}

// ── 자동 매칭 — 완전히 미배분인 대상만, 정확히 같은 금액일 때만 ──────────────────────────

export type AutoMatchEntry = {
  kind: AllocationKind;
  targetId: string;
  amount: number;
  partyId: string | null;
  // 세액 조회용 — sale/customsAdvance만 의미가 있다(purchaseAllocation은 공급가액 후보만 시도).
  ntsSendKey: string | null;
};

// 세금계산서 원본에 남은 실제 세액을 부가세 포함 후보로 쓴다(10%를 곱하는 추정이 아니다 —
// 영세율·면세가 섞이면 추정이 틀린다). bankMatch.ts의 taxAmountFor와 같은 규칙.
async function loadTaxByKey(ntsSendKeys: string[]): Promise<Map<string, number>> {
  const keys = [...new Set(ntsSendKeys)];
  if (keys.length === 0) return new Map();
  const rows = await prisma.taxInvoiceRecord.findMany({
    where: { ntsSendKey: { in: keys } },
    select: { ntsSendKey: true, taxTotal: true },
  });
  return new Map(rows.map((r) => [r.ntsSendKey, r.taxTotal]));
}

// 아직 배분이 하나도 없는 대상들에 대해, "확정"된 은행거래 중 정확히 같은 금액·같은 거래처인
// 것을 찾아 자동으로 BankAllocation을 만든다. 일반전표/관세전표 페이지를 열 때마다 호출한다
// (예전 createBankMatcher를 부르던 자리를 대체).
export async function runAutoMatch(entries: AutoMatchEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const byKind = new Map<AllocationKind, string[]>();
  for (const e of entries) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.targetId]);

  const allocatedMaps = new Map<AllocationKind, Map<string, AllocationDetail[]>>();
  for (const [kind, ids] of byKind) allocatedMaps.set(kind, await getAllocationsByTargets(kind, ids));

  const unallocated = entries.filter((e) => (allocatedMaps.get(e.kind)?.get(e.targetId)?.length ?? 0) === 0 && e.partyId);
  if (unallocated.length === 0) return;

  const taxByKey = await loadTaxByKey(
    unallocated.filter((e) => e.kind !== "purchaseAllocation").map((e) => e.ntsSendKey ?? "").filter(Boolean)
  );

  const [confirmedRows, parties, aliasRows] = await Promise.all([
    prisma.bankTransactionConfirm.findMany({ where: { status: "confirmed" }, select: { transRefKey: true } }),
    prisma.party.findMany({ select: { id: true, code: true, name: true } }),
    prisma.bankPartyAlias.findMany({ include: { party: { select: { id: true, code: true, name: true } } } }),
  ]);
  const confirmedKeys = confirmedRows.map((c) => c.transRefKey);
  if (confirmedKeys.length === 0) return;

  const [bankRows, existingAllocs] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { transRefKey: { in: confirmedKeys } }, orderBy: { transDT: "asc" } }),
    prisma.bankAllocation.findMany({ where: { transRefKey: { in: confirmedKeys } }, select: { transRefKey: true, amount: true } }),
  ]);
  const consumedByKey = new Map<string, number>();
  for (const a of existingAllocs) consumedByKey.set(a.transRefKey, (consumedByKey.get(a.transRefKey) ?? 0) + a.amount);
  const aliases = new Map<string, PartyLite>(aliasRows.map((a) => [a.normalized, a.party]));

  const bank = bankRows.map((b) => ({
    transRefKey: b.transRefKey,
    deposit: b.deposit,
    withdraw: b.withdraw,
    remaining: (b.deposit > 0 ? b.deposit : b.withdraw) - (consumedByKey.get(b.transRefKey) ?? 0),
    partyId: matchPartyForRemark(b.transRemark, parties, aliases)?.id ?? null,
  }));

  const toCreate: { transRefKey: string; kind: AllocationKind; targetId: string; amount: number }[] = [];
  for (const e of unallocated) {
    const dir = directionForKind(e.kind);
    const tax = e.kind === "purchaseAllocation" ? null : (taxByKey.get(e.ntsSendKey ?? "") ?? null);
    const candidates: number[] = [];
    if (tax != null && Math.round(tax) !== 0) candidates.push(e.amount + tax);
    candidates.push(e.amount);

    for (const value of candidates) {
      const hit = bank.find(
        (b) =>
          b.partyId === e.partyId &&
          (dir === "deposit" ? b.deposit > 0 : b.withdraw > 0) &&
          Math.round(b.remaining) === Math.round(value) &&
          !toCreate.some((t) => t.transRefKey === b.transRefKey)
      );
      if (hit) {
        toCreate.push({ transRefKey: hit.transRefKey, kind: e.kind, targetId: e.targetId, amount: value });
        break;
      }
    }
  }
  if (toCreate.length > 0) {
    await prisma.bankAllocation.createMany({
      data: toCreate.map((t) => ({ ...t, auto: true, createdByEmail: "system" })),
    });
  }
}

// ── 수기 매칭 ────────────────────────────────────────────────────────────────────────

export type MatchCandidate = {
  transRefKey: string;
  date: string;
  remark: string;
  amount: number; // 그 거래의 원래 입금/출금액
  remaining: number; // 아직 배분에 안 쓰인 잔액
  partyMatched: boolean;
};

// 수기 매칭 팝업의 후보 목록 — "확정"된 거래 중 아직 잔액이 남은 것만, 거래처 일치 우선·
// 최신순으로 보여준다. search가 있으면 적요(송금인) 문자열로도 좁힌다.
export async function searchMatchCandidates(
  direction: "deposit" | "withdraw",
  opts: { partyId?: string | null; search?: string } = {}
): Promise<MatchCandidate[]> {
  const confirmedRows = await prisma.bankTransactionConfirm.findMany({
    where: { status: "confirmed" },
    select: { transRefKey: true },
  });
  const keys = confirmedRows.map((c) => c.transRefKey);
  if (keys.length === 0) return [];

  const [bankRows, allocRows, parties, aliasRows] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        transRefKey: { in: keys },
        ...(direction === "deposit" ? { deposit: { gt: 0 } } : { withdraw: { gt: 0 } }),
      },
      orderBy: { transDT: "desc" },
    }),
    prisma.bankAllocation.findMany({ where: { transRefKey: { in: keys } }, select: { transRefKey: true, amount: true } }),
    prisma.party.findMany({ select: { id: true, code: true, name: true } }),
    prisma.bankPartyAlias.findMany({ include: { party: { select: { id: true, code: true, name: true } } } }),
  ]);
  const consumedByKey = new Map<string, number>();
  for (const a of allocRows) consumedByKey.set(a.transRefKey, (consumedByKey.get(a.transRefKey) ?? 0) + a.amount);
  const aliases = new Map<string, PartyLite>(aliasRows.map((a) => [a.normalized, a.party]));

  const search = opts.search?.trim().toLowerCase();
  const out: MatchCandidate[] = [];
  for (const b of bankRows) {
    const total = direction === "deposit" ? b.deposit : b.withdraw;
    const remaining = total - (consumedByKey.get(b.transRefKey) ?? 0);
    if (remaining <= EPS) continue;
    if (search && !b.transRemark.toLowerCase().includes(search)) continue;
    const partyId = matchPartyForRemark(b.transRemark, parties, aliases)?.id ?? null;
    out.push({
      transRefKey: b.transRefKey,
      date: toDate(b.transDT),
      remark: b.transRemark,
      amount: total,
      remaining,
      partyMatched: opts.partyId != null && partyId === opts.partyId,
    });
  }
  out.sort((a, b) => (a.partyMatched === b.partyMatched ? 0 : a.partyMatched ? -1 : 1));
  return out.slice(0, 100);
}

export type AllocationActionResult = { ok: true } | { ok: false; message: string };

async function getTargetState(
  kind: AllocationKind,
  targetId: string
): Promise<{ amount: number; confirmedAt: Date | null; currency: string } | null> {
  if (kind === "sale") {
    const s = await prisma.sale.findUnique({
      where: { id: targetId },
      select: { amount: true, settlementConfirmedAt: true, currency: true },
    });
    return s ? { amount: s.amount, confirmedAt: s.settlementConfirmedAt, currency: s.currency } : null;
  }
  if (kind === "purchaseAllocation") {
    // 통화는 배분(PurchaseAllocation)이 아니라 그 부모 Purchase에 있다 — B/L 1개 = 전액 배분인
    // 수기입력에서만 외화가 들어오므로 이 경로에서는 항상 그 부모 하나뿐이다.
    const a = await prisma.purchaseAllocation.findUnique({
      where: { id: targetId },
      select: { amount: true, settlementConfirmedAt: true, purchase: { select: { currency: true } } },
    });
    return a
      ? { amount: a.amount, confirmedAt: a.settlementConfirmedAt, currency: a.purchase.currency }
      : null;
  }
  if (kind === "customsAdvanceRecovery") {
    // 같은 CustomsAdvance 행이지만 입금(회수) 쪽은 별도 확정 필드를 본다 — 출금 확정 여부와
    // 무관하게 독립적으로 배분·확정된다.
    const c = await prisma.customsAdvance.findUnique({
      where: { id: targetId },
      select: { amount: true, depositConfirmedAt: true, currency: true },
    });
    return c ? { amount: c.amount, confirmedAt: c.depositConfirmedAt, currency: c.currency } : null;
  }
  const c = await prisma.customsAdvance.findUnique({
    where: { id: targetId },
    select: { amount: true, settlementConfirmedAt: true, currency: true },
  });
  return c ? { amount: c.amount, confirmedAt: c.settlementConfirmedAt, currency: c.currency } : null;
}

export { getTargetState as getAllocationTargetState };

export async function createManualAllocation(
  kind: AllocationKind,
  targetId: string,
  transRefKey: string,
  amount: number,
  createdByEmail: string
): Promise<AllocationActionResult> {
  if (!(amount > 0)) return { ok: false, message: "배분 금액을 입력하세요." };

  const target = await getTargetState(kind, targetId);
  if (!target) return { ok: false, message: "대상을 찾을 수 없습니다." };
  if (target.confirmedAt) return { ok: false, message: "이미 확정된 건입니다. 먼저 확정을 해제하세요." };

  const confirm = await prisma.bankTransactionConfirm.findUnique({ where: { transRefKey } });
  if (!confirm || confirm.status !== "confirmed") {
    return { ok: false, message: "입출금내역에서 확정된 거래만 배분할 수 있습니다." };
  }
  const bankTx = await prisma.bankTransaction.findUnique({ where: { transRefKey } });
  if (!bankTx) return { ok: false, message: "은행 거래를 찾을 수 없습니다." };

  const dir = directionForKind(kind);
  const txTotal = dir === "deposit" ? bankTx.deposit : bankTx.withdraw;

  const [targetAgg, txAgg, fxAgg] = await Promise.all([
    prisma.bankAllocation.aggregate({ where: { kind, targetId }, _sum: { amount: true } }),
    prisma.bankAllocation.aggregate({ where: { transRefKey }, _sum: { amount: true } }),
    prisma.fxAdjustment.aggregate({ where: { kind, targetId }, _sum: { amount: true } }),
  ]);
  // 환차손익으로 이미 정리된 몫만큼은 은행거래로도 못 채운다 — 전표 총액을 두 번 채우면 안 되니까.
  const targetRemaining = target.amount - (targetAgg._sum.amount ?? 0) - (fxAgg._sum.amount ?? 0);
  const txRemaining = txTotal - (txAgg._sum.amount ?? 0);

  if (amount > targetRemaining + EPS) {
    return { ok: false, message: `배분 금액이 전표 잔액(${Math.round(targetRemaining).toLocaleString()}원)을 초과합니다.` };
  }
  if (amount > txRemaining + EPS) {
    return { ok: false, message: `배분 금액이 은행거래 잔액(${Math.round(txRemaining).toLocaleString()}원)을 초과합니다.` };
  }

  await prisma.bankAllocation.create({ data: { transRefKey, kind, targetId, amount, auto: false, createdByEmail } });
  return { ok: true };
}

export async function deleteAllocation(id: string): Promise<AllocationActionResult> {
  const alloc = await prisma.bankAllocation.findUnique({ where: { id } });
  if (!alloc) return { ok: false, message: "배분 내역을 찾을 수 없습니다." };
  const target = await getTargetState(alloc.kind as AllocationKind, alloc.targetId);
  if (target?.confirmedAt) return { ok: false, message: "확정된 건은 먼저 확정을 해제해야 배분을 취소할 수 있습니다." };
  await prisma.bankAllocation.delete({ where: { id } });
  return { ok: true };
}

// ── 환차손익 정리 — 외화 전표의 남은 차액을 은행거래 없이 직접 정리한다 ──────────────────
//
// BankAllocation과 달리 실제 은행거래(transRefKey)가 없다 — "이 만큼은 환율 차이로 설명된다"는
// 사람의 판단을 기록할 뿐이다. 그래서 화면에 보여줄 때(customs.ts·vouchers/page.tsx)는
// BankAllocation 합계에 이 합계를 더해서 "배분 완료"로 친다.

export type FxAdjustmentDetail = {
  id: string;
  amount: number;
  note: string;
  date: string; // 정리한 날짜(createdAt) — AllocationDetail.date와 같은 자리에 쓰기 위해 형식을 맞춘다
  createdByEmail: string;
};

export async function getFxAdjustmentsByTargets(
  kind: AllocationKind,
  targetIds: string[]
): Promise<Map<string, FxAdjustmentDetail[]>> {
  const out = new Map<string, FxAdjustmentDetail[]>();
  if (targetIds.length === 0) return out;
  const rows = await prisma.fxAdjustment.findMany({
    where: { kind, targetId: { in: targetIds } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const list = out.get(r.targetId) ?? [];
    list.push({
      id: r.id,
      amount: r.amount,
      note: r.note,
      date: r.createdAt.toISOString().slice(0, 10),
      createdByEmail: r.createdByEmail,
    });
    out.set(r.targetId, list);
  }
  return out;
}

export function sumFxAdjusted(details: FxAdjustmentDetail[] | undefined): number {
  return (details ?? []).reduce((s, d) => s + d.amount, 0);
}

// 남은 미배분 잔액 **전액**을 환차손익으로 정리한다(부분 정리는 지원하지 않는다 — 얼마가
// 남았는지는 서버가 다시 계산해서 쓰지, 클라이언트가 보낸 금액을 믿지 않는다). 외화 전표에만
// 쓸 수 있다 — KRW 전표는 은행 매칭이 안 되는 이유가 환율 차이일 수 없으므로 이 창구를 쓸
// 이유가 없다. 사유 입력은 실제 배분 액션(매칭 팝업)에 곧바로 딸린 체크박스라 굳이 따로
// 받지 않는다(2026-09-03, 처음엔 필수 입력칸이 있었는데 번거롭다는 피드백에 따라 없앰).
export async function createFxAdjustment(
  kind: AllocationKind,
  targetId: string,
  createdByEmail: string
): Promise<AllocationActionResult> {
  const target = await getTargetState(kind, targetId);
  if (!target) return { ok: false, message: "대상을 찾을 수 없습니다." };
  if (target.confirmedAt) return { ok: false, message: "이미 확정된 건입니다. 먼저 확정을 해제하세요." };
  if (target.currency === "KRW") return { ok: false, message: "외화로 입력된 건만 환차손익으로 처리할 수 있습니다." };

  const [bankAgg, fxAgg] = await Promise.all([
    prisma.bankAllocation.aggregate({ where: { kind, targetId }, _sum: { amount: true } }),
    prisma.fxAdjustment.aggregate({ where: { kind, targetId }, _sum: { amount: true } }),
  ]);
  const remaining = target.amount - (bankAgg._sum.amount ?? 0) - (fxAgg._sum.amount ?? 0);
  if (remaining <= EPS) return { ok: false, message: "이미 전액 배분되어 정리할 차액이 없습니다." };

  await prisma.fxAdjustment.create({
    data: { kind, targetId, amount: remaining, note: "", createdByEmail },
  });
  return { ok: true };
}

export async function deleteFxAdjustment(id: string): Promise<AllocationActionResult> {
  const adj = await prisma.fxAdjustment.findUnique({ where: { id } });
  if (!adj) return { ok: false, message: "환차손익 정리 내역을 찾을 수 없습니다." };
  const target = await getTargetState(adj.kind as AllocationKind, adj.targetId);
  if (target?.confirmedAt) return { ok: false, message: "확정된 건은 먼저 확정을 해제해야 취소할 수 있습니다." };
  await prisma.fxAdjustment.delete({ where: { id } });
  return { ok: true };
}

// ── 입출금내역 화면의 "전표연동" 칸 ──────────────────────────────────────────────────

// count = 이 은행거래에 연동된 **서로 다른 전표(대상) 수** — 같은 전표에 여러 번 나눠
// 배분해도(부분 매칭을 여러 번 한 경우) 1건으로 센다. label은 짧은 화면 표시용, 여러 건이면
// count까지 반영한 문구다(count===1이면 어느 전표인지 이름까지 담는다).
export type BankTransactionLink = { kind: "voucher" | "customs"; label: string; count: number };

export async function getBankTransactionLinks(): Promise<Record<string, BankTransactionLink>> {
  const allocs = await prisma.bankAllocation.findMany();
  if (allocs.length === 0) return {};

  const byKey = new Map<string, typeof allocs>();
  for (const a of allocs) byKey.set(a.transRefKey, [...(byKey.get(a.transRefKey) ?? []), a]);

  const saleIds = allocs.filter((a) => a.kind === "sale").map((a) => a.targetId);
  const paIds = allocs.filter((a) => a.kind === "purchaseAllocation").map((a) => a.targetId);
  // customsAdvance(출금)·customsAdvanceRecovery(입금)는 같은 CustomsAdvance 행을 가리키므로
  // 이름 조회는 하나로 합친다.
  const caIds = allocs
    .filter((a) => a.kind === "customsAdvance" || a.kind === "customsAdvanceRecovery")
    .map((a) => a.targetId);
  const [sales, pas, cas] = await Promise.all([
    saleIds.length
      ? prisma.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, party: { select: { name: true } } } })
      : Promise.resolve([]),
    paIds.length
      ? prisma.purchaseAllocation.findMany({
          where: { id: { in: paIds } },
          select: { id: true, purchase: { select: { party: { select: { name: true } } } } },
        })
      : Promise.resolve([]),
    caIds.length
      ? prisma.customsAdvance.findMany({
          where: { id: { in: caIds } },
          select: {
            id: true,
            payeeParty: { select: { name: true } },
            party: { select: { name: true } },
            sale: { select: { party: { select: { name: true } } } },
          },
        })
      : Promise.resolve([]),
  ]);
  const saleName = new Map(sales.map((s) => [s.id, s.party.name]));
  const paName = new Map(pas.map((p) => [p.id, p.purchase.party.name]));
  const caName = new Map(cas.map((c) => [c.id, c.payeeParty?.name ?? c.party?.name ?? c.sale?.party.name ?? ""]));

  function labelFor(a: (typeof allocs)[number]): { kind: "voucher" | "customs"; text: string } {
    if (a.kind === "sale") return { kind: "voucher", text: `일반전표(매출) · ${saleName.get(a.targetId) ?? ""}` };
    if (a.kind === "purchaseAllocation") return { kind: "voucher", text: `일반전표(매입) · ${paName.get(a.targetId) ?? ""}` };
    return { kind: "customs", text: `관세전표 · ${caName.get(a.targetId) ?? ""}` };
  }

  const links: Record<string, BankTransactionLink> = {};
  for (const [transRefKey, list] of byKey) {
    // 부분 매칭을 여러 번 나눠 했을 수 있으므로, "몇 건과 연동됐나"는 배분 행 수가 아니라
    // 서로 다른 (kind, targetId) 조합 수로 센다 — 안 그러면 전표 1건에 3번 나눠 배분한 것도
    // "3건 연동"으로 보여 실제보다 부풀려진다.
    const distinct = new Map<string, (typeof list)[number]>();
    for (const a of list) distinct.set(`${a.kind}-${a.targetId}`, a);
    const targets = [...distinct.values()];

    if (targets.length === 1) {
      const l = labelFor(targets[0]);
      links[transRefKey] = { kind: l.kind, label: l.text, count: 1 };
    } else {
      const hasVoucher = targets.some((a) => a.kind === "sale" || a.kind === "purchaseAllocation");
      links[transRefKey] = {
        kind: hasVoucher ? "voucher" : "customs",
        label: `전표 ${targets.length}건 연동`,
        count: targets.length,
      };
    }
  }
  return links;
}
