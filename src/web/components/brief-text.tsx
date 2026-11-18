/** A brief's plain text, with `backticks` set as code (mono). */

import { Fragment } from "react";

export function BriefText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="text-tx2 font-mono text-[0.9em]">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
