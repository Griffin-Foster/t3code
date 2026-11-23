import { MessageSquareOffIcon, PanelLeftIcon, PictureInPicture2 } from "lucide-react";
import { useGT } from "gt-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
  useEffect,
  useRef,
  useState,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type FloatingChatRect,
  type MaximizedChatMode,
  clampFloatingRect,
  clampSidebarWidth,
  defaultFloatingRect,
  useMaximizedChatStore,
} from "./maximizedChatStore";

/*
 * g3code: keeps the chat usable while the right panel (browser, diff, files...) is maximized,
 * either docked as a sidebar or floating over the panel. Kept in its own files so upstream
 * updates to ChatView rarely conflict with it.
 */

type ResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

const FLOATING_RESIZE_EDGES: ReadonlyArray<{
  edge: ResizeEdge;
  cursor: string;
  className: string;
}> = [
  { edge: "n", cursor: "ns-resize", className: "top-0 right-3 left-3 h-1.5" },
  { edge: "s", cursor: "ns-resize", className: "right-3 bottom-0 left-3 h-1.5" },
  { edge: "e", cursor: "ew-resize", className: "top-3 right-0 bottom-3 w-1.5" },
  { edge: "w", cursor: "ew-resize", className: "top-3 bottom-3 left-0 w-1.5" },
  { edge: "nw", cursor: "nwse-resize", className: "top-0 left-0 size-3" },
  { edge: "ne", cursor: "nesw-resize", className: "top-0 right-0 size-3" },
  { edge: "sw", cursor: "nesw-resize", className: "bottom-0 left-0 size-3" },
  { edge: "se", cursor: "nwse-resize", className: "right-0 bottom-0 size-3" },
];

function useElementSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the layout element's size, observed while mounted
  useEffect(() => {
    if (!element) return;
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
  }, [element]);
  return size;
}

/**
 * Tracks one pointer drag. While it runs, a transparent full-window shield sits on top so
 * the browser panel's webview can't swallow the pointer events.
 */
function usePointerDrag() {
  const [cursor, setCursor] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes window drag listeners if unmounted mid-drag
  useEffect(() => () => cleanup.current?.(), []);

  const start = (
    event: ReactPointerEvent,
    dragCursor: string,
    onMove: (dx: number, dy: number) => void,
    onEnd: () => void,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) =>
      onMove(moveEvent.clientX - startX, moveEvent.clientY - startY);
    const end = () => {
      cleanup.current?.();
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      cleanup.current = null;
      setCursor(null);
    };
    setCursor(dragCursor);
  };

  const shield =
    cursor === null ? null : (
      <div
        aria-hidden
        className="fixed inset-0 z-[1000] [-webkit-app-region:no-drag]"
        style={{ cursor }}
      />
    );
  return { start, shield };
}

