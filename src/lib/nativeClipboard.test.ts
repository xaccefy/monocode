import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readNativeClipboardImage } from "./nativeClipboard";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("readNativeClipboardImage", () => {
  it("returns a File for png bytes", async () => {
    vi.mocked(invoke).mockResolvedValue({
      mime: "image/png",
      base64: PNG_B64,
    });
    const file = await readNativeClipboardImage();
    expect(file?.type).toBe("image/png");
    expect(file?.name).toBe("clipboard.png");
    expect(file?.size).toBeGreaterThan(0);
  });

  it("returns null when nothing offered", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await readNativeClipboardImage()).toBeNull();
  });

  it("returns null on invoke failure", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    expect(await readNativeClipboardImage()).toBeNull();
  });
});
