import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/**
 * g3code: where the chat goes while the right panel is maximized.
 * `hidden` is upstream's behavior; `sidebar` docks the chat beside the panel;
 * `floating` shows it as a movable, resizable window over the panel.
 */
export type MaximizedChatMode = "hidden" | "sidebar" | "floating";

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
  setMode: (mode: MaximizedChatMode) => void;
  setSidebarWidth: (width: number) => void;
  setFloatingRect: (rect: FloatingChatRect) => void;
}

export const useMaximizedChatStore = create<MaximizedChatState>()(
  persist(
    (set) => ({
      mode: "sidebar",
      sidebarWidth: 420,
      floatingRect: null,
      setMode: (mode) => set({ mode }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setFloatingRect: (floatingRect) => set({ floatingRect }),
    }),
    {
      name: "g3code:maximized-chat",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ mode, sidebarWidth, floatingRect }) => ({ mode, sidebarWidth, floatingRect }),
    },
  ),
);

/** Keeps the sidebar wide enough to use and leaves at least 40% of the layout to the panel. */
export function clampSidebarWidth(width: number, containerWidth: number): number {
  const max = Math.max(SIDEBAR_CHAT_MIN_WIDTH, Math.round(containerWidth * 0.6));
  return Math.min(Math.max(width, SIDEBAR_CHAT_MIN_WIDTH), max);
}

/** Keeps the floating chat inside the layout, shrinking it if the window got smaller. */
export function clampFloatingRect(
  rect: FloatingChatRect,
  containerWidth: number,
  containerHeight: number,
): FloatingChatRect {
  const width = Math.min(Math.max(rect.width, FLOATING_CHAT_MIN_WIDTH), containerWidth);
  const height = Math.min(Math.max(rect.height, FLOATING_CHAT_MIN_HEIGHT), containerHeight);
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, 0), Math.max(0, containerWidth - width)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, containerHeight - height)),
  };
}

/** Bottom-right corner with a margin, like a picture-in-picture window. */
export function defaultFloatingRect(containerWidth: number, containerHeight: number) {
  const margin = 16;
  const width = Math.min(440, Math.max(FLOATING_CHAT_MIN_WIDTH, containerWidth * 0.35));
  const height = Math.min(680, Math.max(FLOATING_CHAT_MIN_HEIGHT, containerHeight - margin * 2));
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
