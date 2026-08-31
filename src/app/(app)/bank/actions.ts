"use server";

import {
  getBankAccounts,
  getPeriodBankAccountLog,
  type BankAccount,
  type BankLogRow,
} from "@/lib/barobillBank";
import { getCurrentUserFresh } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import {
  matchPartyForRemark,
  normalizeRemarkForMatch,
  type MatchedParty,
  type PartyLite,
} from "@/lib/bankPartyMatch";
import { getBankTransactionLinks, type BankTransactionLink } from "@/lib/bankAllocation";
export type { BankTransactionLink } from "@/lib/bankAllocation";

// proxy.ts는 "로그인 됐는가"만 확인하므로, 입출금내역 열람 권한은 Server Action 안에서도
// 다시 확인한다(세금계산서 쪽 getTaxInvoiceUser와 같은 이유).
type BankLogUser = { email: string; role: string };
async function getBankLogUser(): Promise<BankLogUser | null> {
  const user = await getCurrentUserFresh();
  if (!user?.canViewBankLogs) return null;
  return { email: user.email, role: user.role };
}

export type ListBankAccountsResult =
  | { ok: true; accounts: BankAccount[] }
  | { ok: false; message: string };

export async function listBankAccounts(): Promise<ListBankAccountsResult> {
  if (!(await getBankLogUser())) return { ok: false, message: "입출금내역 열람 권한이 없습니다." };
  try {
    return { ok: true, accounts: await getBankAccounts(true) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "계좌 목록 조회 중 오류가 발생했습니다." };
  }
}

// 거래 1건의 검토 상태. 행이 없으면 "미확정"이다.
//  confirmed — 내용 확인 완료
//  excluded  — 대조 대상 아님(이자·내부이체 등). **미확정 집계에서 빠진다.**
export type BankTxStatus = "confirmed" | "excluded";
export type StatusInfo = {
  status: BankTxStatus;
  reason: string;
  confirmedAt: string;
  confirmedByEmail: string;
};

export type SearchBankLogResult =
  // matches: 송금인/적요 원본 문자열 → 매칭된 거래처. 정규화 규칙을 화면에서 다시 구현하지 않도록
  // 서버에서 계산해 내려준다(같은 규칙을 두 곳에 두면 언젠가 어긋난다).
  | {
      ok: true;
      rows: BankLogRow[];
      truncated: boolean;
      matches: Record<string, MatchedParty>;
      // TransRefKey → 검토 상태. 상태가 없는 거래는 키 자체가 없다(= 미확정).
      statuses: Record<string, StatusInfo>;
      // TransRefKey → 연동된 전표(관세전표/일반전표). 없는 거래는 키 자체가 없다(= 미연동).
      links: Record<string, BankTransactionLink>;
    }
  | { ok: false; message: string };

async function loadStatuses(transRefKeys: string[]): Promise<Record<string, StatusInfo>> {
  const keys = [...new Set(transRefKeys.filter(Boolean))];
  if (keys.length === 0) return {};
  const rows = await prisma.bankTransactionConfirm.findMany({ where: { transRefKey: { in: keys } } });
  const out: Record<string, StatusInfo> = {};
  for (const r of rows) {
    out[r.transRefKey] = {
      // DB에 예상 못한 값이 들어와도 화면이 깨지지 않게 좁혀 읽는다.
      status: r.status === "excluded" ? "excluded" : "confirmed",
      reason: r.reason,
      confirmedAt: r.confirmedAt.toISOString(),
      confirmedByEmail: r.confirmedByEmail,
    };
  }
  return out;
}

