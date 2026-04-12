import {
  DEFAULT_DESKTOP_ZOOM_FACTOR,
  DESKTOP_ZOOM_FACTOR_VALUES,
  type DesktopZoomFactor,
} from "@t3tools/contracts/settings";

const DESKTOP_ZOOM_FACTORS = new Set<number>(DESKTOP_ZOOM_FACTOR_VALUES);

export type DesktopZoomShortcutAction = "in" | "out" | "reset";

export function resolveDesktopZoomFactor(rawZoomFactor: unknown): DesktopZoomFactor {
  return typeof rawZoomFactor === "number" && DESKTOP_ZOOM_FACTORS.has(rawZoomFactor)
    ? (rawZoomFactor as DesktopZoomFactor)
    : DEFAULT_DESKTOP_ZOOM_FACTOR;
}

export function getNextDesktopZoomFactor(
  rawZoomFactor: unknown,
  action: DesktopZoomShortcutAction,
): DesktopZoomFactor {
  const currentZoomFactor = resolveDesktopZoomFactor(rawZoomFactor);
  const currentIndex = DESKTOP_ZOOM_FACTOR_VALUES.indexOf(currentZoomFactor);

  if (action === "reset") {
    return DEFAULT_DESKTOP_ZOOM_FACTOR;
  }

  if (action === "in") {
    return DESKTOP_ZOOM_FACTOR_VALUES[
      Math.min(currentIndex + 1, DESKTOP_ZOOM_FACTOR_VALUES.length - 1)
    ]!;
  }

  return DESKTOP_ZOOM_FACTOR_VALUES[Math.max(currentIndex - 1, 0)]!;
}

export function getDesktopZoomShortcutAction(input: {
  readonly type?: string;
  readonly key?: string;
  readonly code?: string;
  readonly control?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
}): DesktopZoomShortcutAction | null {
  if (input.type !== "keyDown") {
    return null;
  }

  if (!(input.control || input.meta) || input.alt) {
    return null;
  }

  if (input.key === "0" || input.code === "Digit0" || input.code === "Numpad0") {
    return "reset";
  }

  if (
    input.key === "-" ||
    input.key === "_" ||
    input.code === "Minus" ||
    input.code === "NumpadSubtract"
  ) {
    return "out";
  }

  if (
    input.key === "=" ||
    input.key === "+" ||
    input.code === "Equal" ||
    input.code === "NumpadAdd"
  ) {
    return "in";
  }

  return null;
}

export function applyDesktopZoomFactor(
  target: {
    readonly setZoomFactor: (zoomFactor: number) => void;
  },
  rawZoomFactor: unknown,
): void {
  target.setZoomFactor(resolveDesktopZoomFactor(rawZoomFactor));
}
