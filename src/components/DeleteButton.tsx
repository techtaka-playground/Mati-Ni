"use client";

import { useState, useTransition } from "react";
import { IconAlertCircle } from "@/components/icons";

export type DeleteActionResult = { ok: true } | { ok: false; reason?: string };

// confirmMessage는 호출하는 곳마다 "~할까요? ~됩니다." 식으로 질문 한 문장 + 설명 한 문장을
// 이어붙인 문자열로 넘어온다. 그대로 한 문단으로 붙여 보여주면 길어서 읽기 불편하므로, 첫
// 물음표를 기준으로 질문(굵게)과 설명(연하게) 두 줄로 나눠 보여준다 — 설명이 없는(물음표
// 하나뿐인) 메시지는 자연히 한 줄만 남는다.
function splitConfirmMessage(message: string): [string, string | null] {
  const idx = message.indexOf("? ");
  if (idx === -1) return [message, null];
  const rest = message.slice(idx + 2).trim();
  return [message.slice(0, idx + 1), rest || null];
}

// 브라우저 기본 confirm()/alert() 대신 앱 톤에 맞는 팝업으로 확인·오류를 보여준다
// (2026-08-27, "localhost:3000 내용:" 식 브라우저 기본 팝업이 어색하다는 피드백에 따름).
export function DeleteButton({
  action,
  id,
  confirmMessage,
  inUseMessage = "이미 사용 중인 항목이라 삭제할 수 없습니다.",
  // reason별로 다른 안내가 필요할 때만 채운다(예: "매출/매입에서 사용 중" vs "세금계산서
  // 자동 등록"). 못 찾으면 inUseMessage로 대체한다.
  reasonMessages,
  label = "삭제",
}: {
  action: (formData: FormData) => Promise<DeleteActionResult>;
  id: string;
  confirmMessage: string;
  inUseMessage?: string;
  reasonMessages?: Record<string, string>;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmLine1, confirmLine2] = splitConfirmMessage(confirmMessage);

  function handleConfirm() {
    setConfirming(false);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", id);
      const result = await action(fd);
      if (!result.ok) setErrorMessage((result.reason && reasonMessages?.[result.reason]) || inUseMessage);
    });
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(true)}
        className="text-xs text-neg hover:underline disabled:opacity-50"
      >
        {label}
      </button>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-sm flex-col items-center gap-5 p-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-neg/10 text-neg">
              <IconAlertCircle className="h-6 w-6" />
            </span>
            <div className="flex w-full flex-col gap-1">
              <p className="text-base leading-relaxed font-semibold text-fg">{confirmLine1}</p>
              {confirmLine2 && <p className="text-sm leading-relaxed text-muted">{confirmLine2}</p>}
            </div>
            <div className="flex w-full justify-center gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-muted hover:bg-gray-95 hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="flex-1 rounded-xl bg-neg px-6 py-2.5 text-sm font-medium text-white hover:opacity-90"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-sm flex-col items-center gap-5 p-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-95 text-muted">
              <IconAlertCircle className="h-6 w-6" />
            </span>
            <div className="flex w-full flex-col gap-1.5">
              <h3 className="text-base font-semibold text-fg">삭제할 수 없습니다</h3>
              <p className="text-sm leading-relaxed text-muted">{errorMessage}</p>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="w-full rounded-xl bg-accent px-6 py-2.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              확인
            </button>
          </div>
        </div>
      )}
    </>
  );
}
