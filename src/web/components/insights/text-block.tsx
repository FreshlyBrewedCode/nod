/**
 * A `text` block: limited markdown, drawn by the web app's one markdown
 * renderer (`components/markdown.tsx` over `lib/markdown.ts`, the release
 * notes' too): React nodes, never a string as HTML; raw HTML stays text, and
 * only absolute `http(s)` links without credentials become links. The kit's
 * `parseMarkdown` (`src/kit/inbox/markdown.ts`) is what `nod inbox test`
 * prints with; the web app does not use it.
 */

import type { TextBlock as Block } from "../../../shared/protocol";
import { Markdown } from "../markdown";

export function TextBlock({ block }: { block: Block }) {
  if (!block.markdown.trim()) return null;
  return (
    <Markdown source={block.markdown} className="text-[13.5px] leading-[1.6] phone:text-[14px]" />
  );
}
