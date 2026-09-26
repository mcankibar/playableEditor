const THUMB_WIDTH = 280;

function gameCanvas(doc) {
  const named = doc.querySelector("#canvas");
  if (named?.width > 1) return named;
  let best = null;
  let area = 0;
  for (const canvas of doc.querySelectorAll("canvas")) {
    const size = canvas.width * canvas.height;
    if (size > area) {
      area = size;
      best = canvas;
    }
  }
  return best;
}

/** JPEG data URL, or null when the frame is blank or the canvas can't be read. */
function jpegOf(source) {
  const ratio = source.height / source.width;
  if (!Number.isFinite(ratio) || source.width < 2) return null;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = Math.max(1, Math.round(THUMB_WIDTH * ratio));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let opaque = 0;
  let samples = 0;
  for (let i = 3; i < data.length; i += 64) {
    samples++;
    if (data[i] > 8) opaque++;
  }
  // A cleared WebGL buffer (preserveDrawingBuffer is off) is fully transparent.
  if (!samples || opaque / samples < 0.01) return null;
  return canvas.toDataURL("image/jpeg", 0.72);
}

/**
 * Picture of the playable's canvas. Scheduled on the game's own animation frame, after the
 * game has drawn, while the WebGL buffer still holds the image.
 */
export function captureGameFrame(iframe) {
  const win = iframe?.contentWindow;
  const doc = iframe?.contentDocument;
  if (!win || !doc) return Promise.resolve(null);
  const source = gameCanvas(doc);
  if (!source) return Promise.resolve(null);
  return new Promise((resolve) => {
    let tries = 0;
    const attempt = () => {
      // After the game's own frame callback, the WebGL buffer still holds the picture.
      win.requestAnimationFrame(() => {
        tries++;
        try {
          const url = jpegOf(source);
          if (url || tries >= 4) resolve(url);
          else attempt();
        } catch {
          resolve(null);
        }
      });
    };
    attempt();
  });
}
