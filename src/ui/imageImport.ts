// Loads an image chosen by the user and turns it into a small grayscale data
// URL that can live inside the scene (and the project file).

const MAX_SIDE = 400;

export function pickImage(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      imageToGrayDataUrl(f).then(resolve, reject);
    };
    input.click();
  });
}

export async function imageToGrayDataUrl(file: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This file could not be read as an image.');
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent areas count as white (background)
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const l = Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    px[i] = px[i + 1] = px[i + 2] = l;
    px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // PNG keeps logos crisp; JPEG is much smaller for photos. Keep the smaller one.
  const png = canvas.toDataURL('image/png');
  const jpg = canvas.toDataURL('image/jpeg', 0.92);
  return png.length <= jpg.length ? png : jpg;
}
