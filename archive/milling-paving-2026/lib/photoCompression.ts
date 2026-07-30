const MAX_LONG_EDGE = 1280
const JPEG_QUALITY = 0.68

/**
 * Resizes to a ~1280px long edge and re-encodes as JPEG at ~65-70% quality
 * before a captured photo ever touches the offline queue — keeps queued
 * photos small enough to reliably upload over field connections. Always
 * re-encodes, even if the source is already a smaller JPEG, so every queued
 * photo has a predictable size/format regardless of the source device's
 * camera settings.
 */
export async function compressImage(file: File | Blob): Promise<Blob> {
  // `imageOrientation: 'from-image'` applies the capture's EXIF rotation
  // during decode — without it, canvas drawImage ignores EXIF entirely and
  // portrait phone photos come out sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    const scale = Math.min(1, MAX_LONG_EDGE / longEdge)
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable.')
    ctx.drawImage(bitmap, 0, 0, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to compress image.'))),
        'image/jpeg',
        JPEG_QUALITY,
      )
    })
  } finally {
    bitmap.close()
  }
}
