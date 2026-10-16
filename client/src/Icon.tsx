import type { ButtonHTMLAttributes } from 'react';

const paths = {
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10Z',
  'phone-off': 'M10.7 13.3a16 16 0 0 0 3.4 2.6l1.6-1.6a1 1 0 0 1 1-.2c1.1.4 2.3.6 3.5.6a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.4a1 1 0 0 1 1 1c0 1.2.2 2.4.6 3.5a1 1 0 0 1-.2 1L7.2 10.1M2 2l20 20',
  'arrow-down': 'M12 3v18m-7-7 7 7 7-7',
  mic: 'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6',
  headphones: 'M3 14v-3a9 9 0 0 1 18 0v3M5 12H3v6a2 2 0 0 0 2 2h2v-8H5ZM19 12h2v6a2 2 0 0 1-2 2h-2v-8h2Z',
  volume: 'M3 9v6h4l5 4V5L7 9H3ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14',
  settings: 'm10 3-.6 2.2-1.7 1-2.2-.6-2 3.4 1.6 1.6v2L3.5 14.2l2 3.4 2.2-.6 1.7 1L10 21h4l.6-3 1.7-1 2.2.6 2-3.4-1.6-1.6v-2l1.6-1.6-2-3.4-2.2.6-1.7-1L14 3h-4ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  hand: 'M8 12V5a1.5 1.5 0 0 1 3 0v6M11 5a1.5 1.5 0 0 1 3 0v6M14 7a1.5 1.5 0 0 1 3 0v5M8 12l-2-2a1.5 1.5 0 0 0-2 2l4 6c1 2 3 3 5 3a6 6 0 0 0 6-6v-3a1 1 0 0 0-2 0',
  swap: 'M3 7h17l-4-4M21 17H4l4 4',
  disconnect: 'M2.5 15.5c5.2-5.3 13.8-5.3 19 0l-2.6 2.6-3.6-1.6v-3.2a11.5 11.5 0 0 0-6.6 0v3.2l-3.6 1.6-2.6-2.6Z',
  close: 'm6 6 12 12M6 18 18 6',
  signal: 'M5 19h.01M5 14a5 5 0 0 1 5 5M5 9a10 10 0 0 1 10 10M5 4a15 15 0 0 1 15 15',
  more: 'M5 11v2M12 11v2M19 11v2',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm6 15 6-6 6 6',
  'chevron-left': 'm15 6-6 6 6 6',
  'chevron-right': 'm9 6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  play: 'm8 4 12 8-12 8V4Z',
  pause: 'M7 4h3v16H7V4ZM15 4h3v16h-3V4Z',
  skip: 'm5 5 10 7-10 7V5ZM19 5v14',
  stop: 'M5 5h14v14H5V5Z',
  message: 'M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-4V9a8 8 0 0 1 8-7h2a8 8 0 0 1 8 8v1ZM7 8h10M7 12h7',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4',
  map: 'm3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3V5ZM9 2v17M15 5v17',
  locate: 'M12 2v3M12 19v3M2 12h3M19 12h3M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  trophy: 'M7 3h10v6a5 5 0 0 1-10 0V3ZM7 5H3v2a4 4 0 0 0 4 4M17 5h4v2a4 4 0 0 1-4 4M12 14v6M7 21h10',
  edit: 'm15 3 6 6-12 12H3v-6L15 3ZM12 6l6 6',
  shirt: 'm8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z',
  backpack: 'M8 5V3h8v2M6 5h12a2 2 0 0 1 2 2v14H4V7a2 2 0 0 1 2-2ZM8 13h8v5H8v-5ZM9 9h6',
  calendar: 'M4 5h16v16H4V5ZM4 10h16M8 2v5M16 2v5M8 14h2M14 14h2M8 17h2',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v6l4 2',
  lock: 'M5 10h14v11H5V10ZM8 10V6a4 4 0 0 1 8 0v4M12 14v3',
  logout: 'M9 3H3v18h6M8 12h13l-4-4M21 12l-4 4',
  monitor: 'M3 3h18v14H3V3ZM12 17v4M8 21h8',
  trash: 'M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7M14 10v7',
  send: 'm22 2-7 20-4-9-9-4L22 2ZM11 13 22 2',
  follow: 'M13 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5 13l4-4 5 2 3-2M9 9l2 7-5 5M11 16l6 5',
  smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 9h.01M16 9h.01M8 14a4 4 0 0 0 8 0',
  knock: 'M8 11V7a2 2 0 0 1 4 0v4M12 8a2 2 0 0 1 4 0v4M16 10a2 2 0 0 1 4 0v6a6 6 0 0 1-6 6h-2c-2 0-3-1-4-3l-4-5a2 2 0 0 1 3-2l1 1M3 3l2 2M8 1v2',
  portal: 'M18 12c0 6-3 10-6 10S6 18 6 12 9 2 12 2s6 4 6 10ZM3 12h18m-4-4 4 4-4 4',
  light: 'M9 18h6M10 22h4M8 14a6 6 0 1 1 8 0l-1 4H9l-1-4Z',
  sparkles: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  music: 'M9 18V5l12-3v13M9 8l12-3M9 18c0 2-2 3-4 3s-3-1-3-2 2-3 4-3 3 1 3 2ZM21 15c0 2-2 3-4 3s-3-1-3-2 2-3 4-3 3 1 3 2Z',
  book: 'M12 4C9 2 5 2 2 4v16c3-2 7-2 10 0 3-2 7-2 10 0V4c-3-2-7-2-10 0ZM12 4v16',
  'arrow-up': 'M12 21V3m-7 7 7-7 7 7',
  'arrow-left': 'M21 12H3m7-7-7 7 7 7',
  'arrow-right': 'M3 12h18m-7-7 7 7-7 7',
  rotate: 'M3 10a9 9 0 1 1 1 7M3 3v7h7',
  'expand-horizontal': 'M3 12h18m-6-6 6 6-6 6M9 6l-6 6 6 6',
  'shrink-horizontal': 'M2 12h7L4 7M9 12l-5 5M22 12h-7l5-5M15 12l5 5',
  'expand-vertical': 'M12 3v18m-6-6 6 6 6-6M6 9l6-6 6 6',
  'shrink-vertical': 'M12 2v7L7 4M12 9l5-5M12 22v-7l-5 5M12 15l5 5',
} as const;

export type IconName = keyof typeof paths;

/** Shared 24px geometry for controls; game art and reactions keep their own assets. */
export function Icon({ name, off = false }: { name: IconName; off?: boolean }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[name]} fill={name === 'disconnect' ? 'currentColor' : undefined} />{/* the handset reads as one solid shape, like Discord's */}{off && <path className="icon-slash" d="M3 3l18 18" />}
  </svg>;
}

export function IconButton({ icon, label, off, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; off?: boolean }) {
  return <button type="button" aria-label={label} title={label} {...props} className={`icon-button ${className}`}><Icon name={icon} off={off} />{children}</button>;
}
