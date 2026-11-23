import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/**
 * g3code: where the chat goes while the right panel is maximized, modeled on the Codex app.
 * `sidebar` docks the chat on the right of the panel; `floating` ("full screen") gives the
 * panel the whole window and shows the chat as a movable, resizable card over it.
 */
export type MaximizedChatMode = "sidebar" | "floating";

export interface FloatingChatRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const SIDEBAR_CHAT_MIN_WIDTH = 300;
const FLOATING_CHAT_MIN_WIDTH = 320;
const FLOATING_CHAT_MIN_HEIGHT = 260;

/**
 * The floating chat card, like the ChatGPT app's: `open` shows the whole chat, `minimized` just
 * its header and message box, `closed` a small chat bubble.
 */
export type FloatingChatState = "open" | "minimized" | "closed";

/** Where the floating card rests, like the ChatGPT app: it snaps to one of these on release. */
export type FloatingChatAnchor = "bottom-left" | "bottom-center" | "bottom-right";

/** Gap between a resting card (or bubble) and the layout's edges. */
export const FLOATING_CHAT_MARGIN = 16;

interface MaximizedChatState {
  mode: MaximizedChatMode;
  sidebarWidth: number;
  /** The card's size (its x/y are ignored now that it snaps to an anchor). Null until resized. */
  floatingRect: FloatingChatRect | null;
  floatingAnchor: FloatingChatAnchor;
  floatingState: FloatingChatState;
  setMode: (mode: MaximizedChatMode) => void;
  setSidebarWidth: (width: number) => void;
  setFloatingRect: (rect: FloatingChatRect) => void;
  setFloatingAnchor: (anchor: FloatingChatAnchor) => void;
  setFloatingState: (state: FloatingChatState) => void;
}

export const useMaximizedChatStore = create<MaximizedChatState>()(
  persist(
    (set) => ({
      // Tabs open full screen with the chat floating; the side panel toggle docks it.
      mode: "floating",
      sidebarWidth: 440,
      floatingRect: null,
      floatingAnchor: "bottom-right",
      floatingState: "open",
      setMode: (mode) => set({ mode, floatingState: "open" }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setFloatingRect: (floatingRect) => set({ floatingRect }),
      setFloatingAnchor: (floatingAnchor) => set({ floatingAnchor }),
      setFloatingState: (floatingState) => set({ floatingState }),
    }),
    {
      name: "g3code:maximized-chat",
      version: 4,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // Version 1 also had a "hidden" mode; version 2 a minimized-to-header flag.
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<MaximizedChatState> & {
          mode?: string;
          floatingCollapsed?: boolean;
        };
        const { floatingCollapsed, ...rest } = state;
        return {
          ...rest,
          mode: state.mode === "sidebar" ? "sidebar" : "floating",
          floatingState: floatingCollapsed ? "minimized" : (state.floatingState ?? "open"),
          floatingAnchor: state.floatingAnchor ?? "bottom-right",
        };
      },
      partialize: ({ mode, sidebarWidth, floatingRect, floatingAnchor, floatingState }) => ({
        mode,
        sidebarWidth,
        floatingRect,
        floatingAnchor,
        floatingState,
      }),
    },
  ),
);

/** Keeps the sidebar wide enough to use and leaves at least 40% of the layout to the panel. */
export function clampSidebarWidth(width: number, containerWidth: number): number {
  const max = Math.max(SIDEBAR_CHAT_MIN_WIDTH, Math.round(containerWidth * 0.6));
  return Math.min(Math.max(width, SIDEBAR_CHAT_MIN_WIDTH), max);
}

/**
 * Keeps the floating chat inside the layout, shrinking it if the window got smaller.
 * `minY` keeps it below the panel's tab bar so the tabs stay reachable.
 */
export function clampFloatingRect(
  rect: FloatingChatRect,
  containerWidth: number,
  containerHeight: number,
  minY = 0,
): FloatingChatRect {
  const width = Math.min(Math.max(rect.width, FLOATING_CHAT_MIN_WIDTH), containerWidth);
  const height = Math.min(
    Math.max(rect.height, FLOATING_CHAT_MIN_HEIGHT),
    Math.max(0, containerHeight - minY),
  );
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, 0), Math.max(0, containerWidth - width)),
    y: Math.min(Math.max(rect.y, minY), Math.max(minY, containerHeight - height)),
  };
}

/** The card's default size: Codex/ChatGPT-like width, most of the layout's height. */
export function defaultFloatingSize(containerWidth: number, containerHeight: number) {
  return {
    width: Math.min(440, Math.max(FLOATING_CHAT_MIN_WIDTH, containerWidth * 0.35)),
    height: Math.min(680, Math.max(FLOATING_CHAT_MIN_HEIGHT, containerHeight * 0.65)),
  };
}

/** Places a card of the given size at its anchor, inside the layout. */
export function anchoredFloatingRect(
  size: { readonly width: number; readonly height: number },
  anchor: FloatingChatAnchor,
  containerWidth: number,
  containerHeight: number,
  minY = 0,
): FloatingChatRect {
  const fitted = clampFloatingRect({ ...size, x: 0, y: 0 }, containerWidth, containerHeight, minY);
  const x =
    anchor === "bottom-left"
      ? FLOATING_CHAT_MARGIN
      : anchor === "bottom-center"
        ? (containerWidth - fitted.width) / 2
        : containerWidth - fitted.width - FLOATING_CHAT_MARGIN;
  return clampFloatingRect(
    { ...fitted, x, y: containerHeight - fitted.height - FLOATING_CHAT_MARGIN },
    containerWidth,
    containerHeight,
    minY,
  );
}

/** The anchor whose third of the layout the card's center is in. */
export function nearestFloatingAnchor(
  rect: FloatingChatRect,
  containerWidth: number,
): FloatingChatAnchor {
  const center = rect.x + rect.width / 2;
  if (center < containerWidth / 3) return "bottom-left";
  if (center > (containerWidth * 2) / 3) return "bottom-right";
  return "bottom-center";
}
