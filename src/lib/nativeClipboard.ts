import { invoke } from "@tauri-apps/api/core";

type NativeClipboardImage = {
  mime: string;
  base64: string;
};

function extensionFor(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

/**
 * Native image fallback for Ctrl+V on Wayland, where WebKitGTK often exposes
 * zero clipboard files. Returns null when no image is offered. Text pastes
 * never reach here, so this only runs when the web clipboard came up empty.
 */
export async function readNativeClipboardImage(): Promise<File | null> {
  try {
    const res = await invoke<NativeClipboardImage | null>("clipboard_image");
    if (!res || !res.base64) return null;
    const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    return new File([bytes], `clipboard.${extensionFor(res.mime)}`, {
      type: res.mime,
    });
  } catch {
    return null;
  }
}
