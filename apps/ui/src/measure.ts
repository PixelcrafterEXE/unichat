/** Pixel size of a picked image / video (best effort, never throws): sent along so providers can lay out previews. */
export async function measureMedia(blob: Blob, kind: string): Promise<{ width?: number; height?: number }> {
  try {
    if (kind === "image" && typeof createImageBitmap === "function") { const b = await createImageBitmap(blob); const r = { width: b.width, height: b.height }; b.close?.(); return r; }
    if (kind === "video") {
      return await new Promise((ok) => {
        const v = document.createElement("video"), url = URL.createObjectURL(blob), done = (r: { width?: number; height?: number }) => { URL.revokeObjectURL(url); ok(r); };
        v.preload = "metadata"; v.onloadedmetadata = () => done(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : {}); v.onerror = () => done({}); setTimeout(() => done({}), 3000); v.src = url;
      });
    }
  } catch { /* unreadable: send without */ }
  return {};
}
export const isGif = (mime: string, name?: string) => mime === "image/gif" || (/\.gif$/i.test(name ?? "") && mime.startsWith("image/"));
