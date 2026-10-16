import { inNativeApp } from './native';

/** Always opens in a new tab — never replaces the office (some shells ignore target=_blank; the Mac app hands it to the browser). */
export function openExternal(href: string) {
  const w = window.open(href, '_blank');
  if (w) { w.opener = null; return; }
  if (inNativeApp()) return; // the Mac app opened it in the system browser and gave us nothing back
  // popup blocked: fall back to a real new-tab anchor click
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
}
export function ExternalLink({ href, onOpen, className, children }: { href: string; onOpen?: () => void; className?: string; children: React.ReactNode }) {
  const open = (e: React.MouseEvent) => { e.preventDefault(); openExternal(href); onOpen?.(); };
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={open}>{children}</a>;
}
