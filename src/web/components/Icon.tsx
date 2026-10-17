// Hand-drawn 24px stroke icons. Decorative by default (aria-hidden); pass `label` when an icon stands alone.
import type { ReactNode } from 'react'

const P: Record<string, ReactNode> = {
  circle: <circle cx="12" cy="12" r="7.5" />,
  pause: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 9v6M14 9v6" />
    </>
  ),
  spinner: (
    <>
      <circle cx="12" cy="12" r="8" opacity="0.25" />
      <path d="M20 12a8 8 0 0 0-8-8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M12 14.2v2.2" />
    </>
  ),
  flag: <path d="M6 21V4.5M6 5h11l-2.2 3.8L17 12.5H6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.3l2.6 2.6 5-5.2" />
    </>
  ),
  slash: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </>
  ),
  x: <path d="M7 7l10 10M17 7L7 17" />,
  xCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3.5 12s3-6 8.5-6c1.6 0 3 .5 4.2 1.2M20.5 12s-3 6-8.5 6c-1.6 0-3-.5-4.2-1.2" />
      <path d="M4 4l16 16" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7.5 14h9" />
    </>
  ),
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  replay: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.8h3.8" />
      <path d="M10.5 9.5l4 2.5-4 2.5z" />
    </>
  ),
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5L11 13M18 14v5.5H4.5V6H10" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2" />
    </>
  ),
  shield: <path d="M12 3.2l7 2.8v5.3c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.5M12 17.2h.01" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  undo: <path d="M9 14L4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3" />,
  highlight: <path d="M14.5 4.5l5 5L10 19H5v-5zM12 7l5 5M4 21h16" />,
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.2" />
      <path d="M3 9.5h18M7 14.5h4" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6-2.4 1.6L6 20.5z" />
      <path d="M9 8h6M9 11.5h6M9 15h3.5" />
    </>
  ),
  refresh: <path d="M19.5 12a7.5 7.5 0 0 1-13.1 5M4.5 12a7.5 7.5 0 0 1 13.1-5M17.8 3.5v3.7h-3.7M6.2 20.5v-3.7h3.7" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  spark: <path d="M12 3.5c.6 4.3 2.7 7 8.5 8.5-5.8 1.5-7.9 4.2-8.5 8.5-.6-4.3-2.7-7-8.5-8.5 5.8-1.5 7.9-4.2 8.5-8.5z" />,
  hand: <path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5.5M11.5 11V4.5a1.5 1.5 0 0 1 3 0V11M14.5 11V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.6a6 6 0 0 1-5-2.7L3 13.6a1.5 1.5 0 0 1 2.5-1.7l3 3.1" />,
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0M16 5.2a3.5 3.5 0 0 1 0 6.6M18 13.8a6.2 6.2 0 0 1 3.2 5.7" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  send: <path d="M4 12l16-7.5-6 16-2.6-6.4z" />,
  scale: <path d="M12 4v16M5 20h14M5 8l-2.5 6h5zM19 8l-2.5 6h5zM5 8h14" />,
  gauge: (
    <>
      <path d="M4 16a8 8 0 1 1 16 0" />
      <path d="M12 16l3.5-5" />
    </>
  ),
  bank: <path d="M3.5 9.5L12 4l8.5 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17" />,
  webhook: (
    <>
      <circle cx="7" cy="16.5" r="2.5" />
      <circle cx="17" cy="16.5" r="2.5" />
      <circle cx="12" cy="7" r="2.5" />
      <path d="M10.8 9.2L7.9 14M13.2 9.2l2.9 4.8M9.5 16.5h5" />
    </>
  ),
  scroll: <path d="M12 5v14M7 14l5 5 5-5" />,
  download: <path d="M12 4.5v10M7.5 10.5l4.5 4.5 4.5-4.5M5 19.5h14" />,
}

export type IconName = keyof typeof P

export function Icon({ name, label, className, spin }: { name: IconName | string; label?: string; className?: string; spin?: boolean }) {
  const cls = [className, spin || name === 'spinner' ? 'spin' : ''].filter(Boolean).join(' ') || undefined
  return (
    <svg
      viewBox="0 0 24 24"
      // Text-sized by default; contexts that want another size set width/height in CSS, which wins over these attributes.
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cls}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {P[name] ?? P.circle}
    </svg>
  )
}
