const BMP_FILE_HEADER_SIZE = 14;
const BMP_DIB_HEADER_SIZE = 108;
const BMP_HEADER_SIZE = BMP_FILE_HEADER_SIZE + BMP_DIB_HEADER_SIZE;
const BYTES_PER_PIXEL = 4;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export function estimateBmp32Size(width: number, height: number): number {
  if (width <= 0 || height <= 0) {
    return BMP_HEADER_SIZE;
  }

  return BMP_HEADER_SIZE + width * height * BYTES_PER_PIXEL;
}

export function fitDimensionsToMaxBytes(
  width: number,
  height: number,
  maxBytes: number,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) {
    return { width: 1, height: 1, scaled: true };
  }

  let nextWidth = width;
  let nextHeight = height;

  while (estimateBmp32Size(nextWidth, nextHeight) > maxBytes) {
    const scale = Math.sqrt(maxBytes / estimateBmp32Size(nextWidth, nextHeight));
    const reducedWidth = Math.max(1, Math.floor(nextWidth * scale));
    const reducedHeight = Math.max(1, Math.floor(nextHeight * scale));

    if (reducedWidth === nextWidth && reducedHeight === nextHeight) {
      if (nextWidth >= nextHeight && nextWidth > 1) {
        nextWidth -= 1;
      } else if (nextHeight > 1) {
        nextHeight -= 1;
      } else {
        break;
      }
    } else {
      nextWidth = reducedWidth;
      nextHeight = reducedHeight;
    }
  }

  return {
    width: nextWidth,
    height: nextHeight,
    scaled: nextWidth !== width || nextHeight !== height,
  };
}

export function encodeBmp32(imageData: ImageData): Blob {
  const { width, height, data } = imageData;
  const pixelDataSize = width * height * BYTES_PER_PIXEL;
  const totalSize = BMP_HEADER_SIZE + pixelDataSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, totalSize, true);
  view.setUint32(10, BMP_HEADER_SIZE, true);

  view.setUint32(14, BMP_DIB_HEADER_SIZE, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 3, true);
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);
  view.setUint32(54, 0x00ff0000, true);
  view.setUint32(58, 0x0000ff00, true);
  view.setUint32(62, 0x000000ff, true);
  view.setUint32(66, 0xff000000, true);
  view.setUint32(70, 0x57696e20, true);

  const pixelOffset = BMP_HEADER_SIZE;

  for (let source = 0, target = pixelOffset; source < data.length; source += 4, target += 4) {
    bytes[target] = data[source + 2];
    bytes[target + 1] = data[source + 1];
    bytes[target + 2] = data[source];
    bytes[target + 3] = data[source + 3];
  }

  return new Blob([buffer], { type: "image/bmp" });
}
