// Renders a PDF to one image per page in the browser, so every instance can show PDFs (no server-side poppler).
// pdf.js is loaded on demand (its own chunk); the worker comes from the package, so it works offline and in the Mac app.
const LONG_SIDE = 1600; // px, longest side of a slide
const PNG_MAX = 700 * 1024; // a busier page falls back to JPEG, so a deck stays under the upload limit

export class PdfError extends Error {}

/** Pages in order, one at a time (a canvas is released before the next page). Throws PdfError for unreadable PDFs. */
export async function renderPdf(file: File, maxPages: number, onProgress: (page: number, total: number) => void): Promise<Blob[]> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try { doc = await task.promise; } catch { throw new PdfError('Couldn\'t read that PDF.'); }
  try {
    const total = doc.numPages;
    if (total > maxPages) throw new PdfError(`That PDF has ${total} pages. At most ${maxPages} slides.`);
    const out: Blob[] = [];
    const canvas = document.createElement('canvas'); // reused, then shrunk to nothing
    for (let n = 1; n <= total; n++) {
      onProgress(n, total);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: LONG_SIDE / Math.max(base.width, base.height) });
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new PdfError('This browser can\'t render PDFs.');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      page.cleanup();
      const toBlob = (type: string, q?: number) => new Promise<Blob | null>(ok => canvas.toBlob(ok, type, q));
      let blob = await toBlob('image/png');
      if (blob && blob.size > PNG_MAX) blob = (await toBlob('image/jpeg', 0.85)) ?? blob;
      if (!blob) throw new PdfError('Couldn\'t render that PDF.');
      out.push(blob);
      await new Promise(r => setTimeout(r)); // let the progress text paint
    }
    canvas.width = canvas.height = 0;
    return out;
  } finally { void task.destroy(); }
}
