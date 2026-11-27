/**
 * A `files` block: paths (mono; the folder quiet, the name in full), each
 * with its note, a value with a small bar, and a link: to that file in this
 * PR's diff on GitHub, or to the PR the item names. The links are built in
 * `lib/insights.ts` from the PR's own URL, never taken from the payload.
 */

import type { FilesBlock as Block, PrView } from "../../../shared/protocol";
import { fileHref, filesMax, formatNumber, prRefText, splitPath, toneColor } from "@/lib/insights";
import { BlockLabel } from "./insight-bits";

export function FilesBlock({ block, pr }: { block: Block; pr: Pick<PrView, "url" | "repo"> }) {
  if (block.items.length === 0) return null;
  const max = filesMax(block.items);
  return (
    <figure className="m-0">
      {block.label && <BlockLabel>{block.label}</BlockLabel>}
      <ul className="m-0 list-none p-0">
        {block.items.map((f, i) => {
          const { dir, name } = splitPath(f.path);
          const diff = fileHref({ path: f.path }, pr);
          const other = f.pr ? fileHref(f, pr) : null;
          const value = typeof f.value === "number" && Number.isFinite(f.value) ? f.value : null;
          const path = (
            // The folder gives way first: the file's name stays readable.
            <span className="flex min-w-0 font-mono text-xs phone:fs-code" title={f.path}>
              {dir && <span className="text-tx3 min-w-[2ch] shrink-[100] truncate">{dir}</span>}
              <span className="text-tx2 min-w-0 truncate">{name}</span>
            </span>
          );
          return (
            <li
              key={`${f.path}:${i}`}
              className="border-line grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t py-[6px] first:border-t-0 first:pt-0 phone:min-h-11 phone:py-1.5"
            >
              <div className="min-w-0">
                {diff ? (
                  <a
                    href={diff}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:[&_span]:text-tx block min-w-0"
                  >
                    {path}
                  </a>
                ) : (
                  path
                )}
                {f.note && (
                  <span className="text-tx3 block truncate text-[12px] leading-[1.45] phone:text-[13px]">
                    {f.note}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2.5">
                {f.pr &&
                  (other ? (
                    <a
                      href={other}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="border-line2 text-tx2 hover:text-tx inline-flex h-[19px] items-center rounded-[5px] border px-[6px] font-mono text-[11px] whitespace-nowrap phone:h-7"
                    >
                      {prRefText(f.pr, pr.repo)}
                    </a>
                  ) : (
                    <span className="text-tx3 font-mono text-[11px]">
                      {prRefText(f.pr, pr.repo)}
                    </span>
                  ))}
                {value !== null && (
                  <span className="flex items-center gap-2">
                    {max > 0 && (
                      <i
                        aria-hidden
                        className="bg-line block h-[3px] w-9 overflow-hidden rounded-sm phone:w-7"
                      >
                        <b
                          className="block h-full rounded-sm"
                          style={{
                            width: `${Math.max(6, (value / max) * 100)}%`,
                            background: toneColor(f.tone, "c1"),
                          }}
                        />
                      </i>
                    )}
                    <span className="text-tx2 w-[3ch] text-right font-mono text-xs tabular-nums">
                      {formatNumber(value)}
                    </span>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
