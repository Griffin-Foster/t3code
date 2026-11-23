import { ChevronUpIcon, ExpandIcon, GripVerticalIcon, MinusIcon, ShrinkIcon } from "lucide-react";
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

import { Button } from "../ui/button";
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
 * modeled on the Codex app: docked on the right of the panel, or "full screen" with the chat as
 * a floating card. Kept in its own files so upstream updates to ChatView rarely conflict.
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

/** Header clicks on these start their own action instead of dragging the floating chat. */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [role='combobox'], [role='menuitem'], [contenteditable='true']";

/** A pointer that moves less than this is a click, not a drag. */
const CLICK_SLOP_PX = 3;

// The window's top-right controls float over the docked chat's header; keep its content clear of them.
const SIDEBAR_HEADER_CLASSES =
  "[&_[data-chat-header]]:pl-4! [&_[data-chat-header]]:pr-44! [&_[data-chat-header]_[data-workspace-titlebar-controls]]:right-44!";
// Room for the card's minimize button (left) and drag handle (right) inside the chat header.
const FLOATING_HEADER_CLASSES =
  "[&_[data-chat-header]]:pl-11! [&_[data-chat-header]]:pr-10! [&_[data-chat-header]_[data-workspace-titlebar-controls]]:right-9!";

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
    onEnd: (moved: boolean) => void,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
      moved = true;
      onMove(dx, dy);
    };
    const end = () => {
      cleanup.current?.();
      onEnd(moved);
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
        data-maximized-chat-chrome
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
  /** True while the layout is still being measured and the chat has no room yet. */
  readonly away: boolean;
  /** Starts dragging the floating chat from an empty spot in its header. */
  readonly onPointerDown: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
  /** Resize handles, card controls and drag shield, rendered inside the chat column. */
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
  const collapsed = useMaximizedChatStore((state) => state.floatingCollapsed);
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
    return {
      mode: null,
      className: "flex-1",
      style: undefined,
      away: false,
      onPointerDown: undefined,
      chrome: null,
    };
  }
  if (containerWidth === 0) {
    return {
      mode,
      className: "w-0 flex-none",
      style: undefined,
      away: true,
      onPointerDown: undefined,
      chrome: null,
    };
  }

  if (mode === "sidebar") {
    const width = clampSidebarWidth(liveSidebarWidth ?? storedSidebarWidth, containerWidth);
    const startResize = (event: ReactPointerEvent) => {
      drag.start(
        event,
        "col-resize",
        // The handle is on the left edge, so dragging left widens the chat.
        (dx) => setLiveSidebarWidth(clampSidebarWidth(width - dx, containerWidth)),
        () => {
          const live = liveSidebarWidthRef.current;
          if (live !== null) useMaximizedChatStore.getState().setSidebarWidth(live);
          setLiveSidebarWidth(null);
        },
      );
    };
    return {
      mode,
      // `order-last` moves the chat to the right of the panel without remounting it.
      className: cn("relative order-last flex-none border-l border-border", SIDEBAR_HEADER_CLASSES),
      style: { width },
      away: false,
      onPointerDown: undefined,
      chrome: (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={gt("Resize chat sidebar")}
            className="absolute top-0 bottom-0 -left-1 z-30 w-2 cursor-col-resize [-webkit-app-region:no-drag]"
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
      (moved) => {
        commitFloatingRect();
        // A plain click on a minimized card's header opens it again.
        if (!moved && collapsed) useMaximizedChatStore.getState().setFloatingCollapsed(false);
      },
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
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (!target.closest("[data-chat-header]") || target.closest(INTERACTIVE_SELECTOR)) return;
    startMove(event);
  };
  const toggleLabel = collapsed ? gt("Expand chat") : gt("Minimize chat");
  return {
    mode,
    className: cn(
      "absolute z-40 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl",
      // The chat header is a window drag region in the desktop app; over the panel it must not be.
      "[-webkit-app-region:no-drag] [&_.drag-region]:[-webkit-app-region:no-drag]!",
      "[&_[data-chat-header]]:cursor-grab",
      FLOATING_HEADER_CLASSES,
      // Minimized: only the header shows. Hidden, not unmounted, so the draft and scroll position stay.
      collapsed && "[&>:not([data-chat-header]):not([data-maximized-chat-chrome])]:invisible",
    ),
    // Anchored by its bottom edge, so minimizing to the header keeps it in the corner.
    style: {
      left: rect.x,
      bottom: containerHeight - (rect.y + rect.height),
      width: rect.width,
      height: collapsed ? "var(--workspace-topbar-height)" : rect.height,
    },
    away: false,
    onPointerDown,
    chrome: (
      <>
        <div
          data-maximized-chat-chrome
          className="absolute top-0 left-2 z-40 flex h-[var(--workspace-topbar-height)] items-center"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={toggleLabel}
                  onClick={() => useMaximizedChatStore.getState().setFloatingCollapsed(!collapsed)}
                >
                  {collapsed ? (
                    <ChevronUpIcon className="size-4" />
                  ) : (
                    <MinusIcon className="size-4" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="bottom">{toggleLabel}</TooltipPopup>
          </Tooltip>
        </div>
        <div
          role="presentation"
          data-maximized-chat-chrome
          aria-label={gt("Drag to move the chat")}
          className="absolute top-0 right-1 z-40 flex h-[var(--workspace-topbar-height)] w-8 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
          onPointerDown={startMove}
        >
          <GripVerticalIcon className="size-4" />
        </div>
        {collapsed
          ? null
          : FLOATING_RESIZE_EDGES.map(({ edge, cursor, className }) => (
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

/** Switches the maximized view between docked chat and full screen with a floating chat. */
export const MaximizedChatViewControl = memo(function MaximizedChatViewControl() {
  const gt = useGT();
  const mode = useMaximizedChatStore((state) => state.mode);
  const setMode = useMaximizedChatStore((state) => state.setMode);
  if (mode === "floating") {
    return (
      <Button
        className="[-webkit-app-region:no-drag]"
        variant="outline"
        size="xs"
        onClick={() => setMode("sidebar")}
      >
        <ShrinkIcon />
        {gt("Exit full screen")}
      </Button>
    );
  }
  const label = gt("Full screen");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="[-webkit-app-region:no-drag]"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => setMode("floating")}
          >
            <ExpandIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
