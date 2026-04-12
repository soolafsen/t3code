import { describe, expect, it, vi } from "vitest";

import {
  applyDesktopZoomFactor,
  getDesktopZoomShortcutAction,
  getNextDesktopZoomFactor,
  resolveDesktopZoomFactor,
} from "./windowZoom";

describe("windowZoom", () => {
  it("returns the default zoom when the persisted value is missing", () => {
    expect(resolveDesktopZoomFactor(undefined)).toBe(1);
  });

  it("returns the persisted zoom when it matches a supported preset", () => {
    expect(resolveDesktopZoomFactor(1.25)).toBe(1.25);
  });

  it("falls back to the default zoom for unsupported values", () => {
    expect(resolveDesktopZoomFactor(1.2)).toBe(1);
    expect(resolveDesktopZoomFactor("1.25")).toBe(1);
  });

  it("steps between supported zoom presets", () => {
    expect(getNextDesktopZoomFactor(1, "in")).toBe(1.1);
    expect(getNextDesktopZoomFactor(1, "out")).toBe(0.9);
    expect(getNextDesktopZoomFactor(1.5, "in")).toBe(1.5);
    expect(getNextDesktopZoomFactor(0.8, "out")).toBe(0.8);
    expect(getNextDesktopZoomFactor(1.25, "reset")).toBe(1);
  });

  it("maps editor-style shortcuts to zoom actions", () => {
    expect(
      getDesktopZoomShortcutAction({ type: "keyDown", control: true, key: "=", code: "Equal" }),
    ).toBe("in");
    expect(
      getDesktopZoomShortcutAction({ type: "keyDown", meta: true, key: "+", code: "Equal" }),
    ).toBe("in");
    expect(
      getDesktopZoomShortcutAction({
        type: "keyDown",
        control: true,
        key: "-",
        code: "Minus",
      }),
    ).toBe("out");
    expect(
      getDesktopZoomShortcutAction({
        type: "keyDown",
        control: true,
        key: "0",
        code: "Digit0",
      }),
    ).toBe("reset");
    expect(getDesktopZoomShortcutAction({ type: "keyDown", key: "=", code: "Equal" })).toBeNull();
  });

  it("applies the resolved zoom factor to the target", () => {
    const setZoomFactor = vi.fn();

    applyDesktopZoomFactor({ setZoomFactor }, 1.5);
    applyDesktopZoomFactor({ setZoomFactor }, 3);

    expect(setZoomFactor).toHaveBeenNthCalledWith(1, 1.5);
    expect(setZoomFactor).toHaveBeenNthCalledWith(2, 1);
  });
});
