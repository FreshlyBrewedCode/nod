/**
 * The repo filter (ADR 0007, 1): next to the list's order switch and the
 * board's grouping, only while there is more than one repo. "All
 * repositories", or one; each with how many of its PRs need me. Remembered
 * per browser (`STORAGE_KEYS.repoFilter`, read by `readRepoFilter`); the
 * list, the board and the selection show only that repo's PRs.
 */

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { RepoInfo, RepoKey } from "../../shared/protocol";
import { sameRepo } from "../../shared/repo-key";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function RepoFilter({
  repos,
  chips,
  value,
  needs,
  onChange,
}: {
  repos: ReadonlyArray<RepoInfo>;
  /** The repo chip's words (`chipsOf`). */
  chips: ReadonlyMap<RepoKey, string>;
  /** The repo shown, or null for all. */
  value: RepoKey | null;
  /** How many PRs need me, per repo key. */
  needs: ReadonlyMap<RepoKey, number>;
  onChange: (repo: RepoKey | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value === null ? "All repositories" : (chips.get(value) ?? value);
  const total = [...needs.values()].reduce((a, b) => a + b, 0);
  const choose = (repo: RepoKey | null) => {
    setOpen(false);
    onChange(repo);
  };
  const option = (repo: RepoKey | null, name: string, sub: string | null, count: number) => {
    const on = repo === null ? value === null : sameRepo(repo, value);
    return (
      <button
        key={repo ?? ""}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        onClick={() => choose(repo)}
        className={cn(
          "hover:bg-bg grid w-full grid-cols-[14px_1fr_auto] items-baseline gap-x-2 rounded-lg px-2.5 py-2 text-left text-[13px] phone:min-h-11",
          on ? "text-tx" : "text-tx2",
        )}
      >
        <span aria-hidden className="text-need">
          {on ? "✓" : ""}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            repo !== null && "font-mono text-[12.5px]",
            on && "font-semibold",
          )}
        >
          {name}
        </span>
        <span className={cn("fs-note whitespace-nowrap", count ? "text-need" : "text-tx3")}>
          {count ? `${count} need${count === 1 ? "s" : ""} you` : ""}
        </span>
        {sub && (
          <span className="text-tx3 fs-code col-span-2 col-start-2 font-mono [overflow-wrap:anywhere]">
            {sub}
          </span>
        )}
      </button>
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Repository: ${label}`}
        className={cn(
          "border-line2 inline-flex h-7 max-w-[260px] min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] phone:h-11 phone:max-w-none",
          value === null ? "text-tx2 hover:text-tx" : "border-need-line text-tx bg-panel2",
        )}
      >
        <span className={cn("truncate", value !== null && "font-mono text-[12.5px]")}>{label}</span>
        <ChevronDown aria-hidden className="size-3.5 flex-none opacity-70" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        role="menu"
        aria-label="Show the pull requests of"
        className="w-[300px] p-1.5 phone:w-[min(320px,calc(100vw-16px))]"
      >
        <p className="text-tx3 m-0 px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase">
          Repository
        </p>
        {option(null, "All repositories", null, total)}
        {repos.map((r) => {
          const chip = chips.get(r.key) ?? r.key;
          return option(r.key, chip, chip === r.key ? null : r.key, needs.get(r.key) ?? 0);
        })}
      </PopoverContent>
    </Popover>
  );
}
