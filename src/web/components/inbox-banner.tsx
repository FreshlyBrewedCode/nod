/**
 * The quiet banner above the list (ADR 0009): my own inbox does not load,
 * or keeps crashing. One line with the error, a link to Settings → Inbox,
 * and a close button that puts this error away (per error text, in this
 * browser: a new error shows again). What the inbox said before stays in
 * effect meanwhile, which the line says too.
 */

import { X } from "lucide-react";
import { useState } from "react";

import type { InboxStatus } from "../../shared/protocol";
import { bannerError, readDismissed } from "@/lib/personal";
import { STORAGE_KEYS, browserStorage, readJson, writeJson } from "@/lib/storage";

export function InboxBanner({
  inbox,
  onSettings,
}: {
  inbox: InboxStatus | null;
  onSettings: () => void;
}) {
  const [dismissed, setDismissed] = useState(() =>
    readDismissed(readJson(browserStorage(), STORAGE_KEYS.inboxErrors)),
  );
  const error = bannerError(inbox, dismissed);
  if (!error) return null;
  const dismiss = () => {
    const next = [...dismissed, error].slice(-20);
    writeJson(browserStorage(), STORAGE_KEYS.inboxErrors, next);
    setDismissed(next);
  };
  return (
    <output
      aria-label="Your inbox"
      className="border-line text-tx2 flex items-start gap-3 border-b px-5 py-1.5 text-[12.5px] leading-[1.5] phone:px-4 phone:py-2 phone:text-[13px]"
    >
      <i aria-hidden className="bg-bad mt-[7px] size-1.5 flex-none rounded-full" />
      <p className="m-0 min-w-0 flex-1">
        <b className="text-tx font-semibold">Your inbox does not load.</b>{" "}
        <span className="text-tx3 font-mono text-[11.5px] [overflow-wrap:anywhere] phone:text-[12px]">
          {error}
        </span>{" "}
        <span className="text-tx3">What it said before stays.</span>{" "}
        <button
          type="button"
          onClick={onSettings}
          className="text-tx2 hover:text-tx underline underline-offset-2"
        >
          Settings → Inbox
        </button>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Put this error away"
        title="Put this error away"
        className="text-tx3 hover:text-tx2 -my-1 grid size-7 flex-none place-items-center rounded-md phone:-my-2 phone:size-11"
      >
        <X className="size-3.5" />
      </button>
    </output>
  );
}