// 거래처 마스터 + 사람이 지정해둔 별칭을 한 번에 읽어, 송금인 문자열마다 거래처를 붙인다.
async function buildRemarkMatches(remarks: string[]): Promise<Record<string, MatchedParty>> {
  const unique = [...new Set(remarks.filter(Boolean))];
  if (unique.length === 0) return {};

  const [parties, aliasRows] = await Promise.all([
    prisma.party.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.bankPartyAlias.findMany({ include: { party: { select: { id: true, code: true, name: true } } } }),
  ]);
  const aliases = new Map<string, PartyLite>(aliasRows.map((a) => [a.normalized, a.party]));

  const result: Record<string, MatchedParty> = {};
  for (const remark of unique) {
    const m = matchPartyForRemark(remark, parties, aliases);
    if (!m) continue;
    // 지정(alias)이 자동 매칭(이름 완전/부분일치)과 결과가 같다면 실제로 "고친" 게 아니라
    // 자동으로도 나왔을 값을 그대로 확인만 한 것이다 — 그때는 "(수정)"이 아니라 자동 매칭
    // 그대로의 표시(자동/추정)로 보여준다(2026-08-31, "실제로 고친 것만 수정으로 보이게
    // 해달라"는 요청에 따름).
    if (m.source === "alias") {
      const auto = matchPartyForRemark(remark, parties, new Map());
      if (auto && auto.id === m.id) {
        result[remark] = auto;
        continue;
      }
    }
    result[remark] = m;
  }
  return result;
}

// 기간별 입출금내역 조회. 날짜는 화면에서 "YYYY-MM-DD"로 받아 바로빌이 요구하는 "YYYYMMDD"로
// 바꿔 보낸다.
export async function searchBankLog(input: {
  accountNum: string;
  startDate: string;
  endDate: string;
}): Promise<SearchBankLogResult> {
  if (!(await getBankLogUser())) return { ok: false, message: "입출금내역 열람 권한이 없습니다." };

  const accountNum = input.accountNum.trim();
  if (!accountNum) return { ok: false, message: "계좌를 선택하세요." };

  const start = input.startDate.replace(/-/g, "");
  const end = input.endDate.replace(/-/g, "");
  if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) {
    return { ok: false, message: "조회기간 형식이 올바르지 않습니다." };
  }
  if (start > end) return { ok: false, message: "시작일이 종료일보다 늦습니다." };

  try {
    const { rows, truncated } = await getPeriodBankAccountLog({
      accountNum,
      startDate: start,
      endDate: end,
    });
    // 받아온 거래를 로컬에 보관한다 — 관세전표 등 다른 화면이 "이 청구에 해당하는 실제 입금/출금이
    // 있나?"를 물어볼 수 있게 하려면 DB에 있어야 한다(BankTransaction 주석 참고).
    await syncBankTransactions(rows);

    const [matches, statuses, links] = await Promise.all([
      buildRemarkMatches(rows.map((r) => r.transRemark)),
      loadStatuses(rows.map((r) => r.transRefKey)),
      getBankTransactionLinks(),
    ]);
    return { ok: true, rows, truncated, matches, statuses, links };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "조회 중 오류가 발생했습니다." };
  }
}

export type SetBankPartyResult = { ok: true; matches: Record<string, MatchedParty> } | { ok: false; message: string };

// 송금인/적요 문자열에 거래처를 지정한다(또는 지정을 해제한다).
//
// 키가 거래 1건이 아니라 **송금인 이름**이라, 한 번 지정하면 같은 송금인의 과거·미래 거래에 모두
// 적용된다 — 같은 거래처에서 입금이 반복되는데 거래마다 다시 고르게 하면 쓸 수 없기 때문이다.
// 화면에도 그 사실을 밝혀둔다.
export async function setBankPartyAlias(input: {
  remark: string;
  partyId: string | null; // null이면 지정 해제(다시 자동 추정으로 돌아간다)
  remarks: string[]; // 지금 화면에 있는 송금인 목록 — 갱신된 매칭을 한 번에 돌려주기 위함
}): Promise<SetBankPartyResult> {
  if (!(await getBankLogUser())) return { ok: false, message: "입출금내역 열람 권한이 없습니다." };
  const raw = input.remark.trim();
  const normalized = normalizeRemarkForMatch(raw);
  if (!normalized) return { ok: false, message: "송금인/적요가 비어 있어 거래처를 지정할 수 없습니다." };

  try {
    if (!input.partyId) {
      await prisma.bankPartyAlias.deleteMany({ where: { normalized } });
    } else {
      // 거래처 마스터에 있는 거래처만 지정할 수 있다 — 화면에서 검색으로만 고르게 해뒀지만
      // Server Action은 직접 호출될 수 있어 여기서도 확인한다.
      const party = await prisma.party.findUnique({ where: { id: input.partyId }, select: { id: true } });
      if (!party) return { ok: false, message: "거래처를 찾을 수 없습니다 — 거래처 화면에서 먼저 등록해주세요." };
      await prisma.bankPartyAlias.upsert({
        where: { normalized },
        create: { normalized, raw, partyId: party.id },
        update: { raw, partyId: party.id },
      });
    }
    revalidatePath("/bank");
    return { ok: true, matches: await buildRemarkMatches(input.remarks) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "거래처 지정 중 오류가 발생했습니다." };
  }
}

