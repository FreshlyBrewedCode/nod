/**
 * The notice for a socket that is not open (`lib/reconnect.ts`): none at
 * first, then a quiet hint, then the plain "this view is old". The count
 * starts when the socket stops being open and ignores the `closed` ↔
 * `connecting` flips of the retries in between.
 */

import { useEffect, useState } from "react";

import { NOTICE_STEPS, type Notice } from "@/lib/reconnect";

export function useReconnectNotice(open: boolean): Notice {
  const [notice, setNotice] = useState<Notice>("none");
  useEffect(() => {
    if (open) return;
    const timers = NOTICE_STEPS.map((step) => setTimeout(() => setNotice(step.notice), step.after));
    return () => {
      timers.forEach(clearTimeout);
      setNotice("none");
    };
  }, [open]);
  return open ? "none" : notice;
}
