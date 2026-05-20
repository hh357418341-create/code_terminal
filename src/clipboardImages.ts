import { invoke } from "./tauriRuntime";

export function getClipboardImageItem(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return null;

  const items = Array.from(dataTransfer.items);
  return items.find((item) => item.kind === "file" && item.type.startsWith("image/")) ?? null;
}

export async function saveClipboardImage(item: DataTransferItem) {
  const file = item.getAsFile();
  if (!file) return null;

  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const path = await invoke<string>("save_pasted_image", {
    mimeType: file.type || item.type,
    bytes,
  });

  return path;
}

export function formatPastedImagePath(path: string) {
  return `"${path.replace(/"/g, '\\"')}"`;
}