// 조회 결과를 로컬 표에 upsert한다. 거래고유번호가 없는 응답은 건너뛴다 — 그 건은 나중에 같은
// 거래인지 알아볼 방법이 없어서 저장해도 중복만 쌓인다.
async function syncBankTransactions(rows: BankLogRow[]): Promise<void> {
  for (const r of rows) {
    const key = r.transRefKey?.trim();
    if (!key) continue;
    const data = {
      accountNum: r.accountNum,
      transDT: r.transDT,
      deposit: r.deposit,
      withdraw: r.withdraw,
      balance: r.balance,
      transType: r.transType,
      transOffice: r.transOffice,
      transRemark: r.transRemark,
      mgtRemark: [r.mgtRemark1, r.mgtRemark2].filter(Boolean).join(" / "),
      syncedAt: new Date(),
    };
    await prisma.bankTransaction.upsert({
      where: { transRefKey: key },
      create: { transRefKey: key, ...data },
      update: data,
    });
  }
}

export type SetBankStatusResult =
  | { ok: true; statuses: Record<string, StatusInfo> }
  | { ok: false; message: string };

// 입출금내역 한 건의 검토 상태를 정한다. status가 null이면 해제(= 미확정으로 되돌림).
//
// 검토 표시일 뿐이고 전표를 만들지 않으므로 **되돌릴 수 있다**(세금계산서의 승인/확정은 전표를
// 만들기 때문에 되돌릴 수 없는 것과 다르다). 누가 언제 표시했는지는 남긴다.
export async function setBankTransactionStatus(input: {
  transRefKey: string;
  accountNum: string;
  transDT: string;
  amount: number; // 입금은 +, 출금은 -
  status: BankTxStatus | null;
  reason?: string; // 제외 사유(선택)
  transRefKeys: string[]; // 지금 화면에 있는 거래들 — 갱신된 현황을 한 번에 돌려주기 위함
}): Promise<SetBankStatusResult> {
  const user = await getBankLogUser();
  if (!user) return { ok: false, message: "입출금내역 열람 권한이 없습니다." };

  const key = input.transRefKey.trim();
  if (!key) {
    // 바로빌 응답에 거래고유번호가 없으면 그 건을 특정할 방법이 없다.
    return { ok: false, message: "이 거래에는 은행 거래고유번호가 없어 상태를 표시할 수 없습니다." };
  }

  try {
    if (!input.status) {
      await prisma.bankTransactionConfirm.deleteMany({ where: { transRefKey: key } });
    } else {
      const reason = (input.reason ?? "").trim();
      await prisma.bankTransactionConfirm.upsert({
        where: { transRefKey: key },
        create: {
          transRefKey: key,
          accountNum: input.accountNum,
          transDT: input.transDT,
          amount: input.amount,
          status: input.status,
          reason,
          confirmedByEmail: user.email,
        },
        update: {
          status: input.status,
          reason,
          amount: input.amount,
          confirmedByEmail: user.email,
          confirmedAt: new Date(),
        },
      });
    }
    revalidatePath("/bank");
    return { ok: true, statuses: await loadStatuses(input.transRefKeys) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "상태 표시 중 오류가 발생했습니다." };
  }
}
