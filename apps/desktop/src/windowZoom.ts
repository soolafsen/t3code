import {
  DEFAULT_DESKTOP_ZOOM_FACTOR,
  DESKTOP_ZOOM_FACTOR_VALUES,
  type DesktopZoomFactor,
} from "@t3tools/contracts/settings";

const DESKTOP_ZOOM_FACTORS = new Set<number>(DESKTOP_ZOOM_FACTOR_VALUES);

export type DesktopZoomShortcutAction = "in" | "out" | "reset";
export interface WindowBoundsLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowSizeLike {
  readonly width: number;
  readonly height: number;
}

export function resolveDesktopZoomFactor(rawZoomFactor: unknown): DesktopZoomFactor {
  return typeof rawZoomFactor === "number" && DESKTOP_ZOOM_FACTORS.has(rawZoomFactor)
    ? (rawZoomFactor as DesktopZoomFactor)
    : DEFAULT_DESKTOP_ZOOM_FACTOR;
}

export function scaleWindowDimension(value: number, rawZoomFactor: unknown): number {
  return Math.max(1, Math.round(value * resolveDesktopZoomFactor(rawZoomFactor)));
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

export function getScaledWindowBounds(input: {
  readonly bounds: WindowBoundsLike;
  readonly currentZoomFactor: unknown;
  readonly nextZoomFactor: unknown;
  readonly minimumSize: WindowSizeLike;
  readonly workArea: WindowBoundsLike;
}): WindowBoundsLike {
  const currentZoomFactor = resolveDesktopZoomFactor(input.currentZoomFactor);
  const nextZoomFactor = resolveDesktopZoomFactor(input.nextZoomFactor);
  const ratio = nextZoomFactor / currentZoomFactor;

  const nextWidth = Math.min(
    input.workArea.width,
    Math.max(input.minimumSize.width, Math.round(input.bounds.width * ratio)),
  );
  const nextHeight = Math.min(
    input.workArea.height,
    Math.max(input.minimumSize.height, Math.round(input.bounds.height * ratio)),
  );

  const minX = input.workArea.x;
  const maxX = input.workArea.x + input.workArea.width - nextWidth;
  const minY = input.workArea.y;
  const maxY = input.workArea.y + input.workArea.height - nextHeight;

  const centeredX = Math.round(input.bounds.x - (nextWidth - input.bounds.width) / 2);
  const centeredY = Math.round(input.bounds.y - (nextHeight - input.bounds.height) / 2);

  return {
    x: Math.max(minX, Math.min(centeredX, maxX)),
    y: Math.max(minY, Math.min(centeredY, maxY)),
    width: nextWidth,
    height: nextHeight,
  };
}

export function applyDesktopZoomFactor(
  target: {
    readonly setZoomFactor: (zoomFactor: number) => void;
  },
  rawZoomFactor: unknown,
): void {
  target.setZoomFactor(resolveDesktopZoomFactor(rawZoomFactor));
}
