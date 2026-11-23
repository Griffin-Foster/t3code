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

interface MaximizedChatState {
  mode: MaximizedChatMode;
  sidebarWidth: number;
  /** Null until first shown, so the default can be placed against the actual layout size. */
  floatingRect: FloatingChatRect | null;
  /** The floating card is minimized to its header. */
  floatingCollapsed: boolean;
  setMode: (mode: MaximizedChatMode) => void;
  setSidebarWidth: (width: number) => void;
  setFloatingRect: (rect: FloatingChatRect) => void;
  setFloatingCollapsed: (collapsed: boolean) => void;
}

export const useMaximizedChatStore = create<MaximizedChatState>()(
  persist(
    (set) => ({
      // Tabs open full screen with the chat floating; the side panel toggle docks it.
      mode: "floating",
      sidebarWidth: 440,
      floatingRect: null,
      floatingCollapsed: false,
      setMode: (mode) => set({ mode, floatingCollapsed: false }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setFloatingRect: (floatingRect) => set({ floatingRect }),
      setFloatingCollapsed: (floatingCollapsed) => set({ floatingCollapsed }),
    }),
    {
      name: "g3code:maximized-chat",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // Version 1 also had a "hidden" mode; the card's minimize button replaces it.
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<MaximizedChatState> & { mode?: string };
        return { ...state, mode: state.mode === "floating" ? "floating" : "sidebar" };
      },
      partialize: ({ mode, sidebarWidth, floatingRect, floatingCollapsed }) => ({
        mode,
        sidebarWidth,
        floatingRect,
        floatingCollapsed,
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

/** Bottom-right corner with a margin, like the Codex app's floating chat. */
export function defaultFloatingRect(containerWidth: number, containerHeight: number) {
  const margin = 16;
  const width = Math.min(480, Math.max(FLOATING_CHAT_MIN_WIDTH, containerWidth * 0.35));
  const height = Math.min(680, Math.max(FLOATING_CHAT_MIN_HEIGHT, containerHeight * 0.65));
  return clampFloatingRect(
    {
      width,
      height,
      x: containerWidth - width - margin,
      y: containerHeight - height - margin,
    },
    containerWidth,
    containerHeight,
  );
}
