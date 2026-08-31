"use client";

import { useState, useTransition } from "react";
import { fileToBase64 } from "@/lib/clientFile";

type ExtractResult<T> = { ok: true; data: T } | { ok: false; message: string };
export type PdfMeta = { base64: string; filename: string };

export function PdfUploadField<T>({
  extractAction,
  onExtracted,
  label = "인보이스 PDF",
}: {
  extractAction: (base64: string) => Promise<ExtractResult<T>>;
  onExtracted: (data: T, meta: PdfMeta) => void;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    startTransition(async () => {
      try {
        const base64 = await fileToBase64(file);
        const result = await extractAction(base64);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onExtracted(result.data, { base64, filename: file.name });
      } catch {
        setError("PDF 처리 중 오류가 발생했습니다.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted">{label}</label>
      <input
        type="file"
        accept="application/pdf"
        onChange={handleChange}
        disabled={pending}
        className="text-xs text-fg file:mr-2 file:rounded-md file:border-0 file:bg-gray-95 file:px-2 file:py-1 file:text-xs"
      />
      {pending && <span className="text-xs text-muted">PDF 분석 중...</span>}
      {error && <span className="text-xs text-neg">{error}</span>}
    </div>
  );
}
