/**
 * Navigation store — active screen and badge counts.
 */

import type { ScreenId } from "../types.js";
import { send } from "./websocket.svelte.js";

/** All available screens in display order. */
export const SCREENS: readonly ScreenId[] = [
  "chat",
  "agents",
  "sentinel",
  "workflows",
  "health",
  "settings",
  "logs",
  "memory",
];

/** Currently active screen. */
let _activeScreen: ScreenId = $state("chat");

/** Badge counts per screen. */
let _badges: Record<ScreenId, number> = $state({
  chat: 0,
  agents: 0,
  sentinel: 0,
  workflows: 0,
  health: 0,
  settings: 0,
  logs: 0,
  memory: 0,
});

/** Status dot per screen. */
let _statusDots: Record<ScreenId, string | null> = $state({
  chat: null,
  agents: null,
  sentinel: null,
  workflows: null,
  health: null,
  settings: null,
  logs: null,
  memory: null,
});

/** Get the currently active screen. */
export function getActiveScreen(): ScreenId {
  return _activeScreen;
}

/** Get badge counts per screen. */
export function getBadges(): Record<ScreenId, number> {
  return _badges;
}

/** Get status dots per screen. */
export function getStatusDots(): Record<ScreenId, string | null> {
  return _statusDots;
}

/** Navigate to a screen. */
export function navigateTo(screen: ScreenId): void {
  const previous = _activeScreen;
  if (previous === screen) return;
  _activeScreen = screen;
  location.hash = `#${screen}`;
  send({
    topic: "shell",
    action: "screen_changed",
    payload: { screen, previous },
  });
}

/** Resolve screen from URL hash. */
export function resolveScreenFromHash(): void {
  const hash = location.hash.slice(1);
  if (SCREENS.includes(hash as ScreenId)) {
    _activeScreen = hash as ScreenId;
  }
}

/** Set badge count for a screen. */
export function setBadge(screen: ScreenId, count: number): void {
  _badges[screen] = count;
}

/** Set status dot for a screen. */
export function setStatusDot(screen: ScreenId, status: string | null): void {
  _statusDots[screen] = status;
}
