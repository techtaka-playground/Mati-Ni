"use client";

import { useState } from "react";
import {
  updatePartyContact,
  getPartyContactHistory,
  type PartyContactEditHistoryEntry,
} from "@/app/(app)/parties/actions";

type Party = {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  email: string | null;
};

// 값이 없던 자리는 "(없음)"으로 보여줘야 이력에서 "빈 값 → 채움"이 명확하게 읽힌다.
function shown(v: string | null): string {
  return v && v.trim() ? v : "(없음)";
}

function diffLines(e: PartyContactEditHistoryEntry): string[] {
  const fields: [string, string | null, string | null][] = [
    ["담당자명", e.previousContactName, e.newContactName],
    ["연락처", e.previousContactPhone, e.newContactPhone],
    ["이메일", e.previousEmail, e.newEmail],
  ];
  return fields
    .filter(([, before, after]) => (before ?? null) !== (after ?? null))
    .map(([label, before, after]) => `${label}: ${shown(before)} → ${shown(after)}`);
}

// 거래처 담당자 정보(담당자명·연락처·이메일)를 팝업에서 수정한다. 세 값이 모두 비어있던
// 상태에서 처음 채우는 것은 "초기설정"으로 자동 기록되고 사유를 묻지 않는다 — 그 뒤 수정은
// 사유가 필수이고, 수정 전 값이 이력에 남아 팝업에서 바로 확인할 수 있다.
export function PartyContactEditButton({ party }: { party: Party }) {
  const [open, setOpen] = useState(false);
  const [contactName, setContactName] = useState(party.contactName ?? "");
  const [contactPhone, setContactPhone] = useState(party.contactPhone ?? "");
  const [email, setEmail] = useState(party.email ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<PartyContactEditHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // 지금 저장된 값이 전부 비어있으면 "초기설정" — 사유 입력칸을 아예 띄우지 않는다.
  const isInitial = !party.contactName && !party.contactPhone && !party.email;

  function openModal() {
    setContactName(party.contactName ?? "");
    setContactPhone(party.contactPhone ?? "");
    setEmail(party.email ?? "");
    setReason("");
    setError(null);
    setOpen(true);
    setHistoryLoading(true);
    setHistory(null);
    getPartyContactHistory(party.id).then((r) => {
      setHistory(r.ok ? r.entries : []);
      setHistoryLoading(false);
    });
  }

  async function handleSave() {
    setError(null);
    setPending(true);
    try {
      const result = await updatePartyContact({ partyId: party.id, contactName, contactPhone, email, reason });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
    } catch {
      setError("저장 중 오류가 발생했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={openModal} className="text-xs text-accent hover:underline">
        수정
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-2xl flex-col gap-5 p-8">
            <h3 className="text-xl font-semibold text-fg">담당자 정보 수정 — {party.name}</h3>

            <div className="flex flex-col gap-3">
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted">담당자명</span>
                <input
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="예: 김담당"
                  className="w-72 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted">담당자 연락처</span>
                <input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="예: 010-1234-5678"
                  className="w-72 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted">담당자 이메일</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="예: manager@example.com"
                  className="w-72 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </label>

              {!isInitial && (
                <div className="mt-1 flex flex-col gap-1.5">
                  <span className="text-sm text-muted">수정 사유 (필수)</span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    placeholder="예: 담당자 변경, 연락처 오기 정정 등"
                    className="rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">수정 이력</span>
              {historyLoading ? (
                <span className="text-sm text-muted">불러오는 중...</span>
              ) : history && history.length > 0 ? (
                <ul className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-xl bg-gray-95 px-4 py-3 text-sm text-muted">
                  {history.map((h, i) => {
                    const changes = diffLines(h);
                    return (
                      <li key={i} className="flex flex-col">
                        <span>
                          {/* 수정자(로그인 아이디=이메일)는 "수정자" 라벨을 붙여 명시한다 — 예전엔
                              시각·이메일·사유를 ·로만 이어붙여서 가운데 값이 뭔지 알기 어려웠다. */}
                          {h.createdAt.slice(0, 16).replace("T", " ")} · 수정자{" "}
                          <span className="text-fg">{h.changedByEmail}</span> ·{" "}
                          {h.isInitial ? "초기설정" : h.reason}
                        </span>
                        {changes.length > 0 && (
                          <span className="pl-2 text-muted/80">{changes.join(" / ")}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <span className="text-sm text-muted">아직 수정 이력이 없습니다.</span>
              )}
            </div>

            {error && <div className="text-base text-neg">{error}</div>}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                disabled={pending || (!isInitial && !reason.trim())}
                onClick={handleSave}
                className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? "저장 중..." : isInitial ? "초기설정 저장" : "수정 저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
