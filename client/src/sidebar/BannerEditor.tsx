import { useEffect, useRef, useState } from 'react';
import { BANNER_PATTERNS, type Banner, type Look } from '../../../shared/protocol';
import type { Store } from '../net';
import { bannerStyle } from './model';

// AppearanceMenu's LOOK_COLORS.shirt; kept here because App.tsx is outside this feature's scope.
const SHIRT_COLORS = ['#4a7ab0', '#b4534a', '#7a9a55', '#d0a040', '#8a5aa0', '#4f9a92', '#d8805a', '#e8e0d0', '#5a5a6e', '#c8607a', '#6a8ad0', '#9a7a50'];
const TABS = ['Color', 'Pattern', 'Image'] as const;
type Tab = typeof TABS[number];
async function cropImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 680; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image editing is unavailable.');
    const scale = Math.max(680 / image.naturalWidth, 240 / image.naturalHeight);
    ctx.drawImage(image, (680 - image.naturalWidth * scale) / 2, (240 - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
    const encode = (type: string) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.85));
    const webp = await encode('image/webp');
    const blob = webp?.type === 'image/webp' ? webp : await encode('image/jpeg');
    if (!blob || blob.type !== 'image/webp' && blob.type !== 'image/jpeg') throw new Error('Could not encode this image.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

export function BannerEditor({ store, initial, look, onPreview, onClose }: {
  store: Store; initial: Banner | null | undefined; look: Look;
  onPreview: (banner: Banner | null) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initial?.kind === 'pattern' ? 'Pattern' : initial?.kind === 'image' ? 'Image' : 'Color');
  const [color, setColor] = useState(initial && initial.kind !== 'image' ? initial.color : look.shirt);
  const [pattern, setPattern] = useState<typeof BANNER_PATTERNS[number]>(initial?.kind === 'pattern' ? initial.pattern : 'stripes');
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), generation = useRef(0);
  const draft: Banner = tab === 'Image' ? { kind: 'image', url: image?.url ?? (initial?.kind === 'image' ? initial.url : '') }
    : tab === 'Pattern' ? { kind: 'pattern', pattern, color } : { kind: 'color', color };
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); return () => { generation.current++; }; }, []);
  useEffect(() => { onPreview(draft.kind === 'image' && !draft.url ? initial ?? null : draft); }, [tab, color, pattern, image]);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);
  const selectFile = async (file?: File) => {
    if (!file) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const blob = await cropImage(file);
      if (current === generation.current) setImage({ blob, url: URL.createObjectURL(blob) });
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Could not read this image.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const save = async () => {
    if (busy) return;
    if (tab !== 'Image') { store.setBanner(draft); onClose(); return; }
    if (!image) return;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/banner', { method: 'POST', headers: { 'x-deck-session': store.sessionId }, body: image.blob });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Upload failed.');
      if (current === generation.current) onClose();
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <div ref={root} className="sb-banner-editor" aria-label="Banner editor" onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  }}>
    <div role="tablist" aria-label="Banner type" className="sb-banner-tabs">{TABS.map((name, i) => <button type="button" role="tab" key={name}
      id={`banner-tab-${name}`} aria-controls="banner-tabpanel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
      className="ghost" disabled={busy} onClick={() => { setTab(name); setError(''); }} onKeyDown={e => {
        const next = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : null;
        if (next !== null) { e.preventDefault(); setTab(TABS[next]); root.current?.querySelector<HTMLButtonElement>(`#banner-tab-${TABS[next]}`)?.focus(); }
      }}>{name}</button>)}</div>
    <div role="tabpanel" id="banner-tabpanel" aria-labelledby={`banner-tab-${tab}`} className="sb-banner-options" aria-busy={busy}>
      {tab === 'Pattern' && <div className="sb-banner-patterns">{BANNER_PATTERNS.map(p => <button type="button" key={p} className="ghost"
        aria-label={p} aria-pressed={pattern === p} onClick={() => setPattern(p)}><span style={{ background: bannerStyle({ kind: 'pattern', pattern: p, color }, look) }} /><small>{p}</small></button>)}</div>}
      {tab !== 'Image' ? <>
        <div className="swatches sb-banner-swatches" role="group" aria-label="Banner colors">{SHIRT_COLORS.map(c => <button type="button" key={c} aria-label={`Color ${c}`}
          className={`swatch${color.toLowerCase() === c ? ' selected' : ''}`} aria-pressed={color.toLowerCase() === c} style={{ background: c }} onClick={() => setColor(c)} />)}</div>
        {tab === 'Color' && <label className="sb-banner-custom">Custom color<input type="color" value={color} onChange={e => setColor(e.target.value)} /></label>}
      </> : <>
        <input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void selectFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" className="ghost" disabled={busy} onClick={() => input.current?.click()}>Upload image</button>
        {(image || initial?.kind === 'image') && <div className="sb-banner-image-preview" role="img" aria-label="Banner preview" style={{ background: bannerStyle(draft, look) }} />}
        <small>Centered crop · 680 × 240 px · up to 1 MB</small>
      </>}
      {error && <p className="sb-banner-error" role="alert">{error}</p>}
      {busy && <p role="status">Preparing or uploading image…</p>}
    </div>
    <footer><button type="button" className="ghost" disabled={busy} onClick={() => { store.setBanner(null); onClose(); }}>Reset to default</button>
      <button type="button" disabled={busy || tab === 'Image' && !image} onClick={() => void save()}>{busy ? 'Please wait…' : 'Save'}</button></footer>
  </div>;
}
