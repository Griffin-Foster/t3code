import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseUrl } from "@t3tools/shared/url";
import { useGT } from "gt-react";
import {
  FileDiff,
  Files,
  type LucideIcon,
  MessagesSquare,
  SearchIcon,
  TerminalSquare,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { PreviewFaviconIcon } from "../preview/PreviewFaviconIcon";
import { useDiscoveredLocalServers } from "../preview/useDiscoveredLocalServers";

/*
 * g3code: the Codex-style "New tab" page. It replaces the blank browser tab's empty state, so
 * Cmd+T (a new browser tab) lands on a centered, focused search/URL bar with quick actions.
 */

/** Shows this page instead of upstream's empty browser state. */
export const G3_NEW_TAB_PAGE = true;

export interface NewTabActions {
  readonly terminal?: (() => void) | undefined;
  readonly files?: (() => void) | undefined;
  readonly diff?: (() => void) | undefined;
  readonly sideChat?: (() => void) | undefined;
}

/** The thread's surface actions, published by ChatView for the page inside the browser panel. */
const useNewTabActionsStore = create<{ actions: NewTabActions }>(() => ({ actions: {} }));

/**
 * Called by the thread's main ChatView with the actions available for the current thread.
 * Embedded chats (side chats) pass `enabled: false` so they don't overwrite them.
 */
export function usePublishNewTabActions(actions: NewTabActions, enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the thread's surface actions for the New tab page, which renders inside the browser panel rather than under ChatView's props
  useEffect(() => {
    if (enabled) useNewTabActionsStore.setState({ actions });
  });
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  /** The blank browser tab this page lives in; a quick action replaces it. */
  readonly surfaceId: string | null;
  readonly configuredUrls?: ReadonlyArray<string> | undefined;
  readonly recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  /** Address bar input: a URL, or a search using the user's search engine setting. */
  readonly onSubmit: (input: string) => void;
  /** A suggested site or local server. */
  readonly onOpenUrl: (url: string) => void;
}

export function NewTabPage({
  threadRef,
  surfaceId,
  configuredUrls,
  recentEntries,
  onSubmit,
  onOpenUrl,
}: Props) {
  const gt = useGT();
  const actions = useNewTabActionsStore((state) => state.actions);
  const servers = useDiscoveredLocalServers({
    environmentId: threadRef.environmentId,
    configuredUrls,
  });
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the address bar once the new tab is on screen, after the panel's own focus handling
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const newItems: ReadonlyArray<{
    key: string;
    label: string;
    icon: LucideIcon;
    run?: (() => void) | undefined;
  }> = [
    { key: "terminal", label: gt("Terminal"), icon: TerminalSquare, run: actions.terminal },
    { key: "files", label: gt("Files"), icon: Files, run: actions.files },
    { key: "diff", label: gt("Diff"), icon: FileDiff, run: actions.diff },
    { key: "side-chat", label: gt("Side chat"), icon: MessagesSquare, run: actions.sideChat },
  ];
  const availableNewItems = newItems.filter((item) => item.run !== undefined);

  const seen = new Set<string>();
  const suggestions = [
    ...servers.map((server) => ({
      url: server.requestedUrl,
      title: server.processName || `${server.host}:${server.port}`,
      kind: gt("Local server"),
    })),
    ...recentEntries
      .filter((entry) => parseUrl(entry.url) !== null)
      .map((entry) => ({ url: entry.url, title: entry.title || entry.url, kind: gt("Website") })),
  ]
    .filter((item) => (seen.has(item.url) ? false : (seen.add(item.url), true)))
    .slice(0, 8);

  // Opening something else from a new tab turns the tab into it, as in the Codex app.
  const replaceTabWith = (run: () => void) => {
    run();
    if (surfaceId) useRightPanelStore.getState().closeSurface(threadRef, surfaceId);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (value) onSubmit(value);
  };

  return (
    <div data-g3-new-tab className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 pt-40 pb-10">
        <form onSubmit={submit}>
          <label className="flex h-11 items-center gap-2.5 rounded-full border border-border bg-muted/40 px-4 text-sm focus-within:border-ring">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-label={gt("Search the web or enter a URL")}
              placeholder={gt("Search the web or enter a URL")}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </form>

        {availableNewItems.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-medium text-muted-foreground">{gt("New")}</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {availableNewItems.map(({ key, label, icon: Icon, run }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => run && replaceTabWith(run)}
                  className="flex h-20 cursor-pointer flex-col items-start justify-between rounded-xl bg-muted/40 p-3 text-left text-sm transition-colors hover:bg-muted"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  {label}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {suggestions.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-medium text-muted-foreground">{gt("Suggested")}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {suggestions.map((item) => (
                <button
                  key={item.url}
                  type="button"
                  onClick={() => onOpenUrl(item.url)}
                  className="group flex min-w-0 cursor-pointer flex-col gap-2 text-left"
                >
                  <span className="flex h-24 items-center justify-center rounded-xl bg-muted/40 transition-colors group-hover:bg-muted">
                    <PreviewFaviconIcon threadRef={threadRef} url={item.url} className="size-8" />
                  </span>
                  <span className="flex min-w-0 flex-col px-0.5">
                    <span className="truncate text-sm">{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{item.kind}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
