import { memo, useId, type ReactNode } from 'react';

export type IconName =
  | 'screen'
  | 'microphone'
  | 'microphoneOff'
  | 'volume'
  | 'volumeOff'
  | 'chat'
  | 'send'
  | 'hangup'
  | 'link'
  | 'copy'
  | 'settings'
  | 'users'
  | 'crown'
  | 'close'
  | 'chevron'
  | 'chevronDown'
  | 'smile'
  | 'keyboard'
  | 'search'
  | 'qr'
  | 'more'
  | 'expand'
  | 'compress'
  | 'pip'
  | 'wake'
  | 'motion'
  | 'grid'
  | 'download'
  | 'refresh'
  | 'warning'
  | 'check'
  | 'guide';

const ICON_PATHS: Record<IconName, ReactNode> = {
  screen: <><rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M8 21h8M12 17v4" /></>,
  microphone: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" /></>,
  microphoneOff: <><path d="m4 4 16 16M9 5.5V11a3 3 0 0 0 4.7 2.45M15 9V6a3 3 0 0 0-5.2-2.05M5.5 11.5a6.5 6.5 0 0 0 10.9 4.8M18.5 11.5a6.5 6.5 0 0 1-.7 2.9M12 18v3M8.5 21h7" /></>,
  volume: <><path d="M5 10v4h4l5 4V6l-5 4H5Z" /><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11" /></>,
  volumeOff: <><path d="M5 10v4h4l5 4V6l-5 4H5ZM17 9l5 6M22 9l-5 6" /></>,
  chat: <path d="M4 5.5h16v11H9l-5 3v-14Z" />,
  send: <><path d="M12 20V5" /><path d="m6.5 10.5 5.5-5.5 5.5 5.5" /></>,
  hangup: <path d="M4.2 15.1c4.9-4.4 10.7-4.4 15.6 0 .7.6.7 1.7.1 2.3l-1.3 1.3c-.5.5-1.3.6-1.9.2l-2.2-1.5c-.4-.3-.7-.8-.6-1.3l.1-1.1a10.8 10.8 0 0 0-4 0l.1 1.1c.1.5-.2 1-.6 1.3l-2.2 1.5c-.6.4-1.4.3-1.9-.2l-1.3-1.3c-.6-.6-.6-1.7.1-2.3Z" />,
  link: <><path d="M9.5 14.5 14.5 9" /><path d="M7.5 17H6a4 4 0 0 1 0-8h4M16.5 7H18a4 4 0 0 1 0 8h-4" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  settings: <><path d="M4 6h5M13 6h7M4 12h10M18 12h2M4 18h3M11 18h9" /><circle cx="11" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  users: <><circle cx="9" cy="9" r="3" /><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M16 6.5a3 3 0 0 1 0 5.8M16.5 14c2.5.5 3.7 2.4 4 5" /></>,
  crown: <path d="m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7Z" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5c2 2 5 2 7 0M9 9.5h.01M15 9.5h.01" /></>,
  keyboard: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M6.5 9h.01M10.2 9h.01M13.8 9h.01M17.5 9h.01M6.5 12.5h.01M10.2 12.5h.01M13.8 12.5h.01M17.5 12.5h.01M8 16h8" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM18 14h3M21 14v3M14 19h3v2M19 18h2v3" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  expand: <><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></>,
  compress: <><path d="M8 3v5H3M16 3v5h5M21 16h-5v5M3 16h5v5" /></>,
  pip: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><rect x="12" y="11" width="7" height="6" rx="1.2" /></>,
  wake: <><path d="M12 3v2M5.6 5.6 7 7M3 12h2M19 12h2M17 7l1.4-1.4" /><path d="M8 16a5 5 0 1 1 8 0l-1.2 1.3V20H9.2v-2.7L8 16ZM9.5 22h5" /></>,
  motion: <><path d="M3 8.5c2.1-2.4 4.2-2.4 6.3 0s4.2 2.4 6.3 0 4.2-2.4 6.4 0" /><path d="M3 15.5c2.1-2.4 4.2-2.4 6.3 0s4.2 2.4 6.3 0 4.2-2.4 6.4 0" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8.5A7 7 0 0 1 18.8 7L20 12M4 12l1.2 5A7 7 0 0 0 17.9 15.5" /></>,
  warning: <><path d="M10.2 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.8 4.2a2 2 0 0 0-3.6 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  guide: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23V5.5Z" /><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23V5.5Z" /></>
};

export const Icon = memo(function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className={`room-icon icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
});

export const MotionIcon = memo(function MotionIcon({
  active,
  activeIcon,
  inactiveIcon
}: {
  active: boolean;
  activeIcon: IconName;
  inactiveIcon: IconName;
}) {
  return (
    <span className="t-icon-swap" data-state={active ? 'a' : 'b'} aria-hidden="true">
      <span className="t-icon" data-icon="a"><Icon name={activeIcon} /></span>
      <span className="t-icon" data-icon="b"><Icon name={inactiveIcon} /></span>
    </span>
  );
});

export const BrandMark = memo(function BrandMark() {
  const maskId = `screenlink-owl-${useId().replace(/:/g, '')}`;
  return (
    <svg className="screenlink-brand-mark" viewBox="6 8 36 36" fill="none" aria-hidden="true">
      <defs>
        <mask id={maskId}>
          <rect width="48" height="48" fill="white" />
          <circle cx="18.5" cy="22.8" r="7" fill="black" />
          <circle cx="29.5" cy="22.8" r="7" fill="black" />
          <path d="m21 31 3 4.2 3-4.2Z" fill="black" />
        </mask>
      </defs>
      <path d="M10.8 14.6c4-4 8.8-4.3 13.2-.9 4.4-3.4 9.2-3.1 13.2.9 4.2 4.2 4.7 13.3 1.4 19.5C35.8 39.4 30.9 42 24 42s-11.8-2.6-14.6-7.9c-3.3-6.2-2.8-15.3 1.4-19.5Z" fill="currentColor" mask={`url(#${maskId})`} />
      <circle cx="18.5" cy="22.8" r="2.15" fill="currentColor" />
      <circle cx="29.5" cy="22.8" r="2.15" fill="currentColor" />
    </svg>
  );
});

export const WindowsMark = memo(function WindowsMark() {
  return (
    <svg className="windows-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 4.6 10.6 3.5v7.75H2.5V4.6Zm9.1-1.24L21.5 2v9.25h-9.9V3.36ZM2.5 12.25h8.1V20l-8.1-1.12v-6.63Zm9.1 0h9.9V22l-9.9-1.36v-8.39Z" />
    </svg>
  );
});
