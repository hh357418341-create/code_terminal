import { invoke } from "./tauriRuntime.core";

export function getClipboardImageItem(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return null;

  return (
    Array.from(dataTransfer.items).find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    ) ?? null
  );
}

export async function saveClipboardImage(item: DataTransferItem) {
  const file = item.getAsFile();
  if (!file) return null;

  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<string>("save_pasted_image", {
    mimeType: file.type || item.type,
    bytes,
  });
}

export function formatPastedImagePath(path: string) {
  return `"${path.replace(/"/g, '\\"')}"`;
}

