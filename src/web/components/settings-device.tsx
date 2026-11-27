/**
 * Settings → Other device (ADR 0005): with `--allow-host`, the name another
 * device reaches this `nod serve` on and, on this machine's page only, the
 * device link as a QR code (`device-link`: it carries the remote token, so
 * the other device's side is never sent it). Without the flag, how to set it
 * up, and the docs.
 */

import { useEffect, useState } from "react";

import type { AppState, DeviceLink } from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import type { Failure } from "@/lib/batch";
import { cn } from "@/lib/utils";
import { CommandBox, ErrorNote } from "./onboarding";
import { CARD, Code, H2, Heading, LINE, LongCode, NOTE } from "./settings-bits";
import { failureOf } from "./unlock";

export const PHONE_DOCS = "https://nod.frebreco.de/docs/phone";

/** The light modules around the code, as the standard asks. */
const QUIET_ZONE = 4;

/** A QR code from its rows (`1` dark), as one SVG path: no HTML, no image to fetch. */
export function qrPath(rows: ReadonlyArray<string>): string {
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === "1") d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
  });
  return d;
}

function QrCode({ rows, label }: { rows: ReadonlyArray<string>; label: string }) {
  const size = rows.length + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="block size-[208px] rounded-lg phone:size-[220px]"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(rows)} fill="#000" />
    </svg>
  );
}

const HOST_PLACEHOLDER = "<machine>.<tailnet>.ts.net";

export function DeviceSection({ app, actions }: { app: AppState | null; actions: Actions }) {
  const origin = app?.otherDevice?.origin ?? null;
  const here = typeof window === "undefined" ? null : window.location.origin;
  const onTheDevice = origin !== null && here === origin;
  return (
    <>
      <Heading title="Other device">
        A phone, or another computer, can open this nod through a name a TLS proxy such as{" "}
        <Code>tailscale serve</Code> gives this machine. It pairs once, by scanning a code; signing
        there needs your passphrase, and its unlock window is its own.
      </Heading>
      {origin && onTheDevice ? (
        <section aria-labelledby="device-title" className={CARD}>
          <h2 id="device-title" className={H2}>
            This is the other device
          </h2>
          <p className={LINE}>
            It reaches <Code>nod serve</Code> at <LongCode>{origin}</LongCode>. Its code and its
            link are shown only on the machine nod runs on.
          </p>
        </section>
      ) : origin && app?.mayChange ? (
        <DeviceLinkCard origin={origin} actions={actions} />
      ) : origin ? (
        <section aria-labelledby="device-title" className={CARD}>
          <h2 id="device-title" className={H2}>
            On
          </h2>
          <p className={LINE}>
            Another device reaches this nod at <LongCode>{origin}</LongCode>. Its code is shown on
            the machine nod runs on.
          </p>
        </section>
      ) : (
        <HowTo />
      )}
    </>
  );
}

function DeviceLinkCard({ origin, actions }: { origin: string; actions: Actions }) {
  const [link, setLink] = useState<DeviceLink | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    let live = true;
    actions
      .request("device-link", {})
      .then((l) => live && setLink(l))
      .catch((error: unknown) => live && setFailure(failureOf(error)));
    return () => {
      live = false;
    };
  }, [actions]);
  return (
    <section aria-labelledby="device-title" className={CARD}>
      <h2 id="device-title" className={H2}>
        Pair another device
      </h2>
      <p className={cn(LINE, "mb-3")}>
        <Code>nod serve</Code> answers at <LongCode>{origin}</LongCode> too. Scan this code with the
        other device’s camera: it opens nod there and pairs it.
      </p>
      <div className="flex items-start gap-5 phone:flex-col phone:items-center">
        <div className="bg-bg border-line grid min-h-[208px] min-w-[208px] place-items-center rounded-xl border p-3">
          {link ? (
            <QrCode rows={link.qr} label={`A QR code: the link to pair a device with ${origin}`} />
          ) : (
            !failure && <span className={NOTE}>Drawing the code…</span>
          )}
        </div>
        <div className="min-w-0 flex-1 text-[13px] leading-[1.55]">
          <p className="text-tx2 m-0">
            <b className="text-tx">Do not send it through a chat</b>, a mail or a synced clipboard:
            the link carries that device’s pairing token, which does not expire.
          </p>
          <p className="text-tx3 m-0 mt-2">
            Lost the device? Start <Code>nod serve</Code> once with <Code>--new-remote-token</Code>:
            it has to pair again, this machine’s page does not.
          </p>
          <p className="text-tx3 m-0 mt-2">
            <a
              href={PHONE_DOCS}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-tx2 underline underline-offset-2"
            >
              Another device, in the docs ↗
            </a>
          </p>
        </div>
      </div>
      <ErrorNote failure={failure} lead="The code is not shown." />
    </section>
  );
}

function HowTo() {
  return (
    <section aria-labelledby="device-title" className={CARD}>
      <h2 id="device-title" className={H2}>
        Not set up
      </h2>
      <p className={cn(LINE, "mb-3")}>
        This <Code>nod serve</Code> answers on this machine only. With Tailscale, give its port a
        name on your tailnet, then start <Code>nod serve</Code> with that name; it prints a QR code
        to scan, and this page shows it too.
      </p>
      <div className="flex flex-col gap-2">
        <CommandBox command="tailscale serve --bg --https=8445 http://127.0.0.1:4518" />
        <CommandBox command={`nod serve --allow-host ${HOST_PLACEHOLDER}:8445`} />
      </div>
      <p className={cn(NOTE, "mt-2.5")}>
        Only a private network: never Funnel, never plain http. Why, and what else works:{" "}
        <a
          href={PHONE_DOCS}
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-tx2 underline underline-offset-2"
        >
          Another device ↗
        </a>
      </p>
    </section>
  );
}
