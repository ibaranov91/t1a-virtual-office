// Server event log: one short structured line per event on stdout, which the journal keeps (`journalctl -u deck-<name>`).
// Shape: `ev=connect user=u1 name="Kim" tab=…`. Values with spaces are quoted; long ones are cut.
const fmt = (v: unknown) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);
  return /[\s"=]/.test(s) || !s ? JSON.stringify(s) : s;
};
export function logLine(ev: string, fields: Record<string, unknown> = {}) {
  return `ev=${ev}${Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}=${fmt(v)}`).join('')}`;
}
export const logEvent = (ev: string, fields?: Record<string, unknown>) => console.log(logLine(ev, fields));