function resizeRect(rect: FloatingChatRect, edge: ResizeEdge, dx: number, dy: number) {
  let { x, y, width, height } = rect;
  if (edge.includes("e")) width += dx;
  if (edge.includes("s")) height += dy;
  if (edge.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (edge.includes("n")) {
    y += dy;
    height -= dy;
  }
  return { x, y, width, height };
}

export interface MaximizedChatLayout {
  /** Null when the panel isn't maximized and the chat column uses its normal layout. */
  readonly mode: MaximizedChatMode | null;
  readonly className: string;
  readonly style: CSSProperties | undefined;
  /** True only when the chat is hidden, matching upstream's maximized behavior. */
  readonly away: boolean;
  /** Drag bar, resize handles and drag shield, rendered inside the chat column. */
  readonly chrome: ReactNode;
}

export function useMaximizedChatLayout(
  maximized: boolean,
  container: HTMLElement | null,
): MaximizedChatLayout {
  const gt = useGT();
  const mode = useMaximizedChatStore((state) => state.mode);
  const storedSidebarWidth = useMaximizedChatStore((state) => state.sidebarWidth);
  const storedFloatingRect = useMaximizedChatStore((state) => state.floatingRect);
  const { width: containerWidth, height: containerHeight } = useElementSize(container);
  const drag = usePointerDrag();
  // Live geometry during a drag; committed to the store (and storage) when the drag ends.
  const [liveSidebarWidth, setLiveSidebarWidthState] = useState<number | null>(null);
  const [liveFloatingRect, setLiveFloatingRectState] = useState<FloatingChatRect | null>(null);
  const liveSidebarWidthRef = useRef<number | null>(null);
  const liveFloatingRectRef = useRef<FloatingChatRect | null>(null);
  const setLiveSidebarWidth = (width: number | null) => {
    liveSidebarWidthRef.current = width;
    setLiveSidebarWidthState(width);
  };
  const setLiveFloatingRect = (rect: FloatingChatRect | null) => {
    liveFloatingRectRef.current = rect;
    setLiveFloatingRectState(rect);
  };

  if (!maximized) {
    return { mode: null, className: "flex-1", style: undefined, away: false, chrome: null };
  }
  if (mode === "hidden" || containerWidth === 0) {
    return {
      mode: "hidden",
      className: "w-0 flex-none",
      style: undefined,
      away: true,
      chrome: null,
    };
  }

  if (mode === "sidebar") {
    const width = clampSidebarWidth(liveSidebarWidth ?? storedSidebarWidth, containerWidth);
    const startResize = (event: ReactPointerEvent) => {
      drag.start(
        event,
        "col-resize",
        (dx) => setLiveSidebarWidth(clampSidebarWidth(width + dx, containerWidth)),
        () => {
          const live = liveSidebarWidthRef.current;
          if (live !== null) useMaximizedChatStore.getState().setSidebarWidth(live);
          setLiveSidebarWidth(null);
        },
      );
    };
    return {
      mode,
      className: "relative flex-none border-r border-border",
      style: { width },
      away: false,
      chrome: (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={gt("Resize chat sidebar")}
            className="absolute top-0 -right-1 bottom-0 z-30 w-2 cursor-col-resize [-webkit-app-region:no-drag]"
            onPointerDown={startResize}
          />
          {drag.shield}
        </>
      ),
    };
  }

  const rect = clampFloatingRect(
    liveFloatingRect ?? storedFloatingRect ?? defaultFloatingRect(containerWidth, containerHeight),
    containerWidth,
    containerHeight,
  );
  const commitFloatingRect = () => {
    const live = liveFloatingRectRef.current;
    if (live !== null) useMaximizedChatStore.getState().setFloatingRect(live);
    setLiveFloatingRect(null);
  };
  const startMove = (event: ReactPointerEvent) => {
    drag.start(
      event,
      "grabbing",
      (dx, dy) =>
        setLiveFloatingRect(
          clampFloatingRect(
            { ...rect, x: rect.x + dx, y: rect.y + dy },
            containerWidth,
            containerHeight,
          ),
        ),
      commitFloatingRect,
    );
  };
  const startResize = (edge: ResizeEdge, cursor: string) => (event: ReactPointerEvent) => {
    drag.start(
      event,
      cursor,
      (dx, dy) =>
        setLiveFloatingRect(
          clampFloatingRect(resizeRect(rect, edge, dx, dy), containerWidth, containerHeight),
        ),
      commitFloatingRect,
    );
  };
  return {
    mode,
    className: cn(
      "absolute z-40 overflow-hidden rounded-xl border border-border bg-background shadow-2xl",
      // The chat header is a window drag region in the desktop app; over the panel it must not be.
      "[-webkit-app-region:no-drag] [&_.drag-region]:[-webkit-app-region:no-drag]!",
      // Drop the title bar inset meant for the window's traffic lights.
      "[&_[data-chat-header]]:pl-3!",
    ),
    style: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
    away: false,
    chrome: (
      <>
        <div
          className="flex h-4 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
          onPointerDown={startMove}
          aria-label={gt("Drag to move the chat")}
          role="presentation"
        >
          <div className="h-1 w-10 rounded-full bg-muted-foreground/35" />
        </div>
        {FLOATING_RESIZE_EDGES.map(({ edge, cursor, className }) => (
          <div
            key={edge}
            aria-hidden
            className={cn("absolute z-30", className)}
            style={{ cursor }}
            onPointerDown={startResize(edge, cursor)}
          />
        ))}
        {drag.shield}
      </>
    ),
  };
}

const MODE_OPTIONS: ReadonlyArray<{ mode: MaximizedChatMode; icon: typeof PanelLeftIcon }> = [
  { mode: "sidebar", icon: PanelLeftIcon },
  { mode: "floating", icon: PictureInPicture2 },
  { mode: "hidden", icon: MessageSquareOffIcon },
];

/** Chooses where the chat goes while the panel is maximized. */
export const MaximizedChatModeControl = memo(function MaximizedChatModeControl() {
  const gt = useGT();
  const mode = useMaximizedChatStore((state) => state.mode);
  const setMode = useMaximizedChatStore((state) => state.setMode);
  const labels: Record<MaximizedChatMode, string> = {
    sidebar: gt("Chat in sidebar"),
    floating: gt("Floating chat"),
    hidden: gt("Hide chat"),
  };
  return (
    <div
      className="flex shrink-0 items-center rounded-md border border-border/70 p-px [-webkit-app-region:no-drag]"
      role="group"
      aria-label={gt("Chat placement")}
    >
      {MODE_OPTIONS.map(({ mode: option, icon: Icon }) => (
        <Tooltip key={option}>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={mode === option}
                onPressedChange={() => setMode(option)}
                aria-label={labels[option]}
                variant="ghost"
                size="sm"
              >
                <Icon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">{labels[option]}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
});
