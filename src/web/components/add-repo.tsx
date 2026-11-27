/**
 * Adding a repository (ADR 0007, 2): a field for `owner/name`,
 * `host/owner/name` or a link, and the suggestions `nod serve` finds (repos
 * where I have open pull requests or review requests). One piece, used by
 * Settings → Repositories and by the page an empty list shows ("Add a
 * repository", the fake's `fresh`): once the list has a repo, the app moves
 * on to the dashboard by itself (the `repos` push).
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import type { RepoInfo, RepoSuggestion } from "../../shared/protocol";
import { sameRepo } from "../../shared/repo-key";
import type { Actions } from "@/hooks/use-connection";
import { useIsPhone } from "@/hooks/use-is-phone";
import { addProblem, repoListError, suggestionLine } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { FullPage } from "./full-page";
import { useRequest } from "./onboarding";

/** A quiet bordered button: the suggestions' Add, a row's actions. */
export const SMALL_BUTTON =
  "border-line2 bg-panel2 text-tx hover:border-tx3 inline-flex h-8 flex-none items-center justify-center rounded-lg border px-3.5 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50 disabled:cursor-default phone:h-11";

const FIELD =
  "bg-bg text-tx border-line2 focus:border-need h-[38px] min-w-0 flex-1 rounded-lg phone:flex-none border px-3 font-mono text-[13.5px] outline-none placeholder:text-tx3 placeholder:font-sans phone:h-11";

export function AddRepo({
  actions,
  focusFirst = false,
  onAdded,
}: {
  actions: Actions;
  /** Focus the field when it shows (the empty page: it is the one thing there). */
  focusFirst?: boolean;
  onAdded?: (repo: RepoInfo) => void;
}) {
  const id = useId();
  // A phone's keyboard would cover the suggestions: no focus there until a tap.
  const phone = useIsPhone();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ReadonlyArray<RepoSuggestion> | null>(null);
  const add = useRequest();
  const suggest = useRequest();

  useEffect(() => {
    let live = true;
    void suggest.run("suggest", async () => {
      const r = await actions.request("suggest-repos", {});
      if (live) setSuggestions(r.suggestions);
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per page
  }, [actions]);

  const submit = async (input: string, which: string) => {
    const wrong = addProblem(input);
    if (wrong) {
      setProblem(wrong);
      field.current?.focus();
      return;
    }
    setProblem(null);
    setAdded(null);
    let repo: RepoInfo | null = null;
    const ok = await add.run(which, async () => {
      repo = (await actions.request("add-repo", { repo: input.trim() })).repo;
    });
    if (!ok || !repo) return;
    const { key } = repo as RepoInfo;
    if (which === "field") setText("");
    setAdded(key);
    setSuggestions((s) => s?.filter((x) => !sameRepo(x.key, key)) ?? s);
    onAdded?.(repo);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!add.busy) void submit(text, "field");
  };

  return (
    <>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor={`${id}-repo`} className="sr-only">
          Repository
        </label>
        <div className="flex gap-2 phone:flex-col">
          <input
            ref={field}
            id={`${id}-repo`}
            name="repository"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one thing on the empty page
            autoFocus={focusFirst && !phone}
            placeholder="owner/name, or paste a link"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-hint`}
            className={cn(FIELD, problem && "border-bad")}
          />
          <button
            type="submit"
            disabled={add.busy !== null}
            className="bg-need border-need text-on-need inline-flex h-[38px] flex-none items-center justify-center rounded-lg border px-5 text-[14px] font-semibold disabled:opacity-50 phone:h-11"
          >
            {add.busy === "field" ? "Adding…" : "Add"}
          </button>
        </div>
        <div id={`${id}-hint`} className="text-tx3 mt-2 fs-note leading-[1.55]">
          <code className="font-mono fs-code">owner/name</code> on github.com; on another host its
          name first, <code className="font-mono fs-code">acme.ghe.com/finance/ledger</code>; or the
          link of the repository or of a pull request in it.
        </div>
        {problem && (
          <div role="alert" className="text-bad mt-2 fs-note">
            {problem}
          </div>
        )}
        {add.failure && (
          <div
            role="alert"
            className="bg-bad-bg mt-3 rounded-lg px-3 py-2.5 text-[13px] leading-[1.55]"
          >
            <b className="text-bad">Not added.</b> {repoListError(add.failure)}
          </div>
        )}
        {added && (
          <output className="text-ok mt-2 block fs-note [overflow-wrap:anywhere]">
            ✓ Added <span className="font-mono">{added}</span>: its pull requests are in your inbox
            from the next read.
          </output>
        )}
      </form>

      <section aria-labelledby={`${id}-suggested`} className="mt-6">
        <h3
          id={`${id}-suggested`}
          className="text-tx3 text-[11px] font-semibold tracking-[0.08em] uppercase"
        >
          Suggested
        </h3>
        <div className="text-tx3 mt-0.5 mb-2 fs-note">
          Where you have open pull requests or review requests.
        </div>
        {!suggestions && !suggest.failure && (
          <div className="text-tx3 text-[13px]">Looking for repositories…</div>
        )}
        {suggest.failure && (
          <div className="text-tx3 text-[13px]">
            No suggestions: {repoListError(suggest.failure)}
          </div>
        )}
        {suggestions?.length === 0 && (
          <div className="text-tx3 text-[13px]">
            Nothing to suggest: no pull request of yours and no review request is open in a
            repository nod does not read.
          </div>
        )}
        {suggestions && suggestions.length > 0 && (
          <ul className="border-line divide-line m-0 list-none divide-y rounded-[10px] border p-0">
            {suggestions.map((s) => (
              <li key={s.key} className="flex items-center gap-3 px-3.5 py-2.5 phone:pr-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[13px] [overflow-wrap:anywhere]">
                    {s.key}
                  </span>
                  <span className="text-tx3 block fs-note">{suggestionLine(s)}</span>
                </span>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={add.busy !== null}
                  aria-label={`Add ${s.key}`}
                  onClick={() => void submit(s.key, s.key)}
                >
                  {add.busy === s.key ? "Adding…" : "Add"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * The repo list is empty (a first run, or every repo removed): a calm page
 * to add the first. Nothing else gates (ADR 0006).
 */
export function AddRepoPage({ actions }: { actions: Actions }) {
  return (
    <FullPage title="Add a repository">
      <p>
        nod shows the pull requests of the repositories you add, in one inbox, sorted by what needs
        you. Reading a repository changes nothing in it.
      </p>
      <div className="mt-5">
        <AddRepo actions={actions} focusFirst />
      </div>
    </FullPage>
  );
}
