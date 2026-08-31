"use client";

import { useState } from "react";

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
        className="w-56 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-muted"
      />
      <button
        type="button"
        onClick={handleCopy}
        className="rounded-md bg-gray-95 px-2 py-1 text-xs text-fg hover:bg-gray-90"
      >
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}
