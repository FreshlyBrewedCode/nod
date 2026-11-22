/**
 * "How to read this": the first-run legend of the four sizes and three lanes
 * (r3 `17`). Shown until "Got it".
 */

import { cn } from "@/lib/utils";

function Sketch({ kind }: { kind: "prominent" | "normal" | "one" | "folded" }) {
  const bar = "block h-[5px] rounded-[3px]";
  if (kind === "one" || kind === "folded")
    return (
      <div
        className={cn(
          "border-line bg-bg grid grid-cols-[55%_1fr] items-center gap-1 rounded-[7px] border px-[9px] py-1.5",
          kind === "folded" && "border-dashed",
        )}
      >
        <i className={cn(bar, kind === "one" ? "bg-tx3 w-full" : "bg-line2 w-[60%]")} />
        <i className={cn(bar, "bg-line2")} />
      </div>
    );
  return (
    <div className="border-line bg-bg grid gap-1 rounded-[7px] border px-[9px] py-1.5">
      <i className={cn(bar, "bg-tx3 w-[55%]")} />
      {kind === "prominent" && <i className={cn(bar, "bg-line2 w-[80%]")} />}
      <i className={cn(bar, "bg-line2 w-[35%]")} />
    </div>
  );
}

const ROWS = [
  [
    "prominent",
    "Prominent",
    " · with a line of the brief",
    "needs you, and is high risk or a teammate’s work",
  ],
  ["normal", "Normal", "", "needs you, your own work, low or medium risk"],
  ["one", "One line", "", "worth knowing, or yours and stuck"],
  ["folded", "Folded", " · “4 low-risk changes”", "low risk and nothing for you to do"],
] as const;

export function Legend({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      className="border-line2 bg-panel mb-[30px] rounded-xl border px-[22px] py-5 phone:mx-4 phone:mt-4 phone:px-4"
      aria-label="How to read this"
    >
      <h3 className="m-0 mb-1 text-[15px] font-bold">How to read this</h3>
      <p className="text-tx3 m-0 fs-note leading-[1.55]">
        The more attention a change deserves, the more room it gets. Three things decide: its risk,
        whether it needs you, and whether it is your own work or a teammate’s.
      </p>
      <div className="mt-3">
        {ROWS.map(([kind, name, extra, when]) => (
          <div
            key={kind}
            className="border-line text-tx2 grid grid-cols-[150px_1fr_1fr] items-center gap-4 border-t py-[9px] text-[13px] phone:grid-cols-[88px_1fr] phone:gap-x-3 phone:gap-y-0.5 phone:py-3"
          >
            <div className="phone:row-span-2">
              <Sketch kind={kind} />
            </div>
            <span>
              <b className="text-tx font-semibold">{name}</b>
              {extra}
            </span>
            <span className="phone:col-start-2">{when}</span>
          </div>
        ))}
      </div>
      {/* What a desktop says in tooltips, written out where there is no hover. */}
      <p className="text-tx3 fs-note m-0 mt-3 hidden leading-[1.55] phone:block">
        <b className="text-tx2 font-semibold">On a row:</b> the round letter is who prompted the
        change. The bars are its risk: one low, two medium, three (red) high. The green and red
        numbers are lines added and removed, lockfiles and generated files left out. “needs #492
        first” means it waits for that one.
      </p>
      <div className="mt-3.5 flex items-center gap-2.5 phone:flex-col phone:items-stretch phone:gap-3">
        <span className="text-tx3 fs-note leading-[1.55]">
          Lanes: <b className="text-need">Needs you</b> waits for your signature ·{" "}
          <b className="text-know">Worth knowing</b> wants no input · Background takes care of
          itself.
        </span>
        <span className="flex-1 phone:hidden" />
        <button
          type="button"
          onClick={onDismiss}
          className="border-line2 bg-panel2 text-tx h-8 rounded-lg border px-3.5 text-[13px] font-semibold whitespace-nowrap phone:h-11"
        >
          Got it
        </button>
      </div>
    </section>
  );
}
