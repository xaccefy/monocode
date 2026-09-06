//! Image fallback for clipboard paste on Linux/Wayland.
//!
//! WebKitGTK on Wayland often exposes zero files on paste even when an image
//! sits in the clipboard, so the composer calls this when the web clipboard
//! comes up empty. Reads via `wl-paste`; returns None when no image type is
//! offered or the helper is missing.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::process::Command;

/// PNG/JPEG bytes plus mime, JSON-safe for the frontend.
#[derive(Serialize)]
pub struct ClipboardImage {
    pub mime: String,
    pub base64: String,
}

/// At most 10 MiB; screenshots bigger than this do not belong in a prompt.
const MAX_BYTES: usize = 10 * 1024 * 1024;

#[tauri::command]
pub async fn clipboard_image() -> Option<ClipboardImage> {
    #[cfg(target_os = "linux")]
    {
        linux_clipboard_image()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn linux_clipboard_image() -> Option<ClipboardImage> {
    let types = Command::new("wl-paste").arg("--list-types").output().ok()?;
    if !types.status.success() {
        return None;
    }
    let offered = String::from_utf8_lossy(&types.stdout);
    let mime = ["image/png", "image/jpeg", "image/webp"]
        .into_iter()
        .find(|want| offered.lines().any(|line| line.trim() == *want))?;
    let dump = Command::new("wl-paste")
        .arg("--type")
        .arg(mime)
        .output()
        .ok()?;
    if !dump.status.success() || dump.stdout.is_empty() || dump.stdout.len() > MAX_BYTES {
        return None;
    }
    Some(ClipboardImage {
        mime: mime.to_string(),
        base64: STANDARD.encode(&dump.stdout),
    })
}
