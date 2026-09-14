import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type TouchEvent as ReactTouchEvent } from 'react';
import QRCode from 'qrcode';
import { playInterfaceSound as playCallSound, setInterfaceSoundOutputDevice, unlockInterfaceSounds, type InterfaceSoundName } from './callSounds';
import GradientWaves from './GradientWaves';
import { createPrivateRoom, parseInvite, signalUrl, type IceServerConfig, type Invite, type RoomParticipant, type RoomProfile, type SessionDescription } from './protocol';
import { loadStoredProfile, prepareAvatar, profileStorageKind, saveStoredProfile } from './profileStore';

type RoomMode = 'landing' | 'connecting' | 'connected' | 'error';
type IconName = 'screen' | 'microphone' | 'microphoneOff' | 'volume' | 'volumeOff' | 'chat' | 'send' | 'hangup' | 'link' | 'copy' | 'settings' | 'users' | 'crown' | 'close' | 'chevron' | 'chevronDown' | 'smile' | 'qr' | 'more' | 'expand' | 'pip' | 'wake' | 'motion';
type Session = { invite: Invite; joinCode?: string; joinByCode?: boolean; ownerKey?: string; participantId?: string; maxParticipants?: number };
type RoomEntry = { kind: 'invite'; invite: Invite } | { kind: 'code'; code: string };
type ChatDelivery = 'pending' | 'sent' | 'delivered' | 'failed';
type ChatMessage = { id: string; senderId: string; senderName: string; text: string; sentAt: number; system?: boolean; delivery?: ChatDelivery };
type ChatWireMessage = Pick<ChatMessage, 'id' | 'senderId' | 'senderName' | 'text' | 'sentAt'>;
type ChatChannelPayload =
  | { type: 'chat-message'; message: ChatWireMessage }
  | { type: 'chat-ack'; messageId: string }
  | { type: 'chat-history'; messages: ChatWireMessage[] };
type ChatAppearance = { ownBubble: string; otherBubble: string; nameColor: string };
type PendingChatMessage = { message: ChatMessage; awaiting: Set<string>; attempts: number; firstAttemptAt: number; lastAttemptAt: number; fallbackAccepted: boolean };
type Resolution = 360 | 480 | 720 | 1080;
type FrameRate = 15 | 30 | 45 | 60;
type AudioSettings = { inputDeviceId: string; outputDeviceId: string; inputVolume: number; outputVolume: number; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
type VoiceSettingKey = 'echoCancellation' | 'noiseSuppression' | 'autoGainControl';
type VoiceSettingSupport = Record<VoiceSettingKey, boolean>;
type RuntimeConfig = { viewerOrigin?: string; mode?: string; turnEnabled?: boolean };
type ScreenWakeLock = { released: boolean; release: () => Promise<void>; addEventListener: (type: 'release', listener: () => void, options?: AddEventListenerOptions) => void };
type SheetDragSession = {
  element: HTMLElement;
  scroller: HTMLElement | null;
  touchId: number;
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  offset: number;
  velocity: number;
  dragging: boolean;
  horizontal: boolean;
  frame: number | null;
};

type PeerRecord = {
  id: string;
  pc: RTCPeerConnection;
  queuedCandidates: RTCIceCandidateInit[];
  callAudioSender: RTCRtpSender | null;
  screenVideoSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
  callAudioReceiver: RTCRtpReceiver | null;
  screenVideoReceiver: RTCRtpReceiver | null;
  screenAudioReceiver: RTCRtpReceiver | null;
  chatChannel: RTCDataChannel | null;
  callAudio: HTMLAudioElement | null;
  screenAudio: HTMLAudioElement | null;
  screenStream: MediaStream;
  recoveryTimer: number | null;
  recoveryAttempts: number;
  makingOffer: boolean;
  ignoreOffer: boolean;
  polite: boolean;
};

type RoomMessage =
  | { type: 'room-ready'; roomId: string; joinCode: string; invite: Invite; peerId?: string; selfId: string; leaderId: string; maxParticipants?: number; iceServers: IceServerConfig[]; participants: RoomParticipant[]; resumed?: boolean }
  | { type: 'participant-joined'; participant: RoomParticipant }
  | { type: 'participant-left'; peerId: string }
  | { type: 'participant-state'; participant: RoomParticipant }
  | { type: 'leader-changed'; leaderId: string; reclaimed?: boolean }
  | { type: 'peer-signal'; fromId: string; kind: 'offer'; sdp: SessionDescription }
  | { type: 'peer-signal'; fromId: string; kind: 'answer'; sdp: SessionDescription }
  | { type: 'peer-signal'; fromId: string; kind: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'chat-fallback'; message: ChatMessage }
  | { type: 'chat-ack'; fromId: string; messageId: string }
  | { type: 'room-closed' }
  | { type: 'pong'; at: number }
  | { type: 'error'; code: string; message: string };

const OWNER_ROOM_KEY = 'screenlink-owner-room-v2';
const PROFILE_KEY = 'screenlink-room-profile-v2';
const INTERFACE_SOUNDS_KEY = 'screenlink-interface-sounds-v1';
const INTERFACE_MOTION_KEY = 'screenlink-interface-motion-v1';
const CHAT_APPEARANCE_KEY = 'screenlink-chat-appearance-v2';
const CHAT_OWN_IDS_PREFIX = 'screenlink-chat-own:';
const PEER_KEY_PREFIX = 'screenlink-room-peer:';
const COMPACT_LAYOUT_QUERY = '(max-width: 1240px)';
const PHONE_LAYOUT_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 980px)';
const MOBILE_DEVICE_QUERY = '(pointer: coarse) and (max-width: 980px)';
const CHAT_LIMIT = 160;
const CHAT_CHANNEL_PAYLOAD_LIMIT = 64_000;
const CHAT_HISTORY_PAYLOAD_LIMIT = 48_000;
const CHAT_BUFFER_LIMIT = 512_000;
const CHAT_RETRY_INTERVAL_MS = 1_750;
const CHAT_FAILURE_TIMEOUT_MS = 12_000;
const DEFAULT_CHAT_APPEARANCE: ChatAppearance = { ownBubble: '#383838', otherBubble: '#1c1c1c', nameColor: '#ffffff' };
const RESOLUTIONS: Resolution[] = [360, 480, 720, 1080];
const FRAME_RATES: FrameRate[] = [15, 30, 45, 60];
const PARTICIPANT_LIMITS = [2, 3, 4, 5, 6, 7, 8];
const MIN_BITRATE_MBPS = 0.5;
const MAX_BITRATE_MBPS = 20;
const VOICE_SETTING_KEYS: VoiceSettingKey[] = ['noiseSuppression', 'echoCancellation', 'autoGainControl'];
const VOICE_SETTING_DETAILS: Record<VoiceSettingKey, { label: string; description: string }> = {
  noiseSuppression: { label: 'Isolamento de voz', description: 'Reduz ruídos ao redor' },
  echoCancellation: { label: 'Controle de eco', description: 'Evita retorno nos alto-falantes' },
  autoGainControl: { label: 'Ganho automático', description: 'Equilibra o volume da sua voz' }
};
const CHAT_EMOJIS = ['😀', '😂', '🥹', '😍', '😎', '🤔', '😅', '😭', '😡', '👍', '👎', '👏', '🙌', '🙏', '🤝', '💙', '🔥', '✨', '🎉', '🎮', '👀', '✅', '❌', '🚀'];
const PREMIUM_PARTICLES = [
  ['11%', '26%', '.8px', '15.2s', '-2.6s', '.55px'],
  ['23%', '67%', '1.1px', '17.8s', '-11.4s', '.8px'],
  ['34%', '39%', '.65px', '13.9s', '-7.1s', '.45px'],
  ['47%', '74%', '.9px', '19.3s', '-3.8s', '.7px'],
  ['58%', '20%', '1px', '16.6s', '-13.2s', '.6px'],
  ['69%', '53%', '.7px', '14.7s', '-5.4s', '.5px'],
  ['79%', '31%', '1.15px', '20.1s', '-16.8s', '.85px'],
  ['89%', '70%', '.72px', '18.4s', '-9.7s', '.55px'],
  ['96%', '44%', '.55px', '15.8s', '-1.9s', '.4px']
] as const;
const VIDEO_PRESETS: Record<Resolution, { width: number; height: number; bitrate: number }> = {
  360: { width: 640, height: 360, bitrate: 900_000 },
  480: { width: 854, height: 480, bitrate: 1_600_000 },
  720: { width: 1280, height: 720, bitrate: 3_600_000 },
  1080: { width: 1920, height: 1080, bitrate: 7_000_000 }
};

type WebStorageName = 'localStorage' | 'sessionStorage';

function readStorage(storageName: WebStorageName, key: string) {
  try {
    return window[storageName].getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(storageName: WebStorageName, key: string, value: string) {
  try {
    window[storageName].setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(storageName: WebStorageName, key: string) {
  try {
    window[storageName].removeItem(key);
  } catch {
    // A chamada continua mesmo quando o navegador bloqueia armazenamento local.
  }
}

function normalizeChatColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function loadChatAppearance(): ChatAppearance {
  try {
    const stored = JSON.parse(readStorage('localStorage', CHAT_APPEARANCE_KEY) || '{}') as Partial<ChatAppearance>;
    return {
      ownBubble: normalizeChatColor(stored.ownBubble, DEFAULT_CHAT_APPEARANCE.ownBubble),
      otherBubble: normalizeChatColor(stored.otherBubble, DEFAULT_CHAT_APPEARANCE.otherBubble),
      nameColor: normalizeChatColor(stored.nameColor, DEFAULT_CHAT_APPEARANCE.nameColor)
    };
  } catch {
    return DEFAULT_CHAT_APPEARANCE;
  }
}

function loadMotionPreference() {
  const stored = readStorage('localStorage', INTERFACE_MOTION_KEY);
  if (stored === 'true' || stored === 'false') return stored === 'true';
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const AVATARS = [
  { id: 'orbit', label: 'Órbita', colors: ['#8ee6ed', '#387f99'], face: 'robot' },
  { id: 'nova', label: 'Nova', colors: ['#ffcf91', '#9c5e7e'], face: 'fox' },
  { id: 'pixel', label: 'Pixel', colors: ['#a9d18e', '#397266'], face: 'frog' },
  { id: 'lumen', label: 'Lumen', colors: ['#dbb5ff', '#6656ac'], face: 'cat' },
  { id: 'byte', label: 'Byte', colors: ['#ffd0d0', '#a55367'], face: 'bear' },
  { id: 'echo', label: 'Echo', colors: ['#bfd0ff', '#91a9ef'], face: 'owl' }
] as const;

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    screen: <><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/></>,
    microphone: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/></>,
    microphoneOff: <><path d="m4 4 16 16M9 5.5V11a3 3 0 0 0 4.7 2.45M15 9V6a3 3 0 0 0-5.2-2.05M5.5 11.5a6.5 6.5 0 0 0 10.9 4.8M18.5 11.5a6.5 6.5 0 0 1-.7 2.9M12 18v3M8.5 21h7"/></>,
    volume: <><path d="M5 10v4h4l5 4V6l-5 4H5Z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11"/></>,
    volumeOff: <><path d="M5 10v4h4l5 4V6l-5 4H5ZM17 9l5 6M22 9l-5 6"/></>,
    chat: <path d="M4 5.5h16v11H9l-5 3v-14Z"/>,
    send: <><path d="M12 20V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/></>,
    hangup: <path d="M4.2 15.1c4.9-4.4 10.7-4.4 15.6 0 .7.6.7 1.7.1 2.3l-1.3 1.3c-.5.5-1.3.6-1.9.2l-2.2-1.5c-.4-.3-.7-.8-.6-1.3l.1-1.1a10.8 10.8 0 0 0-4 0l.1 1.1c.1.5-.2 1-.6 1.3l-2.2 1.5c-.6.4-1.4.3-1.9-.2l-1.3-1.3c-.6-.6-.6-1.7.1-2.3Z"/>,
    link: <><path d="M9.5 14.5 14.5 9"/><path d="M7.5 17H6a4 4 0 0 1 0-8h4M16.5 7H18a4 4 0 0 1 0 8h-4"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    settings: <><path d="M4 6h5M13 6h7M4 12h10M18 12h2M4 18h3M11 18h9"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></>,
    users: <><circle cx="9" cy="9" r="3"/><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M16 6.5a3 3 0 0 1 0 5.8M16.5 14c2.5.5 3.7 2.4 4 5"/></>,
    crown: <path d="m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7Z"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    chevronDown: <path d="m6 9 6 6 6-6"/>,
    smile: <><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c2 2 5 2 7 0M9 9.5h.01M15 9.5h.01"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 14h3M21 14v3M14 19h3v2M19 18h2v3"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></>,
    pip: <><rect x="3" y="4" width="18" height="16" rx="2.5"/><rect x="12" y="11" width="7" height="6" rx="1.2"/></>,
    wake: <><path d="M12 3v2M5.6 5.6 7 7M3 12h2M19 12h2M17 7l1.4-1.4"/><path d="M8 16a5 5 0 1 1 8 0l-1.2 1.3V20H9.2v-2.7L8 16ZM9.5 22h5"/></>,
    motion: <><path d="M3 8.5c2.1-2.4 4.2-2.4 6.3 0s4.2 2.4 6.3 0 4.2-2.4 6.4 0"/><path d="M3 15.5c2.1-2.4 4.2-2.4 6.3 0s4.2 2.4 6.3 0 4.2-2.4 6.4 0"/></>
  };
  return <svg className={`room-icon icon icon-${name}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function BrandMark() {
  return (
    <svg className="screenlink-brand-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <mask id="screenlink-owl-cutouts">
          <rect width="48" height="48" fill="white"/>
          <circle cx="18.5" cy="22.8" r="7" fill="black"/>
          <circle cx="29.5" cy="22.8" r="7" fill="black"/>
          <path d="m21 31 3 4.2 3-4.2Z" fill="black"/>
        </mask>
      </defs>
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="2.8"/>
      <path d="M10.8 14.6c4-4 8.8-4.3 13.2-.9 4.4-3.4 9.2-3.1 13.2.9 4.2 4.2 4.7 13.3 1.4 19.5C35.8 39.4 30.9 42 24 42s-11.8-2.6-14.6-7.9c-3.3-6.2-2.8-15.3 1.4-19.5Z" fill="currentColor" mask="url(#screenlink-owl-cutouts)"/>
      <circle cx="18.5" cy="22.8" r="2.15" fill="currentColor"/>
      <circle cx="29.5" cy="22.8" r="2.15" fill="currentColor"/>
    </svg>
  );
}

function SegmentedSelector<T extends number>({ label, suffix, options, value, disabled = false, premium, fullWidth = false, onChange }: { label: string; suffix: string; options: T[]; value: T; disabled?: boolean; premium?: T; fullWidth?: boolean; onChange: (value: T) => void }) {
  const activeIndex = Math.max(0, options.indexOf(value));
  return <fieldset className={`profile-fieldset ${fullWidth ? 'is-full-width' : ''}`}><legend><span>{label}</span><small>{suffix}</small></legend><div className={`segmented-control ${premium === value ? 'is-premium-selected' : ''}`} style={{ '--active-index': activeIndex, '--option-count': options.length } as React.CSSProperties}>{premium === value && <span className="premium-particles" aria-hidden="true">{PREMIUM_PARTICLES.map(([x, y, size, duration, delay, jitter], index) => <i key={index} style={{ '--particle-x': x, '--particle-y': y, '--particle-size': size, '--particle-duration': duration, '--particle-delay': delay, '--particle-jitter': jitter } as React.CSSProperties}/>)}</span>}{options.map(option => <button key={option} className={`${option === value ? 'is-active' : ''} ${option === premium ? 'is-premium' : ''}`} type="button" disabled={disabled} onClick={() => onChange(option)}>{option}{label === 'Resolução' ? 'p' : ''}</button>)}</div></fieldset>;
}

function Avatar({ avatar, name, speaking = false, leader = false, size = 'normal' }: { avatar: string; name: string; speaking?: boolean; leader?: boolean; size?: 'small' | 'normal' | 'large' }) {
  const gradientId = `avatar-bg-${useId().replace(/:/g, '')}`;
  if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(avatar)) {
    return <span className={`preset-avatar avatar-${size} custom-avatar ${speaking ? 'is-speaking' : ''}`} title={name}><img src={avatar} alt="" draggable={false}/>{leader && <span className="avatar-crown" aria-label="Líder da sala"><Icon name="crown"/></span>}</span>;
  }
  const preset = AVATARS.find(item => item.id === avatar) ?? AVATARS[0];
  return (
    <span className={`preset-avatar avatar-${size} ${speaking ? 'is-speaking' : ''}`} style={{ '--avatar-a': preset.colors[0], '--avatar-b': preset.colors[1] } as React.CSSProperties} title={name}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="31" fill={`url(#${gradientId})`} opacity=".98"/>
        <defs><linearGradient id={gradientId} x1="10" y1="8" x2="54" y2="58"><stop stopColor="var(--avatar-a)"/><stop offset="1" stopColor="var(--avatar-b)"/></linearGradient></defs>
        {preset.face === 'robot' && <><rect x="14" y="16" width="36" height="34" rx="13" fill="rgba(5,25,32,.78)"/><circle cx="25" cy="32" r="4" fill="var(--avatar-a)"/><circle cx="39" cy="32" r="4" fill="var(--avatar-a)"/><path d="M25 41c4 3 10 3 14 0" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"/></>}
        {preset.face === 'fox' && <><path d="M13 17 25 22h14l12-5-5 31H18l-5-31Z" fill="rgba(85,36,35,.76)"/><path d="m22 32 10 14 10-14" fill="#fff0d5"/><circle cx="24" cy="30" r="3"/><circle cx="40" cy="30" r="3"/></>}
        {preset.face === 'frog' && <><circle cx="21" cy="23" r="9" fill="#d9f3b8"/><circle cx="43" cy="23" r="9" fill="#d9f3b8"/><ellipse cx="32" cy="36" rx="21" ry="17" fill="#7db779"/><circle cx="21" cy="23" r="3"/><circle cx="43" cy="23" r="3"/><path d="M24 41c5 3 11 3 16 0" fill="none" stroke="#173c35" strokeWidth="2.5" strokeLinecap="round"/></>}
        {preset.face === 'cat' && <><path d="m14 23 5-13 10 9h6l10-9 5 13-4 29H18l-4-29Z" fill="rgba(45,32,81,.76)"/><path d="M23 31h5M36 31h5M28 42c3 2 5 2 8 0" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"/></>}
        {preset.face === 'bear' && <><circle cx="18" cy="20" r="8" fill="#784b52"/><circle cx="46" cy="20" r="8" fill="#784b52"/><circle cx="32" cy="34" r="20" fill="#a96f70"/><circle cx="25" cy="31" r="3"/><circle cx="39" cy="31" r="3"/><ellipse cx="32" cy="40" rx="7" ry="5" fill="#eed0bc"/></>}
        {preset.face === 'owl' && <g className="echo-owl"><path d="M15.2 17.1c4.9-4.9 11.1-5.1 16.8-1 5.7-4.1 11.9-3.9 16.8 1 4.8 4.8 5.3 15.3 1.6 22.5C47.2 46 41.4 50 32 50s-15.2-4-18.4-10.4c-3.7-7.2-3.2-17.7 1.6-22.5Z" fill="#4d5f8f"/><g className="echo-owl-eye echo-owl-eye-left"><circle cx="24.2" cy="29.3" r="10.1" fill="#f5f7ff"/><circle cx="24.2" cy="29.3" r="3.15" fill="#05070b"/></g><g className="echo-owl-eye echo-owl-eye-right"><circle cx="39.8" cy="29.3" r="10.1" fill="#f5f7ff"/><circle cx="39.8" cy="29.3" r="3.15" fill="#05070b"/></g><path className="echo-owl-beak" d="m28.4 39.2 7.2-.05-3.55 5.25Z" fill="#f3c86f"/></g>}
      </svg>
      {leader && <span className="avatar-crown" aria-label="Líder da sala"><Icon name="crown"/></span>}
    </span>
  );
}

function normalizeAvatar(value: unknown) {
  const avatar = String(value || '');
  if (AVATARS.some(item => item.id === avatar)) return avatar;
  if (/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(avatar) && avatar.length <= 32_000) return avatar;
  return 'orbit';
}

function RoomDevicePicker({ label, input = false, devices, value, onChange }: { label: string; input?: boolean; devices: MediaDeviceInfo[]; value: string; onChange: (deviceId: string) => void }) {
  const kind = input ? 'audioinput' : 'audiooutput';
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const available = devices.filter(device => device.kind === kind);
  const selected = available.find(device => device.deviceId === value);
  const openPicker = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 240);
  };
  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);
  useEffect(() => () => { if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current); }, []);
  return <div ref={pickerRef} className={`room-device-picker ${open ? 'is-open' : ''}`} onPointerEnter={openPicker} onPointerLeave={scheduleClose}>
    <button type="button" className="room-device-trigger" onClick={openPicker} aria-expanded={open}>
      <Icon name={kind === 'audioinput' ? 'microphone' : 'volume'}/><span><strong>{label}</strong><small>{selected?.label || 'Padrão do sistema'}</small></span><Icon name="chevron"/>
    </button>
    {open && <div className="room-device-options" aria-label={label} onPointerEnter={openPicker} onPointerLeave={scheduleClose}>
      <header className="room-device-options-header"><button type="button" onClick={() => setOpen(false)} aria-label="Voltar para configurações de áudio"><Icon name="chevron"/></button><strong>{label}</strong></header>
      <div className="room-device-options-list" role="listbox" aria-label={label}>{[{ deviceId: '', label: 'Padrão do sistema' }, ...available].map((device, index) => <button key={`${device.deviceId || 'default'}-${index}`} type="button" role="option" aria-selected={device.deviceId === value} onClick={() => { onChange(device.deviceId); setOpen(false); }}><Icon name={kind === 'audioinput' ? 'microphone' : 'volume'}/><span>{device.label || `${label} ${index + 1}`}</span>{device.deviceId === value && <b>✓</b>}</button>)}</div>
    </div>}
  </div>;
}

function normalizeName(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28) || 'Você';
}

function normalizeChatText(value: unknown) {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1_000)
    : '';
}

function normalizeChatId(value: unknown) {
  const id = typeof value === 'string' ? value.slice(0, 200) : '';
  return /^[a-z0-9._:-]{1,200}$/i.test(id) ? id : '';
}

function loadOwnChatMessageIds(roomId: string) {
  try {
    const stored = JSON.parse(readStorage('sessionStorage', `${CHAT_OWN_IDS_PREFIX}${roomId}`) || '[]') as unknown;
    if (!Array.isArray(stored)) return new Set<string>();
    return new Set(stored.slice(-CHAT_LIMIT).map(normalizeChatId).filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

function saveOwnChatMessageIds(roomId: string, ids: Set<string>) {
  writeStorage('sessionStorage', `${CHAT_OWN_IDS_PREFIX}${roomId}`, JSON.stringify([...ids].slice(-CHAT_LIMIT)));
}

function normalizeChatTimestamp(value: unknown) {
  const timestamp = Number(value);
  const now = Date.now();
  return Number.isFinite(timestamp) && timestamp > 0 && Math.abs(timestamp - now) <= 86_400_000 ? timestamp : now;
}

function normalizeChatWireMessage(value: unknown, sender?: { id: string; name: string }): ChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const incoming = value as Partial<ChatWireMessage>;
  const id = normalizeChatId(incoming.id);
  const text = normalizeChatText(incoming.text);
  const senderId = sender?.id || normalizeChatId(incoming.senderId);
  const senderName = sender?.name || normalizeName(String(incoming.senderName || 'Participante'));
  if (!id || !text || !senderId) return null;
  return { id, senderId, senderName, text, sentAt: normalizeChatTimestamp(incoming.sentAt) };
}

function chatWireMessage(message: ChatMessage): ChatWireMessage {
  return { id: message.id, senderId: message.senderId, senderName: message.senderName, text: message.text, sentAt: message.sentAt };
}

function chatPayloadSize(serialized: string) {
  return new TextEncoder().encode(serialized).byteLength;
}

function sendChatChannelPayload(channel: RTCDataChannel | null, payload: ChatChannelPayload | ChatWireMessage) {
  if (channel?.readyState !== 'open' || channel.bufferedAmount > CHAT_BUFFER_LIMIT) return false;
  try {
    const serialized = JSON.stringify(payload);
    if (chatPayloadSize(serialized) > CHAT_CHANNEL_PAYLOAD_LIMIT) return false;
    channel.send(serialized);
    return true;
  } catch {
    return false;
  }
}

function sendChatHistory(channel: RTCDataChannel, messages: ChatMessage[]) {
  let history = messages
    .filter(message => !message.system && message.delivery !== 'pending' && message.delivery !== 'failed')
    .slice(-CHAT_LIMIT)
    .map(chatWireMessage);
  let serialized = JSON.stringify({ type: 'chat-history', messages: history } satisfies ChatChannelPayload);
  while (history.length > 1 && chatPayloadSize(serialized) > CHAT_HISTORY_PAYLOAD_LIMIT) {
    history = history.slice(1);
    serialized = JSON.stringify({ type: 'chat-history', messages: history } satisfies ChatChannelPayload);
  }
  if (!history.length || chatPayloadSize(serialized) > CHAT_HISTORY_PAYLOAD_LIMIT || channel.readyState !== 'open' || channel.bufferedAmount > CHAT_BUFFER_LIMIT) return false;
  try {
    channel.send(serialized);
    return true;
  } catch {
    return false;
  }
}

function renderChatText(text: string) {
  return text.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
    : part
  );
}

function resizeChatInput(input: HTMLTextAreaElement | null) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
}

function closestVerticalScroller(target: EventTarget | null, sheet: HTMLElement) {
  let element = target instanceof HTMLElement ? target : target instanceof Element ? target.parentElement : null;
  while (element) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 1) return element;
    if (element === sheet) break;
    element = element.parentElement;
  }
  return null;
}

function touchById(touches: TouchList, touchId: number) {
  for (let index = 0; index < touches.length; index += 1) {
    if (touches[index].identifier === touchId) return touches[index];
  }
  return null;
}

function useBottomSheetGesture(enabled: boolean, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);
  const dragRef = useRef<SheetDragSession | null>(null);
  const removeNativeListenersRef = useRef<(() => void) | null>(null);
  dismissRef.current = onDismiss;

  const removeNativeListeners = useCallback(() => {
    removeNativeListenersRef.current?.();
    removeNativeListenersRef.current = null;
  }, []);

  const releaseSession = useCallback((settle = true) => {
    removeNativeListeners();
    const session = dragRef.current;
    dragRef.current = null;
    if (!session) return;
    if (session.frame !== null) window.cancelAnimationFrame(session.frame);
    const { element } = session;
    element.classList.remove('is-sheet-dragging');
    if (!settle || !session.dragging) {
      element.classList.remove('is-sheet-settling', 'is-sheet-dismissing');
      element.style.removeProperty('--sheet-drag-y');
      return;
    }
    element.classList.add('is-sheet-settling');
    element.style.setProperty('--sheet-drag-y', '0px');
    window.setTimeout(() => {
      element.classList.remove('is-sheet-settling');
      element.style.removeProperty('--sheet-drag-y');
    }, 240);
  }, [removeNativeListeners]);

  useEffect(() => {
    if (!enabled) releaseSession(false);
    return () => releaseSession(false);
  }, [enabled, releaseSession]);

  const onNativeTouchMove = useCallback((event: TouchEvent) => {
    const session = dragRef.current;
    if (!session) return;
    const touch = touchById(event.touches, session.touchId);
    if (!touch) return;
    const deltaX = touch.clientX - session.startX;
    let deltaY = touch.clientY - session.startY;
    if (!session.dragging && Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 8) {
      session.horizontal = true;
      return;
    }
    if (session.horizontal) return;

    if (!session.dragging && session.scroller && session.scroller.scrollTop > .5) {
      session.startY = touch.clientY;
      session.lastY = touch.clientY;
      session.lastTime = event.timeStamp;
      return;
    }
    deltaY = touch.clientY - session.startY;
    if (!session.dragging && deltaY <= 5) return;
    if (!session.dragging) {
      session.dragging = true;
      session.element.classList.add('is-sheet-dragging');
    }

    if (event.cancelable) event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - session.lastTime);
    const instantVelocity = (touch.clientY - session.lastY) / elapsed;
    session.velocity = session.velocity * .68 + instantVelocity * .32;
    session.lastY = touch.clientY;
    session.lastTime = event.timeStamp;
    const height = Math.max(1, session.element.clientHeight);
    const positiveOffset = Math.max(0, deltaY);
    session.offset = positiveOffset > height * .72
      ? height * .72 + (positiveOffset - height * .72) * .18
      : positiveOffset;
    if (session.frame !== null) return;
    session.frame = window.requestAnimationFrame(() => {
      session.frame = null;
      session.element.style.setProperty('--sheet-drag-y', `${session.offset}px`);
    });
  }, []);

  const finishGesture = useCallback((event: TouchEvent, cancelled = false) => {
    const session = dragRef.current;
    if (!session) return;
    if (session.frame !== null) {
      window.cancelAnimationFrame(session.frame);
      session.frame = null;
      session.element.style.setProperty('--sheet-drag-y', `${session.offset}px`);
    }
    const dismiss = !cancelled && session.dragging && (
      session.offset >= Math.min(112, session.element.clientHeight * .2) || session.velocity > .58
    );
    if (!dismiss) {
      releaseSession(true);
      return;
    }
    if (event.cancelable) event.preventDefault();
    dragRef.current = null;
    removeNativeListeners();
    session.element.classList.remove('is-sheet-dragging');
    session.element.classList.add('is-sheet-dismissing');
    session.element.style.setProperty('--sheet-drag-y', `${Math.max(window.innerHeight, session.element.clientHeight + 48)}px`);
    window.setTimeout(() => dismissRef.current(), 190);
  }, [releaseSession, removeNativeListeners]);

  const onNativeTouchEnd = useCallback((event: TouchEvent) => finishGesture(event), [finishGesture]);
  const onNativeTouchCancel = useCallback((event: TouchEvent) => finishGesture(event, true), [finishGesture]);

  const onTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (!enabled || event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    removeNativeListeners();
    const touch = event.touches[0];
    const element = event.currentTarget;
    element.classList.remove('is-sheet-settling', 'is-sheet-dismissing');
    element.style.removeProperty('--sheet-drag-y');
    dragRef.current = {
      element,
      scroller: closestVerticalScroller(event.target, element),
      touchId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      lastTime: event.timeStamp,
      offset: 0,
      velocity: 0,
      dragging: false,
      horizontal: false,
      frame: null
    };
    window.addEventListener('touchmove', onNativeTouchMove, { passive: false });
    window.addEventListener('touchend', onNativeTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onNativeTouchCancel, { passive: false });
    removeNativeListenersRef.current = () => {
      window.removeEventListener('touchmove', onNativeTouchMove);
      window.removeEventListener('touchend', onNativeTouchEnd);
      window.removeEventListener('touchcancel', onNativeTouchCancel);
    };
  }, [enabled, onNativeTouchCancel, onNativeTouchEnd, onNativeTouchMove, removeNativeListeners]);

  return {
    'data-mobile-sheet': enabled ? 'true' : undefined,
    onTouchStart
  };
}

function normalizeStatus(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Disponível';
}

function isMobileDevice() {
  return window.matchMedia(MOBILE_DEVICE_QUERY).matches;
}

function usesCompactLayout() {
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

function usesPhoneLayout() {
  return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

function detectVoiceSettingSupport(): VoiceSettingSupport {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.();
  return {
    noiseSuppression: supported?.noiseSuppression === true,
    echoCancellation: supported?.echoCancellation === true,
    autoGainControl: supported?.autoGainControl === true
  };
}

function voiceProcessingConstraints(settings: AudioSettings, support: VoiceSettingSupport, exactSetting?: VoiceSettingKey): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {};
  for (const key of VOICE_SETTING_KEYS) {
    if (support[key]) constraints[key] = exactSetting === key ? { exact: settings[key] } : settings[key];
  }
  return constraints;
}

function microphoneConstraints(settings: AudioSettings, support: VoiceSettingSupport, exactSetting?: VoiceSettingKey): MediaTrackConstraints {
  const processing = voiceProcessingConstraints(settings, support, exactSetting);
  return {
    ...(settings.inputDeviceId ? { deviceId: { exact: settings.inputDeviceId } } : {}),
    ...processing
  };
}

function readVoiceTrackSettings(track: MediaStreamTrack): Partial<Record<VoiceSettingKey, boolean>> {
  const settings = track.getSettings() as MediaTrackSettings & Partial<Record<VoiceSettingKey, boolean>>;
  const result: Partial<Record<VoiceSettingKey, boolean>> = {};
  for (const key of VOICE_SETTING_KEYS) {
    if (typeof settings[key] === 'boolean') result[key] = settings[key];
  }
  return result;
}

function detectVoiceTrackSupport(track: MediaStreamTrack, fallback: VoiceSettingSupport): VoiceSettingSupport {
  const result = { ...fallback };
  let capabilities: (MediaTrackCapabilities & Partial<Record<VoiceSettingKey, boolean[]>>) | undefined;
  try {
    capabilities = track.getCapabilities?.() as MediaTrackCapabilities & Partial<Record<VoiceSettingKey, boolean[]>>;
  } catch {
    return result;
  }
  for (const key of VOICE_SETTING_KEYS) {
    const values = capabilities?.[key];
    if (Array.isArray(values)) result[key] = values.includes(true) && values.includes(false);
  }
  return result;
}

function recommendedBitrateMbps(resolution: Resolution, fps: FrameRate) {
  return Math.min(MAX_BITRATE_MBPS, Math.max(MIN_BITRATE_MBPS, VIDEO_PRESETS[resolution].bitrate * (fps / 30) / 1_000_000));
}

function formatBitrate(value: number) {
  return `${value < 10 && value % 1 ? value.toFixed(1) : Math.round(value)} Mb/s`;
}

async function configureScreenSender(sender: RTCRtpSender | null, resolution: Resolution, fps: FrameRate, adaptive: boolean, manualMbps: number) {
  if (!sender?.track) return;
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings[0]!.maxBitrate = Math.round((adaptive ? recommendedBitrateMbps(resolution, fps) : manualMbps) * 1_000_000);
  parameters.encodings[0]!.maxFramerate = fps;
  parameters.degradationPreference = adaptive ? 'balanced' : 'maintain-resolution';
  await sender.setParameters(parameters).catch(() => undefined);
}

function loadProfile(): RoomProfile {
  try {
    const stored = JSON.parse(readStorage('localStorage', PROFILE_KEY) || '{}') as Partial<RoomProfile>;
    return {
      name: normalizeName(String(stored.name || 'Você')),
      avatar: normalizeAvatar(stored.avatar),
      status: normalizeStatus(String(stored.status || 'Disponível')),
      device: isMobileDevice() ? 'mobile' : 'desktop'
    };
  } catch {
    return { name: 'Você', avatar: 'orbit', status: 'Disponível', device: isMobileDevice() ? 'mobile' : 'desktop' };
  }
}

function loadOwnerSession(): Session | null {
  try {
    const stored = JSON.parse(readStorage('localStorage', OWNER_ROOM_KEY) || 'null') as Session | null;
    return stored?.invite?.roomId && stored.invite.token && stored.ownerKey ? stored : null;
  } catch {
    return null;
  }
}

function randomSecret(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function groupInviteUrl(invite: Invite, origin = window.location.origin) {
  const url = new URL(origin);
  url.hash = new URLSearchParams({ room: invite.roomId, key: invite.token }).toString();
  return url.toString();
}

function normalizedShareOrigin(value: unknown) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

function hasTurnServer(servers: IceServerConfig[]) {
  return servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)));
}

function parseRoomEntry(value: string): RoomEntry | null {
  const trimmed = value.trim();
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const invite = parseInvite(new URL(trimmed).hash);
      return invite ? { kind: 'invite', invite } : null;
    }
  } catch {
    return null;
  }
  const shortCode = trimmed.toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z2-9]{6,8}$/.test(shortCode)) return { kind: 'code', code: shortCode };
  const [roomId, token, extra] = trimmed.split('.');
  if (extra || !/^[A-Za-z0-9_-]{12,64}$/.test(roomId || '') || !/^[A-Za-z0-9_-]{32,128}$/.test(token || '')) return null;
  return { kind: 'invite', invite: { roomId, token } };
}

function send(socket: WebSocket | null, payload: object) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function mediaStreamWith(...tracks: Array<MediaStreamTrack | null | undefined>) {
  return new MediaStream(tracks.filter((track): track is MediaStreamTrack => Boolean(track)));
}

async function readPeerRttMs(pc: RTCPeerConnection): Promise<number | null> {
  const report = await pc.getStats();
  let selectedPairId = '';
  let candidatePairRtt: number | null = null;
  let remoteInboundRtt: number | null = null;

  report.forEach(stat => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) selectedPairId = String(stat.selectedCandidatePairId);
  });
  report.forEach(stat => {
    const isSelectedPair = stat.type === 'candidate-pair' && (selectedPairId
      ? stat.id === selectedPairId
      : stat.selected || (stat.nominated && stat.state === 'succeeded'));
    if (isSelectedPair) {
      const rtt = Number(stat.currentRoundTripTime);
      if (Number.isFinite(rtt) && rtt >= 0) candidatePairRtt = Math.max(candidatePairRtt ?? 0, rtt * 1_000);
    }
    if (stat.type === 'remote-inbound-rtp') {
      const rtt = Number(stat.roundTripTime);
      if (Number.isFinite(rtt) && rtt >= 0) remoteInboundRtt = Math.max(remoteInboundRtt ?? 0, rtt * 1_000);
    }
  });

  const rtt = candidatePairRtt ?? remoteInboundRtt;
  return rtt === null ? null : Math.round(rtt);
}

function ScreenTile({ stream, name, local }: { stream: MediaStream; name: string; local?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    video.muted = true;
    void video.play().catch(() => undefined);
    return () => { if (video.srcObject === stream) video.srcObject = null; };
  }, [stream]);
  return <article className="screen-tile"><video ref={ref} autoPlay muted playsInline/><span>{local ? 'Sua tela' : `Tela de ${name}`}</span></article>;
}

export default function RoomApp() {
  const initialInvite = useMemo(() => parseInvite(), []);
  const initialOwner = useMemo(() => initialInvite ? null : loadOwnerSession(), [initialInvite]);
  const mobileOverlayMarker = useMemo(() => `screenlink-${randomSecret(8)}`, []);
  const [profile, setProfile] = useState<RoomProfile>(() => loadProfile());
  const profileRef = useRef(profile);
  const profileEditRevisionRef = useRef(0);
  const [profileNameDraft, setProfileNameDraft] = useState(profile.name);
  const [profileStatusDraft, setProfileStatusDraft] = useState(profile.status);
  const profileNameDraftRef = useRef(profile.name);
  const profileStatusDraftRef = useRef(profile.status);
  const [profileStorageReady, setProfileStorageReady] = useState(false);
  const [profileSaveState, setProfileSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [session, setSession] = useState<Session | null>(() => initialInvite ? { invite: initialInvite } : initialOwner);
  const sessionRef = useRef(session);
  const [mode, setMode] = useState<RoomMode>(session ? 'connecting' : 'landing');
  const [error, setError] = useState('');
  const [joinValue, setJoinValue] = useState('');
  const [participants, setParticipants] = useState<Record<string, RoomParticipant>>({});
  const participantsRef = useRef(participants);
  const [selfId, setSelfId] = useState('');
  const selfIdRef = useRef('');
  const [leaderId, setLeaderId] = useState('');
  const [resolution, setResolution] = useState<Resolution>(720);
  const [fps, setFps] = useState<FrameRate>(30);
  const [automaticQuality, setAutomaticQuality] = useState(true);
  const [adaptiveBitrate, setAdaptiveBitrate] = useState(true);
  const [bitrateMbps, setBitrateMbps] = useState(4);
  const [maxParticipants, setMaxParticipants] = useState(8);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const microphoneEnabledRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const sharingRef = useRef(false);
  const [playbackEnabled, setPlaybackEnabled] = useState(true);
  const playbackEnabledRef = useRef(true);
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(() => new Set());
  const [chatOpen, setChatOpen] = useState(() => !usesCompactLayout());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const seenMessageIdsRef = useRef(new Set<string>());
  const ownChatMessageIdsRef = useRef(new Set<string>());
  const pendingChatMessagesRef = useRef(new Map<string, PendingChatMessage>());
  const chatOpenRef = useRef(chatOpen);
  const chatStickToBottomRef = useRef(true);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const [chatValue, setChatValue] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [chatAppearance, setChatAppearance] = useState<ChatAppearance>(loadChatAppearance);
  const [profileOpen, setProfileOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | ''>('');
  const [shareOrigin, setShareOrigin] = useState(window.location.origin);
  const [turnAvailable, setTurnAvailable] = useState(false);
  const [mediaLatency, setMediaLatency] = useState<number | null>(null);
  const [peerVersion, setPeerVersion] = useState(0);
  const [mobile, setMobile] = useState(usesCompactLayout);
  const [phone, setPhone] = useState(usesPhoneLayout);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const [keepAwake, setKeepAwake] = useState(() => readStorage('localStorage', 'screenlink-keep-awake-v1') === 'true');
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [voiceSettingSupport, setVoiceSettingSupport] = useState(detectVoiceSettingSupport);
  const [voiceSettingPending, setVoiceSettingPending] = useState<VoiceSettingKey | null>(null);
  const [voiceSettingFeedback, setVoiceSettingFeedback] = useState('');
  const [verifiedVoiceSettings, setVerifiedVoiceSettings] = useState<Partial<Record<VoiceSettingKey, boolean>>>({});
  const [interfaceSoundsEnabled, setInterfaceSoundsEnabled] = useState(() => readStorage('localStorage', INTERFACE_SOUNDS_KEY) !== 'false');
  const [interfaceSoundFeedback, setInterfaceSoundFeedback] = useState('');
  const [animationsEnabled, setAnimationsEnabled] = useState(loadMotionPreference);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [screenSharePending, setScreenSharePending] = useState(false);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => ({
    inputDeviceId: '',
    outputDeviceId: '',
    inputVolume: 100,
    outputVolume: 100,
    echoCancellation: voiceSettingSupport.echoCancellation,
    noiseSuppression: voiceSettingSupport.noiseSuppression,
    autoGainControl: voiceSettingSupport.autoGainControl
  }));
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>({});
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});

  const socketRef = useRef<WebSocket | null>(null);
  const iceServersRef = useRef<IceServerConfig[]>([]);
  const peersRef = useRef(new Map<string, PeerRecord>());
  const localMicrophoneStreamRef = useRef<MediaStream | null>(null);
  const localMicrophoneTrackRef = useRef<MediaStreamTrack | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneGainRef = useRef<GainNode | null>(null);
  const microphoneSourceStreamRef = useRef<MediaStream | null>(null);
  const audioSettingsRef = useRef(audioSettings);
  const verifiedVoiceSettingsRef = useRef<Partial<Record<VoiceSettingKey, boolean>>>({});
  const resolutionRef = useRef(resolution);
  const fpsRef = useRef(fps);
  const automaticQualityRef = useRef(automaticQuality);
  const adaptiveBitrateRef = useRef(adaptiveBitrate);
  const bitrateMbpsRef = useRef(bitrateMbps);
  const participantVolumesRef = useRef(participantVolumes);
  const screenVolumesRef = useRef(screenVolumes);
  const interfaceSoundsEnabledRef = useRef(interfaceSoundsEnabled);
  const callSoundConnectedRef = useRef(false);
  const endingCallRef = useRef(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const mobileSheetRef = useRef<HTMLDivElement>(null);
  const profileBarRef = useRef<HTMLButtonElement>(null);
  const profilePopoverRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const chatSettingsRef = useRef<HTMLDivElement>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const wakeLockRef = useRef<ScreenWakeLock | null>(null);
  const screenSharePendingRef = useRef(false);
  const microphonePendingRef = useRef(false);
  const mediaRequestEpochRef = useRef(0);
  const microphoneRequestIdRef = useRef(0);
  const screenShareRequestIdRef = useRef(0);
  const disposedRef = useRef(false);
  const mobileOverlayHistoryActiveRef = useRef(false);
  const dismissMobileOverlayRef = useRef<() => void>(() => undefined);
  const staleMobileOverlayCleanedRef = useRef(false);

  useEffect(() => {
    if (staleMobileOverlayCleanedRef.current) return;
    staleMobileOverlayCleanedRef.current = true;
    const historyState = window.history.state;
    if (!historyState || typeof historyState !== 'object' || !('__screenlinkMobileOverlay' in historyState)) return;
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    const cleanedState = { ...historyState };
    delete cleanedState.__screenlinkMobileOverlay;
    window.history.replaceState(cleanedState, '', window.location.href);
  }, []);

  useEffect(() => {
    profileRef.current = profile;
    const localAvatar = AVATARS.some(item => item.id === profile.avatar) ? profile.avatar : 'orbit';
    writeStorage('localStorage', PROFILE_KEY, JSON.stringify({ ...profile, avatar: localAvatar }));
  }, [profile]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);
  useEffect(() => { microphoneEnabledRef.current = microphoneEnabled; }, [microphoneEnabled]);
  useEffect(() => { sharingRef.current = sharing; }, [sharing]);
  useEffect(() => { playbackEnabledRef.current = playbackEnabled; }, [playbackEnabled]);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);
  useEffect(() => {
    writeStorage('localStorage', CHAT_APPEARANCE_KEY, JSON.stringify(chatAppearance));
  }, [chatAppearance]);
  useEffect(() => { audioSettingsRef.current = audioSettings; }, [audioSettings]);
  useEffect(() => { resolutionRef.current = resolution; }, [resolution]);
  useEffect(() => { fpsRef.current = fps; }, [fps]);
  useEffect(() => { automaticQualityRef.current = automaticQuality; }, [automaticQuality]);
  useEffect(() => { adaptiveBitrateRef.current = adaptiveBitrate; }, [adaptiveBitrate]);
  useEffect(() => { bitrateMbpsRef.current = bitrateMbps; }, [bitrateMbps]);
  useEffect(() => { participantVolumesRef.current = participantVolumes; }, [participantVolumes]);
  useEffect(() => { screenVolumesRef.current = screenVolumes; }, [screenVolumes]);
  useEffect(() => {
    interfaceSoundsEnabledRef.current = interfaceSoundsEnabled;
    writeStorage('localStorage', INTERFACE_SOUNDS_KEY, String(interfaceSoundsEnabled));
  }, [interfaceSoundsEnabled]);
  useEffect(() => {
    const unlock = () => {
      if (interfaceSoundsEnabledRef.current) void unlockInterfaceSounds();
    };
    const resumeWhenVisible = () => {
      if (document.visibilityState === 'visible') unlock();
    };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    document.addEventListener('pointerup', unlock, { capture: true, passive: true });
    document.addEventListener('touchend', unlock, { capture: true, passive: true });
    document.addEventListener('click', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', resumeWhenVisible);
    return () => {
      document.removeEventListener('pointerdown', unlock, { capture: true });
      document.removeEventListener('pointerup', unlock, { capture: true });
      document.removeEventListener('touchend', unlock, { capture: true });
      document.removeEventListener('click', unlock, { capture: true });
      document.removeEventListener('keydown', unlock, { capture: true });
      document.removeEventListener('visibilitychange', resumeWhenVisible);
    };
  }, []);
  useEffect(() => {
    writeStorage('localStorage', INTERFACE_MOTION_KEY, String(animationsEnabled));
  }, [animationsEnabled]);
  useEffect(() => { profileNameDraftRef.current = profileNameDraft; }, [profileNameDraft]);
  useEffect(() => { profileStatusDraftRef.current = profileStatusDraft; }, [profileStatusDraft]);
  useLayoutEffect(() => {
    chatOpenRef.current = chatOpen;
    if (!chatOpen) return;
    chatStickToBottomRef.current = true;
    setUnreadMessages(0);
    setNewMessagesBelow(0);
    const log = chatLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chatOpen]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/runtime-config', { cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<RuntimeConfig> : Promise.reject(new Error('runtime config unavailable')))
      .then(config => {
        if (cancelled) return;
        setShareOrigin(normalizedShareOrigin(config.viewerOrigin));
        setTurnAvailable(Boolean(config.turnEnabled));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const syncViewport = () => setMobile(query.matches);
    syncViewport();
    query.addEventListener('change', syncViewport);
    return () => query.removeEventListener('change', syncViewport);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(PHONE_LAYOUT_QUERY);
    const syncViewport = () => setPhone(query.matches);
    syncViewport();
    query.addEventListener('change', syncViewport);
    return () => query.removeEventListener('change', syncViewport);
  }, []);

  useEffect(() => {
    if (!mobile) setControlsOpen(false);
  }, [mobile]);

  useEffect(() => {
    let cancelled = false;
    const revisionAtLoad = profileEditRevisionRef.current;
    void loadStoredProfile().then(stored => {
      if (cancelled || !stored || profileEditRevisionRef.current !== revisionAtLoad) return;
      const restored = {
        ...profileRef.current,
        name: normalizeName(stored.name),
        avatar: normalizeAvatar(stored.avatar),
        status: normalizeStatus(stored.status)
      };
      profileRef.current = restored;
      profileNameDraftRef.current = restored.name;
      profileStatusDraftRef.current = restored.status;
      setProfile(restored);
      setProfileNameDraft(restored.name);
      setProfileStatusDraft(restored.status);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setProfileStorageReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!profileStorageReady) return;
    setProfileSaveState('saving');
    const timer = window.setTimeout(() => {
      void saveStoredProfile({ name: profile.name, avatar: profile.avatar, status: profile.status })
        .then(() => setProfileSaveState('saved'))
        .catch(() => setProfileSaveState('error'));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [profile, profileStorageReady]);

  useEffect(() => {
    if (!audioMenuOpen || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then(setAudioDevices).catch(() => setAudioDevices([]));
  }, [audioMenuOpen, microphoneEnabled]);

  useEffect(() => {
    if (!audioMenuOpen && !screenMenuOpen && !moreMenuOpen && !leaveMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!dockRef.current?.contains(target) && !mobileSheetRef.current?.contains(target)) {
        setAudioMenuOpen(false);
        setScreenMenuOpen(false);
        setMoreMenuOpen(false);
        setLeaveMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [audioMenuOpen, leaveMenuOpen, moreMenuOpen, screenMenuOpen]);

  useEffect(() => {
    if (!emojiOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!emojiPickerRef.current?.contains(event.target as Node)) setEmojiOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [emojiOpen]);

  useEffect(() => {
    if (!chatSettingsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!chatSettingsRef.current?.contains(event.target as Node)) setChatSettingsOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [chatSettingsOpen]);

  useEffect(() => {
    if (!session?.invite.token) {
      setQrCode('');
      setQrOpen(false);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(groupInviteUrl(session.invite, shareOrigin), {
      width: 720,
      margin: 2,
      color: { dark: '#071013', light: '#f7fbfc' },
      errorCorrectionLevel: 'M'
    }).then(value => { if (!cancelled) setQrCode(value); }).catch(() => { if (!cancelled) setQrCode(''); });
    return () => { cancelled = true; };
  }, [session?.invite.roomId, session?.invite.token, shareOrigin]);

  useEffect(() => {
    if (!profileOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!profilePopoverRef.current?.contains(target) && !profileBarRef.current?.contains(target)) {
        commitProfileName();
        commitProfileStatus();
        setProfileOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [profileOpen]);

  useEffect(() => {
    const dismissOverlays = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (qrOpen) {
        setQrOpen(false);
        return;
      }
      if (profileOpen) {
        setProfileOpen(false);
        profileNameDraftRef.current = profileRef.current.name;
        profileStatusDraftRef.current = profileRef.current.status;
        setProfileNameDraft(profileRef.current.name);
        setProfileStatusDraft(profileRef.current.status);
        return;
      }
      if (emojiOpen) {
        setEmojiOpen(false);
        return;
      }
      if (chatSettingsOpen) {
        setChatSettingsOpen(false);
        return;
      }
      if (audioMenuOpen || screenMenuOpen || moreMenuOpen || leaveMenuOpen) {
        setAudioMenuOpen(false);
        setScreenMenuOpen(false);
        setMoreMenuOpen(false);
        setLeaveMenuOpen(false);
        return;
      }
      if (controlsOpen) {
        setControlsOpen(false);
        return;
      }
      if (chatOpen) setChatOpen(false);
    };
    document.addEventListener('keydown', dismissOverlays);
    return () => document.removeEventListener('keydown', dismissOverlays);
  }, [audioMenuOpen, chatOpen, chatSettingsOpen, controlsOpen, emojiOpen, leaveMenuOpen, moreMenuOpen, profileOpen, qrOpen, screenMenuOpen]);

  const scrollChatToLatest = useCallback((smooth = false) => {
    const log = chatLogRef.current;
    if (!log) return;
    chatStickToBottomRef.current = true;
    log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewMessagesBelow(0);
  }, []);

  const isOwnChatMessage = useCallback((message: ChatMessage) => (
    message.senderId === selfIdRef.current || ownChatMessageIdsRef.current.has(message.id)
  ), []);

  const rememberOwnChatMessage = useCallback((messageId: string) => {
    const ids = ownChatMessageIdsRef.current;
    ids.add(messageId);
    while (ids.size > CHAT_LIMIT) {
      const oldest = ids.values().next().value;
      if (!oldest) break;
      ids.delete(oldest);
    }
    const roomId = sessionRef.current?.invite.roomId;
    if (roomId) saveOwnChatMessageIds(roomId, ids);
  }, []);

  useLayoutEffect(() => {
    if (!chatOpen || !chatStickToBottomRef.current) return;
    scrollChatToLatest(false);
  }, [chatMessages.length, chatOpen, scrollChatToLatest]);

  const appendMessage = useCallback((message: ChatMessage) => {
    if (seenMessageIdsRef.current.has(message.id)) return;
    seenMessageIdsRef.current.add(message.id);
    const own = isOwnChatMessage(message);
    if (!own && !message.system) {
      if (!chatOpenRef.current) setUnreadMessages(current => Math.min(99, current + 1));
      else if (!chatStickToBottomRef.current) setNewMessagesBelow(current => Math.min(99, current + 1));
    }
    setChatMessages(current => {
      const next = [...current, message].slice(-CHAT_LIMIT);
      chatMessagesRef.current = next;
      if (seenMessageIdsRef.current.size > CHAT_LIMIT * 2) {
        const retained = new Set(next.map(item => item.id));
        for (const id of seenMessageIdsRef.current) if (!retained.has(id)) seenMessageIdsRef.current.delete(id);
      }
      return next;
    });
  }, [isOwnChatMessage]);

  const mergeChatHistory = useCallback((history: ChatMessage[]) => {
    const incoming = history.filter(message => !seenMessageIdsRef.current.has(message.id));
    if (!incoming.length) return;
    for (const message of incoming) seenMessageIdsRef.current.add(message.id);
    setChatMessages(current => {
      const merged = [...current, ...incoming.map(message => isOwnChatMessage(message) ? { ...message, delivery: 'delivered' as const } : message)]
        .sort((left, right) => left.sentAt - right.sentAt || left.id.localeCompare(right.id))
        .slice(-CHAT_LIMIT);
      chatMessagesRef.current = merged;
      const retained = new Set(merged.map(message => message.id));
      for (const id of seenMessageIdsRef.current) if (!retained.has(id)) seenMessageIdsRef.current.delete(id);
      return merged;
    });
  }, [isOwnChatMessage]);

  const updateChatDelivery = useCallback((messageId: string, delivery: ChatDelivery) => {
    setChatMessages(current => {
      let changed = false;
      const next = current.map(message => {
        if (message.id !== messageId || message.delivery === delivery) return message;
        changed = true;
        return { ...message, delivery };
      });
      if (changed) chatMessagesRef.current = next;
      return changed ? next : current;
    });
  }, []);

  const acknowledgeChatDelivery = useCallback((messageId: string, peerId: string) => {
    const pending = pendingChatMessagesRef.current.get(messageId);
    if (!pending || !pending.awaiting.delete(peerId)) return;
    if (pending.awaiting.size) return;
    pendingChatMessagesRef.current.delete(messageId);
    updateChatDelivery(messageId, 'delivered');
  }, [updateChatDelivery]);

  const settleDepartedChatRecipient = useCallback((peerId: string) => {
    for (const [messageId, pending] of pendingChatMessagesRef.current) {
      if (!pending.awaiting.delete(peerId) || pending.awaiting.size) continue;
      pendingChatMessagesRef.current.delete(messageId);
      updateChatDelivery(messageId, 'sent');
    }
  }, [updateChatDelivery]);

  const failPendingChat = useCallback(() => {
    const messageIds = [...pendingChatMessagesRef.current.keys()];
    pendingChatMessagesRef.current.clear();
    for (const messageId of messageIds) updateChatDelivery(messageId, 'failed');
  }, [updateChatDelivery]);

  const transmitPendingChat = useCallback((messageId: string, force = false) => {
    const pending = pendingChatMessagesRef.current.get(messageId);
    if (!pending) return;
    const now = Date.now();
    if (!force && now - pending.lastAttemptAt < CHAT_RETRY_INTERVAL_MS) return;

    const connectedIds = new Set(Object.values(participantsRef.current)
      .filter(participant => participant.connected && participant.id !== selfIdRef.current)
      .map(participant => participant.id));
    for (const peerId of pending.awaiting) if (!connectedIds.has(peerId)) pending.awaiting.delete(peerId);
    if (!pending.awaiting.size) {
      pendingChatMessagesRef.current.delete(messageId);
      updateChatDelivery(messageId, 'sent');
      return;
    }

    pending.attempts += 1;
    pending.lastAttemptAt = now;
    let transportAccepted = false;
    let missingDirectChannel = false;
    // O formato cru mantém compatibilidade durante deploys em que uma aba ainda roda a versão anterior.
    const payload = chatWireMessage(pending.message);
    for (const peerId of pending.awaiting) {
      const channel = peersRef.current.get(peerId)?.chatChannel ?? null;
      if (sendChatChannelPayload(channel, payload)) transportAccepted = true;
      else missingDirectChannel = true;
    }
    if (missingDirectChannel && !pending.fallbackAccepted) {
      pending.fallbackAccepted = send(socketRef.current, { type: 'chat-fallback', message: chatWireMessage(pending.message) });
      transportAccepted ||= pending.fallbackAccepted;
    }
    if (transportAccepted || pending.fallbackAccepted) updateChatDelivery(messageId, 'sent');
    if (now - pending.firstAttemptAt >= CHAT_FAILURE_TIMEOUT_MS) {
      pendingChatMessagesRef.current.delete(messageId);
      updateChatDelivery(messageId, 'failed');
    }
  }, [updateChatDelivery]);

  const flushPendingChat = useCallback(() => {
    for (const messageId of pendingChatMessagesRef.current.keys()) transmitPendingChat(messageId, true);
  }, [transmitPendingChat]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => flushPendingChat(), CHAT_RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [flushPendingChat, session]);

  const systemMessage = useCallback((text: string) => {
    appendMessage({ id: `system-${Date.now()}-${randomSecret(4)}`, senderId: 'system', senderName: '', text, sentAt: Date.now(), system: true });
  }, [appendMessage]);

  const updateParticipant = useCallback((participant: RoomParticipant) => {
    const next = { ...participantsRef.current, [participant.id]: participant };
    participantsRef.current = next;
    setParticipants(next);
  }, []);

  const updateSelfMediaState = useCallback((next: { sharing?: boolean; microphoneEnabled?: boolean } = {}) => {
    const id = selfIdRef.current;
    if (id) {
      const self = participantsRef.current[id];
      if (self) {
        const updated = { ...participantsRef.current, [id]: { ...self, sharing: next.sharing ?? sharingRef.current, microphoneEnabled: next.microphoneEnabled ?? microphoneEnabledRef.current } };
        participantsRef.current = updated;
        setParticipants(updated);
      }
    }
    send(socketRef.current, {
      type: 'participant-state',
      profile: profileRef.current,
      sharing: next.sharing ?? sharingRef.current,
      microphoneEnabled: next.microphoneEnabled ?? microphoneEnabledRef.current
    });
  }, []);

  useEffect(() => {
    const id = selfIdRef.current;
    if (!profileStorageReady || !id || !participantsRef.current[id]) return;
    updateParticipant({ ...participantsRef.current[id], ...profileRef.current });
    updateSelfMediaState();
  }, [profile, profileStorageReady, updateParticipant, updateSelfMediaState]);

  const playSound = useCallback((name: InterfaceSoundName) => {
    if (!interfaceSoundsEnabledRef.current) return;
    void playCallSound(name, audioSettingsRef.current.outputVolume / 100);
  }, []);

  useEffect(() => {
    const device: RoomProfile['device'] = isMobileDevice() ? 'mobile' : 'desktop';
    if (profileRef.current.device === device) return;
    const updated = { ...profileRef.current, device };
    profileRef.current = updated;
    setProfile(updated);
    const id = selfIdRef.current;
    if (id && participantsRef.current[id]) updateParticipant({ ...participantsRef.current[id], ...updated });
    updateSelfMediaState();
  }, [mobile, updateParticipant, updateSelfMediaState]);

  const attachChatChannel = useCallback((record: PeerRecord, channel: RTCDataChannel) => {
    record.chatChannel = channel;
    let receivedWindowStartedAt = Date.now();
    let receivedInWindow = 0;
    const opened = () => {
      sendChatHistory(channel, chatMessagesRef.current);
      flushPendingChat();
    };
    channel.onopen = opened;
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || chatPayloadSize(event.data) > CHAT_CHANNEL_PAYLOAD_LIMIT) return;
      const now = Date.now();
      if (now - receivedWindowStartedAt >= 10_000) {
        receivedWindowStartedAt = now;
        receivedInWindow = 0;
      }
      receivedInWindow += 1;
      if (receivedInWindow > 60) return;
      try {
        const incoming = JSON.parse(event.data) as Partial<ChatChannelPayload> & Partial<ChatWireMessage>;
        if (incoming.type === 'chat-ack') {
          const messageId = normalizeChatId(incoming.messageId);
          if (messageId) acknowledgeChatDelivery(messageId, record.id);
          return;
        }
        if (incoming.type === 'chat-history') {
          if (!Array.isArray(incoming.messages)) return;
          const history = incoming.messages.slice(-CHAT_LIMIT)
            .map(message => normalizeChatWireMessage(message))
            .filter((message): message is ChatMessage => Boolean(message));
          mergeChatHistory(history);
          return;
        }
        const participant = participantsRef.current[record.id];
        const message = normalizeChatWireMessage(incoming.type === 'chat-message' ? incoming.message : incoming, {
          id: record.id,
          name: participant?.name || 'Participante'
        });
        if (!message) return;
        appendMessage(message);
        if (!sendChatChannelPayload(channel, { type: 'chat-ack', messageId: message.id })) {
          send(socketRef.current, { type: 'chat-ack', targetId: record.id, messageId: message.id });
        }
      } catch {
        // Mensagens inválidas não afetam a chamada.
      }
    };
    channel.onclose = () => { if (record.chatChannel === channel) record.chatChannel = null; };
    if (channel.readyState === 'open') queueMicrotask(opened);
  }, [acknowledgeChatDelivery, appendMessage, flushPendingChat, mergeChatHistory]);

  const destroyPeer = useCallback((peerId: string) => {
    const record = peersRef.current.get(peerId);
    if (!record) return;
    peersRef.current.delete(peerId);
    if (record.recoveryTimer !== null) window.clearTimeout(record.recoveryTimer);
    record.chatChannel?.close();
    record.callAudio?.remove();
    record.screenAudio?.remove();
    record.pc.ontrack = null;
    record.pc.onicecandidate = null;
    record.pc.onconnectionstatechange = null;
    record.pc.ondatachannel = null;
    if (record.screenVideoReceiver) {
      record.screenVideoReceiver.track.onmute = null;
      record.screenVideoReceiver.track.onunmute = null;
    }
    record.pc.close();
    setPeerVersion(version => version + 1);
  }, []);

  const markPlaybackBlocked = useCallback(() => {
    if (!playbackEnabledRef.current) return;
    playbackEnabledRef.current = false;
    setPlaybackEnabled(false);
    for (const peer of peersRef.current.values()) {
      if (peer.callAudio) peer.callAudio.muted = true;
      if (peer.screenAudio) peer.screenAudio.muted = true;
    }
    setError('O navegador bloqueou o áudio automático. Clique em Áudio para ouvir a chamada.');
  }, []);

  const restartPeerIce = useCallback(async (record: PeerRecord) => {
    if (record.makingOffer || record.pc.connectionState === 'closed' || record.pc.signalingState !== 'stable') return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    record.makingOffer = true;
    record.recoveryAttempts += 1;
    try {
      record.pc.restartIce();
      const offer = await record.pc.createOffer({ iceRestart: true });
      await record.pc.setLocalDescription(offer);
      send(socket, { type: 'peer-signal', targetId: record.id, kind: 'offer', sdp: record.pc.localDescription ?? offer });
    } catch {
      if (record.recoveryAttempts >= 2 && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.close(4101, 'Recreate peer connection');
      }
    } finally {
      record.makingOffer = false;
    }
  }, []);

  const syncPeerMedia = useCallback(async (record: PeerRecord) => {
    const transceivers = record.pc.getTransceivers();
    const audio = transceivers.filter(item => item.receiver.track.kind === 'audio');
    const video = transceivers.filter(item => item.receiver.track.kind === 'video');
    const call = audio[0];
    const screenAudio = audio[1];
    const screenVideo = video[0];
    if (!call || !screenAudio || !screenVideo) return;
    // Transceivers criados implicitamente ao receber uma oferta começam como recvonly.
    // A direção precisa ser corrigida antes do createAnswer para permitir envio nos dois sentidos.
    call.direction = 'sendrecv';
    screenVideo.direction = 'sendrecv';
    screenAudio.direction = 'sendrecv';
    record.callAudioSender = call.sender;
    record.screenAudioSender = screenAudio.sender;
    record.screenVideoSender = screenVideo.sender;
    record.callAudioReceiver = call.receiver;
    record.screenAudioReceiver = screenAudio.receiver;
    record.screenVideoReceiver = screenVideo.receiver;
    await Promise.all([
      call.sender.replaceTrack(localMicrophoneTrackRef.current).catch(() => undefined),
      screenVideo.sender.replaceTrack(localScreenStreamRef.current?.getVideoTracks()[0] ?? null).catch(() => undefined),
      screenAudio.sender.replaceTrack(localScreenStreamRef.current?.getAudioTracks()[0] ?? null).catch(() => undefined)
    ]);
    const activeResolution = automaticQualityRef.current ? 720 : resolutionRef.current;
    const activeFps = automaticQualityRef.current ? 30 : fpsRef.current;
    await configureScreenSender(screenVideo.sender, activeResolution, activeFps, adaptiveBitrateRef.current, bitrateMbpsRef.current);
    const callTrack = call.receiver.track;
    if (!record.callAudio || !(record.callAudio.srcObject instanceof MediaStream) || record.callAudio.srcObject.getAudioTracks()[0]?.id !== callTrack.id) {
      record.callAudio?.remove();
      const audioElement = document.createElement('audio');
      audioElement.autoplay = true;
      audioElement.muted = !playbackEnabledRef.current;
      audioElement.volume = (audioSettingsRef.current.outputVolume / 100) * ((participantVolumesRef.current[record.id] ?? 100) / 100);
      const sinkable = audioElement as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
      if (audioSettingsRef.current.outputDeviceId && sinkable.setSinkId) void sinkable.setSinkId(audioSettingsRef.current.outputDeviceId).catch(() => undefined);
      audioElement.srcObject = mediaStreamWith(callTrack);
      audioElement.dataset.roomPeer = record.id;
      document.body.append(audioElement);
      record.callAudio = audioElement;
      if (playbackEnabledRef.current) void audioElement.play().catch(markPlaybackBlocked);
    }
    const screenAudioTrack = screenAudio.receiver.track;
    if (!record.screenAudio || !(record.screenAudio.srcObject instanceof MediaStream) || record.screenAudio.srcObject.getAudioTracks()[0]?.id !== screenAudioTrack.id) {
      record.screenAudio?.remove();
      const audioElement = document.createElement('audio');
      audioElement.autoplay = true;
      audioElement.muted = !playbackEnabledRef.current;
      audioElement.volume = (audioSettingsRef.current.outputVolume / 100) * ((screenVolumesRef.current[record.id] ?? 100) / 100);
      const sinkable = audioElement as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
      if (audioSettingsRef.current.outputDeviceId && sinkable.setSinkId) void sinkable.setSinkId(audioSettingsRef.current.outputDeviceId).catch(() => undefined);
      audioElement.srcObject = mediaStreamWith(screenAudioTrack);
      audioElement.dataset.roomScreenAudioPeer = record.id;
      document.body.append(audioElement);
      record.screenAudio = audioElement;
      if (playbackEnabledRef.current) void audioElement.play().catch(markPlaybackBlocked);
    }
    const screenVideoTrack = screenVideo.receiver.track;
    for (const track of record.screenStream.getTracks()) record.screenStream.removeTrack(track);
    record.screenStream.addTrack(screenVideoTrack);
    screenVideoTrack.onunmute = () => setPeerVersion(version => version + 1);
    screenVideoTrack.onmute = () => setPeerVersion(version => version + 1);
    setPeerVersion(version => version + 1);
  }, [markPlaybackBlocked]);

  const createPeer = useCallback(async (peerId: string, initiator: boolean) => {
    const existing = peersRef.current.get(peerId);
    if (existing && existing.pc.connectionState !== 'closed' && existing.pc.connectionState !== 'failed') return existing;
    if (existing) destroyPeer(peerId);
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current as RTCIceServer[], bundlePolicy: 'max-bundle', iceCandidatePoolSize: 4 });
    const record: PeerRecord = {
      id: peerId,
      pc,
      queuedCandidates: [],
      callAudioSender: null,
      screenVideoSender: null,
      screenAudioSender: null,
      callAudioReceiver: null,
      screenVideoReceiver: null,
      screenAudioReceiver: null,
      chatChannel: null,
      callAudio: null,
      screenAudio: null,
      screenStream: new MediaStream(),
      recoveryTimer: null,
      recoveryAttempts: 0,
      makingOffer: false,
      ignoreOffer: false,
      polite: selfIdRef.current.localeCompare(peerId) > 0
    };
    peersRef.current.set(peerId, record);
    pc.onicecandidate = event => {
      if (event.candidate) send(socketRef.current, { type: 'peer-signal', targetId: peerId, kind: 'ice-candidate', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = () => { window.setTimeout(() => void syncPeerMedia(record), 0); };
    pc.ondatachannel = event => { if (event.channel.label === 'room-chat') attachChatChannel(record, event.channel); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (record.recoveryTimer !== null) window.clearTimeout(record.recoveryTimer);
        record.recoveryTimer = null;
        record.recoveryAttempts = 0;
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        if (record.recoveryTimer !== null) window.clearTimeout(record.recoveryTimer);
        const preferredInitiator = selfIdRef.current.localeCompare(peerId) < 0;
        const delay = pc.connectionState === 'failed'
          ? (preferredInitiator ? 0 : 1_400)
          : (preferredInitiator ? 2_200 : 4_200);
        record.recoveryTimer = window.setTimeout(() => {
          record.recoveryTimer = null;
          void restartPeerIce(record);
        }, delay);
      } else if (pc.connectionState === 'closed') {
        destroyPeer(peerId);
      }
      setPeerVersion(version => version + 1);
    };
    if (initiator) {
      const microphone = localMicrophoneTrackRef.current;
      const screenVideo = localScreenStreamRef.current?.getVideoTracks()[0] ?? null;
      const screenAudio = localScreenStreamRef.current?.getAudioTracks()[0] ?? null;
      const callTransceiver = pc.addTransceiver(microphone ?? 'audio', { direction: 'sendrecv' });
      const videoTransceiver = pc.addTransceiver(screenVideo ?? 'video', { direction: 'sendrecv' });
      const screenAudioTransceiver = pc.addTransceiver(screenAudio ?? 'audio', { direction: 'sendrecv' });
      record.callAudioSender = callTransceiver.sender;
      record.callAudioReceiver = callTransceiver.receiver;
      record.screenVideoSender = videoTransceiver.sender;
      record.screenVideoReceiver = videoTransceiver.receiver;
      record.screenAudioSender = screenAudioTransceiver.sender;
      record.screenAudioReceiver = screenAudioTransceiver.receiver;
      attachChatChannel(record, pc.createDataChannel('room-chat', { ordered: true }));
      record.makingOffer = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send(socketRef.current, { type: 'peer-signal', targetId: peerId, kind: 'offer', sdp: pc.localDescription ?? offer });
      } finally {
        record.makingOffer = false;
      }
    }
    setPeerVersion(version => version + 1);
    return record;
  }, [attachChatChannel, destroyPeer, restartPeerIce, syncPeerMedia]);

  const handleRoomMessage = useCallback(async (message: RoomMessage) => {
    if (message.type === 'room-ready') {
      iceServersRef.current = message.iceServers;
      setTurnAvailable(hasTurnServer(message.iceServers));
      if (message.resumed) {
        for (const peerId of [...peersRef.current.keys()]) destroyPeer(peerId);
      }
      selfIdRef.current = message.selfId;
      setSelfId(message.selfId);
      ownChatMessageIdsRef.current = new Set([
        ...ownChatMessageIdsRef.current,
        ...loadOwnChatMessageIds(message.roomId)
      ]);
      setLeaderId(message.leaderId);
      if (message.maxParticipants) setMaxParticipants(message.maxParticipants);
      const next = Object.fromEntries(message.participants.map(participant => [participant.id, participant]));
      const localParticipant = next[message.selfId];
      if (localParticipant) next[message.selfId] = { ...localParticipant, ...profileRef.current };
      participantsRef.current = next;
      setParticipants(next);
      setMode('connected');
      setError('');
      if (!callSoundConnectedRef.current) {
        callSoundConnectedRef.current = true;
        playSound('callConnected');
      }
      const activeSession = sessionRef.current;
      if (activeSession) {
        const nextSession = { ...activeSession, invite: message.invite, joinCode: message.joinCode, joinByCode: false, participantId: message.selfId };
        sessionRef.current = nextSession;
        setSession(nextSession);
        if (nextSession.ownerKey) writeStorage('localStorage', OWNER_ROOM_KEY, JSON.stringify(nextSession));
        else {
          writeStorage('sessionStorage', `${PEER_KEY_PREFIX}${message.roomId}`, message.selfId);
          history.replaceState(null, '', `${location.pathname}#${new URLSearchParams({ room: message.invite.roomId, key: message.invite.token })}`);
        }
      }
      await Promise.all(message.participants
        .filter(participant => participant.id !== message.selfId && participant.connected)
        .map(participant => createPeer(participant.id, true)));
      updateSelfMediaState();
      flushPendingChat();
      return;
    }
    if (message.type === 'participant-joined') {
      updateParticipant(message.participant);
      systemMessage(`${message.participant.name} entrou na chamada.`);
      playSound('participantJoined');
      return;
    }
    if (message.type === 'participant-left') {
      const name = participantsRef.current[message.peerId]?.name || 'Um participante';
      settleDepartedChatRecipient(message.peerId);
      destroyPeer(message.peerId);
      const nextParticipants = { ...participantsRef.current };
      delete nextParticipants[message.peerId];
      participantsRef.current = nextParticipants;
      setParticipants(nextParticipants);
      setScreenVolumes(current => {
        if (!(message.peerId in current)) return current;
        const next = { ...current };
        delete next[message.peerId];
        screenVolumesRef.current = next;
        return next;
      });
      setParticipantVolumes(current => {
        if (!(message.peerId in current)) return current;
        const next = { ...current };
        delete next[message.peerId];
        participantVolumesRef.current = next;
        return next;
      });
      systemMessage(`${name} saiu da chamada.`);
      playSound('participantLeft');
      return;
    }
    if (message.type === 'participant-state') {
      const previous = participantsRef.current[message.participant.id];
      updateParticipant(message.participant);
      if (message.participant.id !== selfIdRef.current && previous && previous.sharing !== message.participant.sharing) {
        playSound(message.participant.sharing ? 'screenStarted' : 'screenStopped');
      }
      return;
    }
    if (message.type === 'leader-changed') {
      setLeaderId(message.leaderId);
      const name = participantsRef.current[message.leaderId]?.name || 'Outro participante';
      systemMessage(message.reclaimed ? `${name} retomou a liderança da sala.` : `${name} assumiu a liderança da sala.`);
      return;
    }
    if (message.type === 'peer-signal') {
      let record = peersRef.current.get(message.fromId);
      if (message.kind === 'offer') {
        if (!record || record.pc.connectionState === 'closed' || record.pc.connectionState === 'failed') record = await createPeer(message.fromId, false);
        const offerCollision = record.makingOffer || record.pc.signalingState !== 'stable';
        record.ignoreOffer = !record.polite && offerCollision;
        if (record.ignoreOffer) return;
        if (offerCollision) await record.pc.setLocalDescription({ type: 'rollback' });
        await record.pc.setRemoteDescription(message.sdp);
        record.ignoreOffer = false;
        await syncPeerMedia(record);
        for (const candidate of record.queuedCandidates.splice(0)) await record.pc.addIceCandidate(candidate).catch(() => undefined);
        const answer = await record.pc.createAnswer();
        await record.pc.setLocalDescription(answer);
        send(socketRef.current, { type: 'peer-signal', targetId: message.fromId, kind: 'answer', sdp: answer });
        return;
      }
      if (message.kind === 'answer') {
        if (!record) return;
        if (record.pc.signalingState !== 'have-local-offer') return;
        record.ignoreOffer = false;
        await record.pc.setRemoteDescription(message.sdp);
        await syncPeerMedia(record);
        for (const candidate of record.queuedCandidates.splice(0)) await record.pc.addIceCandidate(candidate).catch(() => undefined);
        return;
      }
      if (!record) record = await createPeer(message.fromId, false);
      if (record.ignoreOffer) return;
      if (record.pc.remoteDescription) await record.pc.addIceCandidate(message.candidate).catch(() => undefined);
      else if (record.queuedCandidates.length < 128) record.queuedCandidates.push(message.candidate);
      return;
    }
    if (message.type === 'chat-fallback') {
      const normalized = normalizeChatWireMessage(message.message);
      if (!normalized) return;
      appendMessage(normalized);
      const channel = peersRef.current.get(normalized.senderId)?.chatChannel ?? null;
      if (!sendChatChannelPayload(channel, { type: 'chat-ack', messageId: normalized.id })) {
        send(socketRef.current, { type: 'chat-ack', targetId: normalized.senderId, messageId: normalized.id });
      }
      return;
    }
    if (message.type === 'chat-ack') {
      const messageId = normalizeChatId(message.messageId);
      if (messageId) acknowledgeChatDelivery(messageId, message.fromId);
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'room-closed') {
      if (sessionRef.current?.ownerKey) removeStorage('localStorage', OWNER_ROOM_KEY);
      if (sessionRef.current?.invite.roomId) removeStorage('sessionStorage', `${CHAT_OWN_IDS_PREFIX}${sessionRef.current.invite.roomId}`);
      failPendingChat();
      if (callSoundConnectedRef.current) playSound('callDisconnected');
      callSoundConnectedRef.current = false;
      setError('O criador encerrou a sala.');
      setMode('error');
      return;
    }
    if (message.type === 'error') {
      setError(message.message);
      const fatalBeforeJoining = !selfIdRef.current;
      if (fatalBeforeJoining || message.code === 'ROOM_NOT_FOUND' || message.code === 'HOST_OFFLINE') {
        setMode('error');
        if (sessionRef.current?.ownerKey) removeStorage('localStorage', OWNER_ROOM_KEY);
        if (message.code === 'ROOM_NOT_FOUND' && sessionRef.current?.invite.roomId) {
          removeStorage('sessionStorage', `${CHAT_OWN_IDS_PREFIX}${sessionRef.current.invite.roomId}`);
        }
      }
    }
  }, [acknowledgeChatDelivery, appendMessage, createPeer, destroyPeer, failPendingChat, flushPendingChat, playSound, settleDepartedChatRecipient, syncPeerMedia, systemMessage, updateParticipant, updateSelfMediaState]);

  useEffect(() => {
    if (!session) return;
    disposedRef.current = false;
    let currentSocket: WebSocket | null = null;
    let attempts = 0;
    let pingTimer: number | null = null;

    const connect = () => {
      if (disposedRef.current) return;
      if (currentSocket && (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)) return;
      setMode(current => current === 'connected' ? current : 'connecting');
      const socket = new WebSocket(signalUrl());
      currentSocket = socket;
      socketRef.current = socket;
      socket.onopen = () => {
        attempts = 0;
        const current = sessionRef.current;
        if (!current) return;
        if (current.ownerKey) {
          send(socket, { type: 'create-group-room', ...current.invite, ownerKey: current.ownerKey, participantId: current.participantId, profile: profileRef.current, maxParticipants: current.maxParticipants ?? maxParticipants });
        } else if (current.joinByCode && current.joinCode) {
          const participantId = current.participantId || readStorage('sessionStorage', `${PEER_KEY_PREFIX}${current.joinCode}`) || undefined;
          send(socket, { type: 'join-group-room-code', code: current.joinCode, participantId, profile: profileRef.current });
        } else {
          const participantId = current.participantId || readStorage('sessionStorage', `${PEER_KEY_PREFIX}${current.invite.roomId}`) || undefined;
          send(socket, { type: 'join-group-room', ...current.invite, participantId, profile: profileRef.current });
        }
        if (pingTimer !== null) window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => send(socket, { type: 'ping', at: Date.now() }), 3_000);
      };
      socket.onmessage = event => {
        let message: RoomMessage;
        try {
          message = JSON.parse(String(event.data)) as RoomMessage;
        } catch {
          setError('A sala enviou uma resposta inválida.');
          return;
        }
        void handleRoomMessage(message).catch(() => {
          setError('Não foi possível sincronizar a chamada. A conexão será refeita automaticamente.');
          if (socket.readyState === WebSocket.OPEN) socket.close(4102, 'Room synchronization failed');
        });
      };
      socket.onerror = () => setError('O servidor está demorando para responder…');
      socket.onclose = event => {
        if (pingTimer !== null) window.clearInterval(pingTimer);
        if (socketRef.current === socket) socketRef.current = null;
        if (currentSocket === socket) currentSocket = null;
        if (disposedRef.current || event.code === 1000) return;
        setMode('connecting');
        reconnectTimerRef.current = window.setTimeout(connect, Math.min(7_000, 600 * 2 ** Math.min(attempts++, 4)));
      };
    };
    reconnectNowRef.current = () => {
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      connect();
    };
    connect();
    return () => {
      disposedRef.current = true;
      reconnectNowRef.current = null;
      if (pingTimer !== null) window.clearInterval(pingTimer);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      currentSocket?.close(1000, 'Session changed');
      if (socketRef.current === currentSocket) socketRef.current = null;
    };
  // Os dados da sessão podem ser enriquecidos após entrar por código curto. A conexão
  // deve sobreviver a essa atualização; ela só nasce ou termina com a própria sessão.
  }, [handleRoomMessage, Boolean(session)]);

  useEffect(() => {
    if (!session) return;
    const recover = () => {
      reconnectNowRef.current?.();
      for (const peer of peersRef.current.values()) {
        if (peer.pc.connectionState === 'disconnected' || peer.pc.connectionState === 'failed') void restartPeerIce(peer);
      }
    };
    const recoverWhenVisible = () => { if (document.visibilityState === 'visible') recover(); };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recoverWhenVisible);
    return () => {
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recoverWhenVisible);
    };
  }, [restartPeerIce, session]);

  useEffect(() => {
    if (!session || mode !== 'connected') {
      setMediaLatency(null);
      return;
    }
    let cancelled = false;
    const sample = async () => {
      const connected = [...peersRef.current.values()].filter(peer => peer.pc.connectionState === 'connected');
      if (!connected.length) {
        if (!cancelled) setMediaLatency(null);
        return;
      }
      const values = await Promise.all(connected.map(peer => readPeerRttMs(peer.pc).catch(() => null)));
      const valid = values.filter((value): value is number => value !== null);
      if (!cancelled) setMediaLatency(valid.length ? Math.max(...valid) : null);
    };
    void sample();
    const timer = window.setInterval(() => void sample(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode, session?.invite.roomId]);

  const disposeMicrophonePipeline = useCallback(() => {
    const outbound = localMicrophoneTrackRef.current;
    localMicrophoneTrackRef.current = null;
    if (outbound && !microphoneSourceStreamRef.current?.getTracks().includes(outbound)) outbound.stop();
    microphoneSourceStreamRef.current?.getTracks().forEach(track => track.stop());
    microphoneSourceStreamRef.current = null;
    localMicrophoneStreamRef.current = null;
    microphoneGainRef.current = null;
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }, []);

  const acquireMicrophone = useCallback(async (force = false, exactSetting?: VoiceSettingKey) => {
    const current = localMicrophoneTrackRef.current;
    if (!force && current?.readyState === 'live') {
      current.enabled = true;
      setMicrophoneEnabled(true);
      microphoneEnabledRef.current = true;
      updateSelfMediaState({ microphoneEnabled: true });
      return true;
    }
    if (microphonePendingRef.current) return false;
    microphonePendingRef.current = true;
    setMicrophonePending(true);
    const requestEpoch = mediaRequestEpochRef.current;
    const requestId = ++microphoneRequestIdRef.current;
    try {
      const settings = audioSettingsRef.current;
      const sourceStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: microphoneConstraints(settings, voiceSettingSupport, exactSetting)
      });
      if (requestEpoch !== mediaRequestEpochRef.current || requestId !== microphoneRequestIdRef.current || !sessionRef.current) {
        sourceStream.getTracks().forEach(track => track.stop());
        return false;
      }
      const sourceTrack = sourceStream.getAudioTracks()[0];
      if (!sourceTrack) {
        sourceStream.getTracks().forEach(track => track.stop());
        return false;
      }
      setVoiceSettingSupport(detectVoiceTrackSupport(sourceTrack, voiceSettingSupport));
      const verifiedSettings = readVoiceTrackSettings(sourceTrack);
      verifiedVoiceSettingsRef.current = verifiedSettings;
      setVerifiedVoiceSettings(verifiedSettings);
      const effectiveSettings = { ...settings };
      let browserAdjustedSettings = false;
      for (const key of VOICE_SETTING_KEYS) {
        const verified = verifiedSettings[key];
        if (typeof verified !== 'boolean') continue;
        if (verified !== settings[key]) browserAdjustedSettings = true;
        effectiveSettings[key] = verified;
      }
      audioSettingsRef.current = effectiveSettings;
      setAudioSettings(effectiveSettings);
      const hasVerifiedSettings = VOICE_SETTING_KEYS.some(key => typeof verifiedSettings[key] === 'boolean');
      setVoiceSettingFeedback(browserAdjustedSettings
        ? 'O navegador ajustou os filtros; o estado exibido agora corresponde ao áudio enviado.'
        : hasVerifiedSettings
          ? 'Tratamentos confirmados no áudio enviado aos participantes.'
          : 'O navegador aceitou os tratamentos, mas este driver não expõe a confirmação.');
      disposeMicrophonePipeline();
      microphoneSourceStreamRef.current = sourceStream;
      localMicrophoneStreamRef.current = sourceStream;
      let outboundTrack = sourceTrack;
      try {
        const context = new AudioContext();
        const source = context.createMediaStreamSource(sourceStream);
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        gain.gain.value = settings.inputVolume / 100;
        source.connect(gain);
        gain.connect(destination);
        gain.connect(analyser);
        audioContextRef.current = context;
        microphoneGainRef.current = gain;
        analyserRef.current = analyser;
        outboundTrack = destination.stream.getAudioTracks()[0] ?? sourceTrack;
        void context.resume().catch(() => undefined);
      } catch {
        analyserRef.current = null;
      }
      localMicrophoneTrackRef.current = outboundTrack;
      outboundTrack.enabled = true;
      setMicrophoneEnabled(true);
      microphoneEnabledRef.current = true;
      await Promise.all([...peersRef.current.values()].map(peer => peer.callAudioSender?.replaceTrack(outboundTrack).catch(() => undefined)));
      updateSelfMediaState({ microphoneEnabled: true });
      sourceTrack.addEventListener('ended', () => {
        if (microphoneSourceStreamRef.current !== sourceStream) return;
        const wasEnabled = microphoneEnabledRef.current;
        disposeMicrophonePipeline();
        verifiedVoiceSettingsRef.current = {};
        setVerifiedVoiceSettings({});
        microphoneEnabledRef.current = false;
        setMicrophoneEnabled(false);
        updateSelfMediaState({ microphoneEnabled: false });
        if (wasEnabled && !endingCallRef.current) playSound('microphoneMuted');
      }, { once: true });
      return true;
    } catch {
      if (requestEpoch !== mediaRequestEpochRef.current || requestId !== microphoneRequestIdRef.current || !sessionRef.current) return false;
      if (exactSetting) return false;
      setVoiceSettingFeedback('Não foi possível acessar o microfone. Verifique a permissão e o dispositivo de entrada.');
      setError('Não foi possível abrir o microfone. Confira a permissão e o dispositivo de entrada.');
      return false;
    } finally {
      if (requestId === microphoneRequestIdRef.current) {
        microphonePendingRef.current = false;
        setMicrophonePending(false);
      }
    }
  }, [disposeMicrophonePipeline, playSound, updateSelfMediaState, voiceSettingSupport]);

  const toggleMicrophone = useCallback(async () => {
    if (!localMicrophoneTrackRef.current || localMicrophoneTrackRef.current.readyState !== 'live') {
      const enabled = await acquireMicrophone();
      if (enabled) playSound('microphoneEnabled');
      return;
    }
    const next = !microphoneEnabledRef.current;
    localMicrophoneTrackRef.current.enabled = next;
    microphoneEnabledRef.current = next;
    setMicrophoneEnabled(next);
    updateSelfMediaState({ microphoneEnabled: next });
    playSound(next ? 'microphoneEnabled' : 'microphoneMuted');
  }, [acquireMicrophone, playSound, updateSelfMediaState]);

  const applyScreenEncoding = useCallback(async (nextResolution: Resolution, nextFps: FrameRate, adaptive = adaptiveBitrateRef.current, manualMbps = bitrateMbpsRef.current) => {
    await Promise.all([...peersRef.current.values()].map(peer => configureScreenSender(peer.screenVideoSender, nextResolution, nextFps, adaptive, manualMbps)));
  }, []);

  const stopScreenShare = useCallback(() => {
    const wasSharing = sharingRef.current;
    const stream = localScreenStreamRef.current;
    localScreenStreamRef.current = null;
    stream?.getTracks().forEach(track => track.stop());
    sharingRef.current = false;
    setSharing(false);
    for (const peer of peersRef.current.values()) {
      void peer.screenVideoSender?.replaceTrack(null);
      void peer.screenAudioSender?.replaceTrack(null);
    }
    updateSelfMediaState({ sharing: false });
    if (wasSharing && !endingCallRef.current) playSound('screenStopped');
  }, [playSound, updateSelfMediaState]);

  useEffect(() => {
    if (mode !== 'error') return;
    mediaRequestEpochRef.current += 1;
    microphoneRequestIdRef.current += 1;
    screenShareRequestIdRef.current += 1;
    microphonePendingRef.current = false;
    setMicrophonePending(false);
    screenSharePendingRef.current = false;
    setScreenSharePending(false);
    endingCallRef.current = true;
    socketRef.current?.close(1000, 'Room unavailable');
    for (const peerId of [...peersRef.current.keys()]) destroyPeer(peerId);
    stopScreenShare();
    disposeMicrophonePipeline();
    microphoneEnabledRef.current = false;
    setMicrophoneEnabled(false);
    verifiedVoiceSettingsRef.current = {};
    setVerifiedVoiceSettings({});
    setVoiceSettingFeedback('');
    sharingRef.current = false;
    setSharing(false);
    setSpeakingIds(new Set());
    const releaseEndingState = window.setTimeout(() => { endingCallRef.current = false; }, 400);
    return () => window.clearTimeout(releaseEndingState);
  }, [destroyPeer, disposeMicrophonePipeline, mode, stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    if (screenSharePendingRef.current) return;
    if (sharingRef.current) {
      stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Este navegador não oferece compartilhamento de tela. No celular, use um navegador que disponibilize essa permissão.');
      return;
    }
    screenSharePendingRef.current = true;
    setScreenSharePending(true);
    const requestEpoch = mediaRequestEpochRef.current;
    const requestId = ++screenShareRequestIdRef.current;
    try {
      const activeResolution = automaticQuality ? 720 : resolution;
      const activeFps = automaticQuality ? 30 : fps;
      const preset = VIDEO_PRESETS[activeResolution];
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: preset.width, max: preset.width }, height: { ideal: preset.height, max: preset.height }, frameRate: { ideal: activeFps, max: activeFps } }, audio: true });
      if (requestEpoch !== mediaRequestEpochRef.current || requestId !== screenShareRequestIdRef.current || !sessionRef.current || mode === 'error') {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const video = stream.getVideoTracks()[0];
      if (!video) {
        stream.getTracks().forEach(track => track.stop());
        setError('O navegador não forneceu uma trilha de vídeo para compartilhar.');
        return;
      }
      localScreenStreamRef.current = stream;
      video.contentHint = activeFps >= 45 ? 'motion' : 'detail';
      const screenAudio = stream.getAudioTracks()[0] ?? null;
      await Promise.all([...peersRef.current.values()].flatMap(peer => [
        peer.screenVideoSender?.replaceTrack(video).catch(() => undefined),
        peer.screenAudioSender?.replaceTrack(screenAudio).catch(() => undefined)
      ]).filter(Boolean));
      await applyScreenEncoding(activeResolution, activeFps);
      sharingRef.current = true;
      setSharing(true);
      updateSelfMediaState({ sharing: true });
      playSound('screenStarted');
      video.addEventListener('ended', stopScreenShare, { once: true });
    } catch (screenError) {
      if (screenError instanceof DOMException && screenError.name === 'NotAllowedError') return;
      setError('Não foi possível iniciar o compartilhamento. Tente escolher novamente a tela, janela ou aba.');
    } finally {
      if (requestId === screenShareRequestIdRef.current) {
        screenSharePendingRef.current = false;
        setScreenSharePending(false);
      }
    }
  }, [applyScreenEncoding, automaticQuality, fps, mode, playSound, resolution, stopScreenShare, updateSelfMediaState]);

  const applyVideoProfile = useCallback(async (nextResolution: Resolution, nextFps: FrameRate) => {
    resolutionRef.current = nextResolution;
    fpsRef.current = nextFps;
    setResolution(nextResolution);
    setFps(nextFps);
    const track = localScreenStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const preset = VIDEO_PRESETS[nextResolution];
    track.contentHint = nextFps >= 45 ? 'motion' : 'detail';
    await track.applyConstraints({ width: { ideal: preset.width, max: preset.width }, height: { ideal: preset.height, max: preset.height }, frameRate: { ideal: nextFps, max: nextFps } }).catch(() => undefined);
    await applyScreenEncoding(nextResolution, nextFps);
  }, [applyScreenEncoding]);

  function changeAutomaticQuality(enabled: boolean) {
    automaticQualityRef.current = enabled;
    setAutomaticQuality(enabled);
    if (enabled) void applyVideoProfile(720, 30);
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = new Set<string>();
      const analyser = analyserRef.current;
      if (selfIdRef.current && microphoneEnabledRef.current && analyser) {
        const values = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(values);
        let energy = 0;
        for (const value of values) energy += ((value - 128) / 128) ** 2;
        if (Math.sqrt(energy / values.length) > .035) next.add(selfIdRef.current);
      }
      for (const peer of peersRef.current.values()) {
        const sources = peer.callAudioReceiver?.getSynchronizationSources?.() ?? [];
        if (sources.some(source => Number(source.audioLevel || 0) > .025)) next.add(peer.id);
      }
      setSpeakingIds(current => {
        if (current.size === next.size && [...current].every(id => next.has(id))) return current;
        return next;
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    for (const peerId of [...peersRef.current.keys()]) destroyPeer(peerId);
    pendingChatMessagesRef.current.clear();
    localScreenStreamRef.current?.getTracks().forEach(track => track.stop());
    disposeMicrophonePipeline();
  }, [destroyPeer, disposeMicrophonePipeline]);

  function updateProfile(next: Partial<RoomProfile>) {
    profileEditRevisionRef.current += 1;
    const updated = { ...profileRef.current, ...next, name: normalizeName(next.name ?? profileRef.current.name), avatar: normalizeAvatar(next.avatar ?? profileRef.current.avatar), status: normalizeStatus(next.status ?? profileRef.current.status), device: isMobileDevice() ? 'mobile' : 'desktop' } as RoomProfile;
    profileRef.current = updated;
    setProfile(updated);
    const id = selfIdRef.current;
    if (id && participantsRef.current[id]) updateParticipant({ ...participantsRef.current[id], ...updated });
    updateSelfMediaState();
  }

  function commitProfileName() {
    const name = normalizeName(profileNameDraftRef.current || profileRef.current.name);
    profileNameDraftRef.current = name;
    setProfileNameDraft(name);
    if (name !== profileRef.current.name) updateProfile({ name });
  }

  function commitProfileStatus() {
    const status = normalizeStatus(profileStatusDraftRef.current || profileRef.current.status);
    profileStatusDraftRef.current = status;
    setProfileStatusDraft(status);
    if (status !== profileRef.current.status) updateProfile({ status });
  }

  async function uploadAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setAvatarUploading(true);
    setProfileSaveState('saving');
    try {
      const avatar = await prepareAvatar(file);
      updateProfile({ avatar });
      await saveStoredProfile({ name: profileRef.current.name, avatar, status: profileRef.current.status });
      setProfileSaveState('saved');
    } catch (avatarError) {
      setProfileSaveState('error');
      setError(avatarError instanceof Error ? avatarError.message : 'Não foi possível salvar a foto agora.');
    } finally {
      setAvatarUploading(false);
    }
  }

  function removeCustomAvatar() {
    updateProfile({ avatar: 'orbit' });
  }

  async function createRoom() {
    void unlockInterfaceSounds();
    const invite = createPrivateRoom();
    const next: Session = { invite, ownerKey: randomSecret(), maxParticipants };
    mediaRequestEpochRef.current += 1;
    sessionRef.current = next;
    writeStorage('localStorage', OWNER_ROOM_KEY, JSON.stringify(next));
    setError('');
    history.replaceState(null, '', location.pathname);
    setSession(next);
    setMode('connecting');
    void acquireMicrophone();
  }

  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    void unlockInterfaceSounds();
    const entry = parseRoomEntry(joinValue);
    if (!entry) {
      setError('Cole um código ou link de sala válido.');
      return;
    }
    setError('');
    let nextSession: Session;
    if (entry.kind === 'invite') {
      history.replaceState(null, '', `${location.pathname}#${new URLSearchParams({ room: entry.invite.roomId, key: entry.invite.token })}`);
      nextSession = { invite: entry.invite };
    } else {
      history.replaceState(null, '', location.pathname);
      nextSession = { invite: { roomId: entry.code, token: '' }, joinCode: entry.code, joinByCode: true };
    }
    mediaRequestEpochRef.current += 1;
    sessionRef.current = nextSession;
    setSession(nextSession);
    setMode('connecting');
    void acquireMicrophone();
  }

  function exitRoom(closeRequested: boolean) {
    mediaRequestEpochRef.current += 1;
    microphoneRequestIdRef.current += 1;
    screenShareRequestIdRef.current += 1;
    microphonePendingRef.current = false;
    setMicrophonePending(false);
    screenSharePendingRef.current = false;
    setScreenSharePending(false);
    endingCallRef.current = true;
    if (callSoundConnectedRef.current) playSound('callDisconnected');
    callSoundConnectedRef.current = false;
    const connectedCount = Object.values(participantsRef.current).filter(participant => participant.connected).length;
    const closeForEveryone = closeRequested || (Boolean(sessionRef.current?.ownerKey) && connectedCount <= 1);
    const activeRoomId = sessionRef.current?.invite.roomId;
    send(socketRef.current, { type: closeForEveryone ? 'close-group-room' : 'leave-group-room' });
    if (closeForEveryone) removeStorage('localStorage', OWNER_ROOM_KEY);
    if (closeForEveryone && activeRoomId) removeStorage('sessionStorage', `${CHAT_OWN_IDS_PREFIX}${activeRoomId}`);
    socketRef.current?.close(1000, closeForEveryone ? 'Room closed' : 'Participant left');
    for (const peerId of [...peersRef.current.keys()]) destroyPeer(peerId);
    stopScreenShare();
    disposeMicrophonePipeline();
    setMicrophoneEnabled(false);
    verifiedVoiceSettingsRef.current = {};
    setVerifiedVoiceSettings({});
    setVoiceSettingFeedback('');
    participantsRef.current = {};
    setParticipants({});
    screenVolumesRef.current = {};
    setScreenVolumes({});
    participantVolumesRef.current = {};
    setParticipantVolumes({});
    setSelfId('');
    selfIdRef.current = '';
    setLeaderId('');
    pendingChatMessagesRef.current.clear();
    seenMessageIdsRef.current.clear();
    ownChatMessageIdsRef.current.clear();
    chatMessagesRef.current = [];
    setChatMessages([]);
    setChatValue('');
    setUnreadMessages(0);
    setNewMessagesBelow(0);
    chatStickToBottomRef.current = true;
    sessionRef.current = null;
    setSession(null);
    setMode('landing');
    setLeaveMenuOpen(false);
    setControlsOpen(false);
    setQrOpen(false);
    history.replaceState(null, '', location.pathname);
    window.setTimeout(() => { endingCallRef.current = false; }, 400);
  }

  function leaveRoom() {
    exitRoom(false);
  }

  function closeRoom() {
    exitRoom(true);
  }

  async function changeInputDevice(deviceId: string) {
    const next = { ...audioSettingsRef.current, inputDeviceId: deviceId };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    if (localMicrophoneTrackRef.current?.readyState === 'live') await acquireMicrophone(true);
  }

  function changeOutputDevice(deviceId: string) {
    const next = { ...audioSettingsRef.current, outputDeviceId: deviceId };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    void setInterfaceSoundOutputDevice(deviceId);
    for (const peer of peersRef.current.values()) {
      for (const audioElement of [peer.callAudio, peer.screenAudio]) {
        if (!audioElement) continue;
        const sinkable = audioElement as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
        if (sinkable.setSinkId) void sinkable.setSinkId(deviceId).catch(() => undefined);
      }
    }
  }

  function changeInputVolume(value: number) {
    const next = { ...audioSettingsRef.current, inputVolume: value };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    if (microphoneGainRef.current && audioContextRef.current) microphoneGainRef.current.gain.setTargetAtTime(value / 100, audioContextRef.current.currentTime, .015);
  }

  function changeOutputVolume(value: number) {
    const next = { ...audioSettingsRef.current, outputVolume: value };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    for (const peer of peersRef.current.values()) {
      if (peer.callAudio) peer.callAudio.volume = (value / 100) * ((participantVolumesRef.current[peer.id] ?? 100) / 100);
      if (peer.screenAudio) peer.screenAudio.volume = (value / 100) * ((screenVolumesRef.current[peer.id] ?? 100) / 100);
    }
  }

  function changeParticipantVolume(peerId: string, value: number) {
    const next = { ...participantVolumesRef.current, [peerId]: value };
    participantVolumesRef.current = next;
    setParticipantVolumes(next);
    const callAudio = peersRef.current.get(peerId)?.callAudio;
    if (callAudio) callAudio.volume = (audioSettingsRef.current.outputVolume / 100) * (value / 100);
  }

  function changeScreenVolume(peerId: string, value: number) {
    const next = { ...screenVolumesRef.current, [peerId]: value };
    screenVolumesRef.current = next;
    setScreenVolumes(next);
    const screenAudio = peersRef.current.get(peerId)?.screenAudio;
    if (screenAudio) screenAudio.volume = (audioSettingsRef.current.outputVolume / 100) * (value / 100);
  }

  function changeAdaptiveBitrate(enabled: boolean) {
    adaptiveBitrateRef.current = enabled;
    setAdaptiveBitrate(enabled);
    const nextResolution = automaticQualityRef.current ? 720 : resolutionRef.current;
    const nextFps = automaticQualityRef.current ? 30 : fpsRef.current;
    void applyScreenEncoding(nextResolution, nextFps, enabled, bitrateMbpsRef.current);
  }

  function changeBitrate(value: number) {
    bitrateMbpsRef.current = value;
    setBitrateMbps(value);
    if (adaptiveBitrateRef.current) return;
    const nextResolution = automaticQualityRef.current ? 720 : resolutionRef.current;
    const nextFps = automaticQualityRef.current ? 30 : fpsRef.current;
    void applyScreenEncoding(nextResolution, nextFps, false, value);
  }

  async function changeVoiceSetting(key: VoiceSettingKey) {
    const details = VOICE_SETTING_DETAILS[key];
    if (!voiceSettingSupport[key]) {
      setVoiceSettingFeedback(`${details.label} está fixado pelo dispositivo ou pelo navegador.`);
      return;
    }

    const previous = audioSettingsRef.current;
    const next = { ...previous, [key]: !previous[key] };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    const sourceTrack = microphoneSourceStreamRef.current?.getAudioTracks()[0];
    if (!sourceTrack || sourceTrack.readyState !== 'live') {
      setVoiceSettingFeedback(`${details.label} será ${next[key] ? 'ativado' : 'desativado'} ao ligar o microfone.`);
      return;
    }

    setVoiceSettingPending(key);
    try {
      let appliedWithoutRestart = false;
      try {
        await sourceTrack.applyConstraints(voiceProcessingConstraints(next, voiceSettingSupport, key));
        const verified = readVoiceTrackSettings(sourceTrack);
        if (verified[key] === next[key]) {
          const effective = { ...next };
          for (const settingKey of VOICE_SETTING_KEYS) {
            if (typeof verified[settingKey] === 'boolean') effective[settingKey] = verified[settingKey];
          }
          verifiedVoiceSettingsRef.current = verified;
          setVerifiedVoiceSettings(verified);
          audioSettingsRef.current = effective;
          setAudioSettings(effective);
          appliedWithoutRestart = true;
        }
      } catch {
        // Alguns drivers só aplicam processamento ao abrir uma nova captura.
      }

      if (appliedWithoutRestart) {
        setVoiceSettingFeedback(`${details.label} ${next[key] ? 'ativado' : 'desativado'} e confirmado no áudio enviado.`);
        return;
      }

      const reopened = await acquireMicrophone(true, key);
      const reopenedVerification = verifiedVoiceSettingsRef.current[key];
      if (reopened && reopenedVerification === next[key]) {
        setVoiceSettingFeedback(`${details.label} ${next[key] ? 'ativado' : 'desativado'} e confirmado após reiniciar a captura.`);
        return;
      }
      if (reopened && typeof reopenedVerification !== 'boolean') {
        setVoiceSettingFeedback(`O navegador aceitou ${details.label.toLowerCase()}, mas este driver não expõe a confirmação.`);
        return;
      }

      const activeSource = microphoneSourceStreamRef.current?.getAudioTracks()[0] ?? sourceTrack;
      const verified = readVoiceTrackSettings(activeSource);
      verifiedVoiceSettingsRef.current = verified;
      setVerifiedVoiceSettings(verified);
      const restored = { ...next };
      for (const settingKey of VOICE_SETTING_KEYS) {
        restored[settingKey] = typeof verified[settingKey] === 'boolean' ? verified[settingKey] : previous[settingKey];
      }
      audioSettingsRef.current = restored;
      setAudioSettings(restored);
      setVoiceSettingSupport(current => ({ ...current, [key]: false }));
      setVoiceSettingFeedback(`${details.label} é fixado pelo driver ou navegador neste dispositivo.`);
    } finally {
      setVoiceSettingPending(current => current === key ? null : current);
    }
  }

  function togglePlayback() {
    const next = !playbackEnabledRef.current;
    playbackEnabledRef.current = next;
    setPlaybackEnabled(next);
    if (audioContextRef.current?.state === 'suspended') void audioContextRef.current.resume();
    for (const peer of peersRef.current.values()) {
      for (const audioElement of [peer.callAudio, peer.screenAudio]) {
        if (!audioElement) continue;
        audioElement.muted = !next;
        if (next) void audioElement.play().catch(markPlaybackBlocked);
      }
    }
    playSound(next ? 'outputEnabled' : 'outputMuted');
  }

  function toggleInterfaceSounds() {
    const next = !interfaceSoundsEnabledRef.current;
    if (!next) void playCallSound('outputMuted', audioSettingsRef.current.outputVolume / 100);
    interfaceSoundsEnabledRef.current = next;
    setInterfaceSoundsEnabled(next);
    setInterfaceSoundFeedback(next ? 'Sons ativados neste dispositivo.' : 'Sons desativados neste dispositivo.');
    if (next) {
      playSound('outputEnabled');
    }
  }

  async function testInterfaceSound() {
    if (!interfaceSoundsEnabledRef.current) {
      interfaceSoundsEnabledRef.current = true;
      setInterfaceSoundsEnabled(true);
    }
    const played = await playCallSound('participantJoined', audioSettingsRef.current.outputVolume / 100);
    setInterfaceSoundFeedback(played
      ? audioSettingsRef.current.outputVolume > 0
        ? 'Som de teste reproduzido na saída selecionada.'
        : 'O som foi reproduzido, mas o volume de saída está em 0%.'
      : 'Não foi possível iniciar a saída de áudio. Confira o volume do sistema e tente novamente.');
  }

  const releaseWakeLock = useCallback(async () => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    setWakeLockActive(false);
    if (lock && !lock.released) await lock.release().catch(() => undefined);
  }, []);

  const requestWakeLock = useCallback(async () => {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<ScreenWakeLock> } }).wakeLock;
    if (!wakeLock || document.visibilityState !== 'visible') return false;
    if (wakeLockRef.current && !wakeLockRef.current.released) {
      setWakeLockActive(true);
      return true;
    }
    try {
      const lock = await wakeLock.request('screen');
      wakeLockRef.current = lock;
      setWakeLockActive(true);
      lock.addEventListener('release', () => {
        if (wakeLockRef.current === lock) wakeLockRef.current = null;
        setWakeLockActive(false);
      }, { once: true });
      return true;
    } catch {
      setWakeLockActive(false);
      return false;
    }
  }, []);

  useEffect(() => {
    writeStorage('localStorage', 'screenlink-keep-awake-v1', String(keepAwake));
    if (!keepAwake || mode !== 'connected') {
      void releaseWakeLock();
      return;
    }
    void requestWakeLock();
    const resume = () => { if (document.visibilityState === 'visible') void requestWakeLock(); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [keepAwake, mode, releaseWakeLock, requestWakeLock]);

  useEffect(() => () => { void releaseWakeLock(); }, [releaseWakeLock]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen();
    } catch {
      setError('A tela cheia não está disponível neste navegador.');
    }
    setMoreMenuOpen(false);
  }

  async function togglePictureInPicture() {
    const pictureDocument = document as Document & { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
    const video = stageRef.current?.querySelector('video') as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    try {
      if (pictureDocument.pictureInPictureElement && pictureDocument.exitPictureInPicture) await pictureDocument.exitPictureInPicture();
      else if (pictureDocument.pictureInPictureEnabled && video?.requestPictureInPicture) await video.requestPictureInPicture();
      else setError('O miniplayer só fica disponível quando uma tela está sendo exibida em um navegador compatível.');
    } catch {
      setError('Não foi possível abrir o miniplayer agora.');
    }
    setMoreMenuOpen(false);
  }

  function toggleKeepAwake() {
    const next = !keepAwake;
    setKeepAwake(next);
    if (next) void requestWakeLock();
    else void releaseWakeLock();
  }

  function sendChat(event: FormEvent) {
    event.preventDefault();
    const text = normalizeChatText(chatValue);
    if (!text || !selfIdRef.current || mode === 'error') return;
    const recipients = Object.values(participantsRef.current)
      .filter(participant => participant.connected && participant.id !== selfIdRef.current)
      .map(participant => participant.id);
    const message: ChatMessage = {
      id: `${selfIdRef.current}-${Date.now()}-${randomSecret(4)}`,
      senderId: selfIdRef.current,
      senderName: profileRef.current.name,
      text,
      sentAt: Date.now(),
      delivery: recipients.length ? 'pending' : 'sent'
    };
    chatStickToBottomRef.current = true;
    rememberOwnChatMessage(message.id);
    appendMessage(message);
    if (recipients.length) {
      const now = Date.now();
      pendingChatMessagesRef.current.set(message.id, {
        message,
        awaiting: new Set(recipients),
        attempts: 0,
        firstAttemptAt: now,
        lastAttemptAt: 0,
        fallbackAccepted: false
      });
      transmitPendingChat(message.id, true);
    }
    setChatValue('');
    setEmojiOpen(false);
    window.requestAnimationFrame(() => resizeChatInput(chatInputRef.current));
  }

  function retryChatMessage(messageId: string) {
    const message = chatMessagesRef.current.find(item => item.id === messageId && isOwnChatMessage(item));
    if (!message || mode === 'error') return;
    const recipients = Object.values(participantsRef.current)
      .filter(participant => participant.connected && participant.id !== selfIdRef.current)
      .map(participant => participant.id);
    if (!recipients.length) {
      updateChatDelivery(messageId, 'sent');
      return;
    }
    const now = Date.now();
    pendingChatMessagesRef.current.set(messageId, {
      message: { ...message, delivery: 'pending' },
      awaiting: new Set(recipients),
      attempts: 0,
      firstAttemptAt: now,
      lastAttemptAt: 0,
      fallbackAccepted: false
    });
    updateChatDelivery(messageId, 'pending');
    transmitPendingChat(messageId, true);
  }

  function insertEmoji(emoji: string) {
    const input = chatInputRef.current;
    const start = input?.selectionStart ?? chatValue.length;
    const end = input?.selectionEnd ?? start;
    const next = `${chatValue.slice(0, start)}${emoji}${chatValue.slice(end)}`.slice(0, 1_000);
    setChatValue(next);
    setEmojiOpen(false);
    window.requestAnimationFrame(() => {
      input?.focus();
      const cursor = Math.min(start + emoji.length, next.length);
      input?.setSelectionRange(cursor, cursor);
      resizeChatInput(input ?? null);
    });
  }

  function toggleChatSidebar() {
    if (chatOpen) setProfileOpen(false);
    setAudioMenuOpen(false);
    setScreenMenuOpen(false);
    setMoreMenuOpen(false);
    setLeaveMenuOpen(false);
    setControlsOpen(false);
    setEmojiOpen(false);
    setChatSettingsOpen(false);
    if (!chatOpen) chatStickToBottomRef.current = true;
    setChatOpen(!chatOpen);
  }

  async function copyValue(kind: 'code' | 'link') {
    if (!session) return;
    if (kind === 'code' && !session.joinCode) {
      setError('O código curto ainda está sendo gerado. Aguarde a sala conectar.');
      return;
    }
    const value = kind === 'code' ? session.joinCode! : groupInviteUrl(session.invite, shareOrigin);
    let copiedSuccessfully = false;
    try {
      await navigator.clipboard.writeText(value);
      copiedSuccessfully = true;
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = value;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.append(fallback);
      fallback.select();
      copiedSuccessfully = document.execCommand('copy');
      fallback.remove();
    }
    if (!copiedSuccessfully) {
      setError('Não foi possível copiar automaticamente. Selecione o link e copie manualmente.');
      return;
    }
    setCopied(kind);
    window.setTimeout(() => setCopied(''), 1_500);
  }

  const participantList = Object.values(participants).sort((left, right) => left.joinedAt - right.joinedAt);
  const connectedParticipants = participantList.filter(participant => participant.connected);
  const remoteParticipants = connectedParticipants.filter(participant => participant.id !== selfId);
  const sharingParticipants = connectedParticipants.filter(participant => participant.sharing);
  const remoteSharingParticipants = sharingParticipants.filter(participant => participant.id !== selfId);
  const localScreen = localScreenStreamRef.current;
  const isOwner = Boolean(session?.ownerKey);
  const roomLabel = session ? (session.joinCode?.toUpperCase() || '••••••') : '';
  const remoteParticipantCount = remoteParticipants.length;
  const connectedPeerCount = [...peersRef.current.values()].filter(peer => peer.pc.connectionState === 'connected').length;
  const connectionQuality = mode !== 'connected' || !connectedPeerCount || mediaLatency === null
    ? 'waiting'
    : mediaLatency > 450 ? 'blocked' : mediaLatency > 180 ? 'limited' : mediaLatency > 90 ? 'good' : 'excellent';
  const latencyLabel = mediaLatency === null ? '—' : String(mediaLatency);
  const connectionStatusLabel = mode !== 'connected'
    ? 'Conectando'
    : connectedPeerCount
      ? mediaLatency === null ? 'P2P' : `${latencyLabel} ms`
      : remoteParticipantCount ? 'Conectando P2P' : 'P2P';
  const activeChat = chatOpen;
  const activeResolution = automaticQuality ? 720 : resolution;
  const activeFps = automaticQuality ? 30 : fps;
  const effectiveBitrateMbps = adaptiveBitrate ? recommendedBitrateMbps(activeResolution, activeFps) : bitrateMbps;
  const screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const chatCanSend = Boolean(session && selfId && mode !== 'error');
  const chatPlaceholder = !session
    ? 'Entre em uma chamada para conversar'
    : mode === 'error'
      ? 'Chat indisponível nesta sala'
      : !selfId
        ? 'Conectando ao chat…'
        : mode === 'connecting'
          ? 'Reconectando — as mensagens ficam na fila…'
          : 'Escrever mensagem…';
  void peerVersion;

  const closeDockSheets = useCallback(() => {
    setAudioMenuOpen(false);
    setScreenMenuOpen(false);
    setMoreMenuOpen(false);
    setLeaveMenuOpen(false);
  }, []);
  const closeProfileSheet = () => {
    commitProfileName();
    commitProfileStatus();
    setProfileOpen(false);
  };
  const dockSheetOpen = phone && (audioMenuOpen || screenMenuOpen || moreMenuOpen || leaveMenuOpen);
  const mobileOverlayKey = !phone
    ? ''
    : qrOpen
      ? 'qr'
      : profileOpen
        ? 'profile'
        : chatSettingsOpen
          ? 'chat-settings'
          : emojiOpen
            ? 'emoji'
            : dockSheetOpen
              ? 'dock'
              : controlsOpen
                ? 'controls'
                : activeChat
                  ? 'chat'
                  : '';
  const mobilePresentationOpen = phone && Boolean(mobileOverlayKey);
  const dockSheetGesture = useBottomSheetGesture(dockSheetOpen, closeDockSheets);
  const controlsSheetGesture = useBottomSheetGesture(phone && controlsOpen, () => setControlsOpen(false));
  const profileSheetGesture = useBottomSheetGesture(phone && profileOpen, closeProfileSheet);
  const chatSettingsSheetGesture = useBottomSheetGesture(phone && chatSettingsOpen, () => setChatSettingsOpen(false));
  const qrSheetGesture = useBottomSheetGesture(phone && qrOpen, () => setQrOpen(false));
  dismissMobileOverlayRef.current = () => {
    if (mobileOverlayKey === 'qr') setQrOpen(false);
    else if (mobileOverlayKey === 'profile') closeProfileSheet();
    else if (mobileOverlayKey === 'chat-settings') setChatSettingsOpen(false);
    else if (mobileOverlayKey === 'emoji') setEmojiOpen(false);
    else if (mobileOverlayKey === 'dock') closeDockSheets();
    else if (mobileOverlayKey === 'controls') setControlsOpen(false);
    else if (mobileOverlayKey === 'chat') {
      setChatOpen(false);
      setProfileOpen(false);
      setChatSettingsOpen(false);
      setEmojiOpen(false);
    }
  };

  useEffect(() => {
    if (!phone) return;
    const handlePlatformBack = () => {
      if (!mobileOverlayHistoryActiveRef.current) return;
      mobileOverlayHistoryActiveRef.current = false;
      dismissMobileOverlayRef.current();
    };
    window.addEventListener('popstate', handlePlatformBack);
    return () => window.removeEventListener('popstate', handlePlatformBack);
  }, [phone]);

  useEffect(() => {
    const historyState = window.history.state;
    const currentMarker = historyState && typeof historyState === 'object'
      ? historyState.__screenlinkMobileOverlay
      : undefined;
    if (!phone) {
      if (mobileOverlayHistoryActiveRef.current) {
        mobileOverlayHistoryActiveRef.current = false;
        if (currentMarker === mobileOverlayMarker) window.history.back();
      }
      return;
    }
    if (mobileOverlayKey && !mobileOverlayHistoryActiveRef.current) {
      const baseState = historyState && typeof historyState === 'object' ? historyState : {};
      window.history.pushState({ ...baseState, __screenlinkMobileOverlay: mobileOverlayMarker }, '', window.location.href);
      mobileOverlayHistoryActiveRef.current = true;
      return;
    }
    if (!mobileOverlayKey && mobileOverlayHistoryActiveRef.current) {
      mobileOverlayHistoryActiveRef.current = false;
      if (currentMarker === mobileOverlayMarker) window.history.back();
    }
  }, [mobileOverlayKey, mobileOverlayMarker, phone]);

  const chatPanel = (
    <div className="chat-panel unified-chat-panel" style={{ '--chat-own-bubble': chatAppearance.ownBubble, '--chat-other-bubble': chatAppearance.otherBubble, '--chat-name-color': chatAppearance.nameColor } as React.CSSProperties}>
      <div className="chat-log" ref={chatLogRef} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Mensagens da chamada" tabIndex={0} onScroll={event => {
        const log = event.currentTarget;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= 48;
        chatStickToBottomRef.current = atBottom;
        if (atBottom) setNewMessagesBelow(0);
      }}>
        {chatMessages.length ? chatMessages.map(message => {
          if (message.system) return <p className="chat-system" key={message.id}>{message.text}</p>;
          const own = isOwnChatMessage(message);
          return (
            <article className={`chat-message ${own ? 'is-own' : ''}`} key={message.id}>
              <header><strong>{own ? 'Você' : message.senderName}</strong><time dateTime={new Date(message.sentAt).toISOString()}>{new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time></header>
              <p>{renderChatText(message.text)}</p>
              {own && message.delivery && <div className={`chat-delivery is-${message.delivery}`} aria-live="polite">
                {message.delivery === 'failed'
                  ? <button type="button" onClick={() => retryChatMessage(message.id)}>Falhou · reenviar</button>
                  : <span>{message.delivery === 'pending' ? 'Enviando…' : message.delivery === 'delivered' ? 'Entregue' : 'Enviada'}</span>}
              </div>}
            </article>
          );
        }) : <div className="chat-empty"><Icon name="chat"/><strong>A conversa começa aqui</strong><span>As mensagens são temporárias e ficam somente nesta chamada.</span></div>}
      </div>
      {newMessagesBelow > 0 && <button className="chat-jump-latest" type="button" onClick={() => scrollChatToLatest(true)}>{newMessagesBelow === 1 ? 'Nova mensagem' : `${newMessagesBelow} novas mensagens`} <span aria-hidden="true">↓</span></button>}
      <form className="chat-composer" onSubmit={sendChat}>
        <div className="emoji-picker-anchor" ref={emojiPickerRef}>
          <button className={emojiOpen ? 'is-open' : ''} type="button" onClick={() => setEmojiOpen(open => !open)} disabled={!chatCanSend} aria-expanded={emojiOpen} aria-label="Escolher emoji"><Icon name="smile"/></button>
          {emojiOpen && <div className="emoji-picker" role="listbox" aria-label="Emojis">{CHAT_EMOJIS.map(emoji => <button key={emoji} type="button" role="option" aria-label={`Emoji ${emoji}`} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}</div>}
        </div>
        <textarea ref={chatInputRef} aria-label="Escrever mensagem" title="Enter envia · Shift+Enter quebra a linha" rows={1} value={chatValue} onChange={event => { setChatValue(event.target.value); resizeChatInput(event.currentTarget); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={chatPlaceholder} maxLength={1000} disabled={!chatCanSend}/>
        <button type="submit" disabled={!normalizeChatText(chatValue) || !chatCanSend} aria-label="Enviar mensagem"><Icon name="send"/></button>
      </form>
    </div>
  );

  const audioPopover = audioMenuOpen ? (
    <section className="dock-popover audio-popover unified-audio-popover" role={phone ? 'dialog' : undefined} aria-modal={phone || undefined} aria-labelledby="audio-sheet-title" {...dockSheetGesture}>
      <header><strong id="audio-sheet-title">Áudio</strong><small>DISPOSITIVOS E VOZ</small><button className="mobile-sheet-close" type="button" onClick={() => setAudioMenuOpen(false)} aria-label="Fechar configurações de áudio"><Icon name="close"/></button></header>
      <div className="room-device-stack">
        <RoomDevicePicker input label="Dispositivo de entrada" value={audioSettings.inputDeviceId} devices={audioDevices} onChange={deviceId => void changeInputDevice(deviceId)}/>
        <RoomDevicePicker label="Dispositivo de saída" value={audioSettings.outputDeviceId} devices={audioDevices} onChange={changeOutputDevice}/>
      </div>
      <div className="audio-popover-scroll">
        <section className="audio-menu-section">
          <header><strong>Volumes</strong><small>LOCAL</small></header>
          <div className="volume-control"><label htmlFor="room-input-volume"><strong>Volume de entrada</strong><small>Ganho do seu microfone</small></label><input id="room-input-volume" type="range" min="0" max="150" value={audioSettings.inputVolume} onChange={event => changeInputVolume(Number(event.target.value))}/><output>{audioSettings.inputVolume}%</output></div>
          <div className="volume-control"><label htmlFor="room-output-volume"><strong>Volume de saída</strong><small>Áudio recebido da chamada</small></label><input id="room-output-volume" type="range" min="0" max="100" value={audioSettings.outputVolume} onChange={event => changeOutputVolume(Number(event.target.value))}/><output>{audioSettings.outputVolume}%</output></div>
          <div className="interface-sound-controls">
            <button className="voice-setting interface-sound-setting" type="button" role="switch" aria-checked={interfaceSoundsEnabled} onClick={toggleInterfaceSounds}><span><strong>Sons da interface</strong><small>Chamada, microfone e participantes</small></span><i><b/></i></button>
            <button className="interface-sound-test" type="button" onClick={() => void testInterfaceSound()}>Testar</button>
          </div>
          {interfaceSoundFeedback && <p className="interface-sound-feedback" role="status">{interfaceSoundFeedback}</p>}
        </section>
        <section className="audio-menu-section participant-volume-section">
          <header><strong>Voz dos participantes</strong><small>{remoteParticipants.length ? `${remoteParticipants.length} PESSOA${remoteParticipants.length === 1 ? '' : 'S'}` : 'SÓ VOCÊ'}</small></header>
          {remoteParticipants.length ? <div className="screen-volume-list participant-volume-list">{remoteParticipants.map(participant => (
            <div className="screen-volume-row participant-volume-row" key={participant.id}>
              <Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} size="small"/>
              <label htmlFor={`participant-volume-${participant.id}`}><strong>{participant.name}</strong><small>{participant.microphoneEnabled ? 'Microfone ativo' : 'Microfone silenciado'}</small></label>
              <input id={`participant-volume-${participant.id}`} aria-label={`Volume de voz de ${participant.name}`} type="range" min="0" max="100" value={participantVolumes[participant.id] ?? 100} onChange={event => changeParticipantVolume(participant.id, Number(event.target.value))}/>
              <output>{participantVolumes[participant.id] ?? 100}%</output>
            </div>
          ))}</div> : <p className="screen-audio-empty"><Icon name="volumeOff"/>Os controles aparecem quando outra pessoa entrar.</p>}
        </section>
        <section className="audio-menu-section">
          <header><strong>Tratamento de voz</strong><small>MICROFONE</small></header>
          <div className="voice-settings">
            {VOICE_SETTING_KEYS.map(key => {
              const details = VOICE_SETTING_DETAILS[key];
              const unsupported = !voiceSettingSupport[key];
              const applying = voiceSettingPending === key;
              const verified = verifiedVoiceSettings[key];
              const status = unsupported
                ? 'Fixado pelo dispositivo ou navegador'
                : applying
                  ? 'Aplicando ao microfone…'
                  : microphoneEnabled && typeof verified === 'boolean'
                    ? `${verified ? 'Ativo' : 'Desativado'} no áudio enviado`
                    : microphoneEnabled
                      ? `${audioSettings[key] ? 'Ativado' : 'Desativado'} na captura · sem confirmação do driver`
                      : details.description;
              return <button key={key} className={`voice-setting ${applying ? 'is-applying' : ''}`} type="button" role="switch" aria-checked={audioSettings[key]} aria-busy={applying} disabled={unsupported || voiceSettingPending !== null} onClick={() => void changeVoiceSetting(key)}><span><strong>{details.label}</strong><small>{status}</small></span><i><b/></i></button>;
            })}
          </div>
          {voiceSettingFeedback && <p className="voice-processing-feedback" role="status">{voiceSettingFeedback}</p>}
        </section>
      </div>
    </section>
  ) : null;

  const screenPopover = screenMenuOpen ? (
    <section className="dock-popover more-popover screen-popover unified-screen-popover" role={phone ? 'dialog' : undefined} aria-modal={phone || undefined} aria-labelledby="screen-sheet-title" {...dockSheetGesture}>
      <header><strong id="screen-sheet-title">Compartilhamento</strong><small>{sharing ? 'ATIVO' : 'PRONTO'}</small><button className="mobile-sheet-close" type="button" onClick={() => setScreenMenuOpen(false)} aria-label="Fechar configurações do compartilhamento"><Icon name="close"/></button></header>
      <button type="button" onClick={() => { void toggleScreenShare(); setScreenMenuOpen(false); }} disabled={screenSharePending || (!sharing && !screenShareSupported)}><Icon name="screen"/><span><strong>{screenSharePending ? 'Abrindo seletor…' : sharing ? 'Parar compartilhamento' : 'Compartilhar tela'}</strong><small>{sharing ? 'A chamada continuará ativa' : screenShareSupported ? 'Escolha uma tela, janela ou aba' : 'Não disponível neste navegador'}</small></span></button>
      <div className="screen-popover-scroll">
        <section className="screen-menu-section">
          <header><strong>Áudio recebido</strong><small>{remoteSharingParticipants.length ? `${remoteSharingParticipants.length} TELA${remoteSharingParticipants.length === 1 ? '' : 'S'}` : 'SEM TELAS'}</small></header>
          {remoteSharingParticipants.length ? <div className="screen-volume-list">{remoteSharingParticipants.map(participant => (
            <div className="screen-volume-row" key={participant.id}>
              <Avatar avatar={participant.avatar} name={participant.name} size="small"/>
              <label htmlFor={`screen-volume-${participant.id}`}><strong>{participant.name}</strong><small>Som do compartilhamento</small></label>
              <input id={`screen-volume-${participant.id}`} aria-label={`Volume da tela de ${participant.name}`} type="range" min="0" max="100" value={screenVolumes[participant.id] ?? 100} onChange={event => changeScreenVolume(participant.id, Number(event.target.value))}/>
              <output>{screenVolumes[participant.id] ?? 100}%</output>
            </div>
          ))}</div> : <p className="screen-audio-empty"><Icon name="volumeOff"/>Os controles aparecem quando alguém compartilhar uma tela.</p>}
        </section>
        {screenShareSupported && <section className="screen-menu-section bitrate-menu-section">
          <header><strong>Bitrate de envio</strong><small>ATÉ {formatBitrate(effectiveBitrateMbps)}</small></header>
          <button className={`compact-toggle ${adaptiveBitrate ? 'is-active' : ''}`} type="button" role="switch" aria-checked={adaptiveBitrate} onClick={() => changeAdaptiveBitrate(!adaptiveBitrate)}><span><strong>Bitrate adaptativo</strong><small>Ajusta o limite ao perfil de vídeo</small></span><i><b/></i></button>
          <div className={`bitrate-control ${adaptiveBitrate ? 'is-disabled' : ''}`}><label htmlFor="popover-bitrate"><strong>Limite manual</strong><small>0,5 a 20 Mb/s</small></label><input id="popover-bitrate" aria-label="Bitrate manual do compartilhamento" type="range" min={MIN_BITRATE_MBPS} max={MAX_BITRATE_MBPS} step="0.5" value={bitrateMbps} disabled={adaptiveBitrate} onChange={event => changeBitrate(Number(event.target.value))}/><output>{formatBitrate(bitrateMbps)}</output></div>
        </section>}
      </div>
    </section>
  ) : null;

  const morePopover = moreMenuOpen ? (
    <section className="dock-popover more-popover viewing-popover" role={phone ? 'dialog' : undefined} aria-modal={phone || undefined} aria-labelledby="more-sheet-title" {...dockSheetGesture}>
      <header><strong id="more-sheet-title">Mais opções</strong><small>ESTE DISPOSITIVO</small><button className="mobile-sheet-close" type="button" onClick={() => setMoreMenuOpen(false)} aria-label="Fechar mais opções"><Icon name="close"/></button></header>
      {mobile && <button type="button" onClick={() => { setMoreMenuOpen(false); setScreenMenuOpen(true); }}><Icon name="screen"/><span><strong>Compartilhamentos</strong><small>{remoteSharingParticipants.length ? `Ajustar áudio de ${remoteSharingParticipants.length} tela${remoteSharingParticipants.length === 1 ? '' : 's'}` : screenShareSupported ? 'Tela, áudio e bitrate' : 'Áudio das telas recebidas'}</small></span><Icon name="chevron"/></button>}
      <button type="button" onClick={() => void toggleFullscreen()}><Icon name="expand"/><span><strong>{document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia'}</strong><small>Amplia a área compartilhada</small></span></button>
      <button type="button" onClick={() => void togglePictureInPicture()} disabled={!sharingParticipants.length}><Icon name="pip"/><span><strong>Miniplayer</strong><small>{sharingParticipants.length ? 'Mantém uma tela sobre as outras janelas' : 'Disponível quando alguém compartilhar'}</small></span></button>
      <button className={keepAwake ? 'is-selected' : ''} type="button" onClick={toggleKeepAwake} disabled={!('wakeLock' in navigator)}><Icon name="wake"/><span><strong>Manter tela ativa</strong><small>{'wakeLock' in navigator ? 'Evita que este dispositivo adormeça na chamada' : 'Não disponível neste navegador'}</small></span><i>{keepAwake ? wakeLockActive ? 'ATIVO' : 'AGUARDANDO' : 'DESLIGADO'}</i></button>
    </section>
  ) : null;

  const exitPopover = leaveMenuOpen ? (
    <section className="dock-popover audio-popover exit-popover" role={phone ? 'dialog' : undefined} aria-modal={phone || undefined} aria-labelledby="exit-sheet-title" {...dockSheetGesture}>
      <header><strong id="exit-sheet-title">Sair da chamada</strong><small>AÇÕES DA SALA</small><button className="mobile-sheet-close" type="button" onClick={() => setLeaveMenuOpen(false)} aria-label="Fechar opções para sair"><Icon name="close"/></button></header>
      <div className="exit-options">
        <button type="button" onClick={leaveRoom}><Icon name="hangup"/><span><strong>Sair da chamada</strong><small>A sala continua para quem permanecer</small></span></button>
        {isOwner && <button className="is-danger" type="button" onClick={closeRoom}><Icon name="close"/><span><strong>Encerrar sala</strong><small>Desconecta todas as pessoas agora</small></span></button>}
      </div>
    </section>
  ) : null;

  const dockPopovers = <>{audioPopover}{screenPopover}{morePopover}{exitPopover}</>;

  const callPanel = (
    <div className="panel-page unified-call-page">
      {!session ? (
        <section className="panel-section unified-join-section">
          <div className="section-heading"><h3>Entrar em uma chamada</h3><small>CÓDIGO OU LINK</small></div>
          <form onSubmit={joinRoom} className="unified-join-form"><div><Icon name="link"/><input aria-label="Código ou link da chamada" value={joinValue} onChange={event => { setJoinValue(event.target.value); if (error) setError(''); }} placeholder="Cole o código da sala" autoComplete="off" autoCapitalize="characters" enterKeyHint="go" spellCheck={false} maxLength={512}/><button type="submit" disabled={!joinValue.trim()}>Entrar</button></div></form>
          {loadOwnerSession() && <button className="unified-resume" type="button" onClick={() => { setSession(loadOwnerSession()); setMode('connecting'); }}>Retomar sua última sala</button>}
        </section>
      ) : (
        <section className="panel-section unified-invite-section">
          <div className="section-heading"><h3>Convite da chamada</h3><small>SALA {roomLabel}</small></div>
          <button className="invite-code-display" type="button" onClick={() => void copyValue('code')} disabled={!session.joinCode} aria-label={session.joinCode ? 'Copiar código curto da sala' : 'Código curto sendo gerado'}><span>{copied === 'code' ? 'Código copiado' : session.joinCode ? 'Código curto' : 'Gerando código'}</span><strong>{roomLabel}</strong><Icon name="copy"/></button>
          <div className="invite-actions"><button type="button" onClick={() => void copyValue('link')}><Icon name="link"/>{copied === 'link' ? 'Link copiado' : 'Copiar link'}</button><button type="button" onClick={() => setQrOpen(true)} disabled={!qrCode}><Icon name="qr"/>QR Code</button></div>
        </section>
      )}
        {session && <section className="panel-section unified-participants-section">
          <div className="section-heading"><h3>Na chamada</h3><small>{connectedParticipants.length} CONECTADO{connectedParticipants.length === 1 ? '' : 'S'}</small></div>
          <div className="unified-participant-list">{connectedParticipants.map(participant => <div key={participant.id}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} size="small"/><span><strong>{participant.name}{participant.id === selfId ? ' · você' : ''}</strong><small>{participant.sharing ? 'Compartilhando tela' : participant.microphoneEnabled ? 'Microfone ativo' : participant.status}</small></span>{participant.id === leaderId && <Icon name="crown"/>}</div>)}</div>
        </section>}
        {session && mobile && !screenShareSupported && <section className="panel-section mobile-screen-capability" role="status"><Icon name="screen"/><span><strong>Compartilhamento pelo celular</strong><small>Este navegador pode assistir à chamada, mas não consegue enviar a tela.</small></span></section>}
        <section className="panel-section quality-section">
          <div className="section-heading"><h3>Qualidade do vídeo</h3><small>{automaticQuality ? 'AUTOMÁTICA' : 'MANUAL'}</small></div>
          <button className={`toggle-row ${automaticQuality ? 'is-active' : ''}`} type="button" role="switch" aria-checked={automaticQuality} onClick={() => changeAutomaticQuality(!automaticQuality)}><Icon name="settings"/><span className="toggle-row-copy"><strong>Resolução e fluidez automáticas</strong><small>{activeResolution}p · até {activeFps} FPS</small></span><span className="toggle-row-switch"><i/></span></button>
          <div className="quality-controls">
            <SegmentedSelector label="Resolução" suffix="resolução" options={RESOLUTIONS} value={resolution} disabled={automaticQuality} premium={1080} onChange={value => { automaticQualityRef.current = false; setAutomaticQuality(false); void applyVideoProfile(value, fpsRef.current); }}/>
            <SegmentedSelector label="Fluidez" suffix="FPS" options={FRAME_RATES} value={fps} disabled={automaticQuality} premium={60} onChange={value => { automaticQualityRef.current = false; setAutomaticQuality(false); void applyVideoProfile(resolutionRef.current, value); }}/>
            {!session && <SegmentedSelector label="Participantes" suffix="máximo" options={PARTICIPANT_LIMITS} value={maxParticipants} fullWidth onChange={setMaxParticipants}/>}
          </div>
          <div className="sidebar-bitrate-settings">
            <div className="subsection-heading"><strong>Transmissão</strong><small>ATÉ {formatBitrate(effectiveBitrateMbps)}</small></div>
            <button className={`toggle-row bitrate-toggle ${adaptiveBitrate ? 'is-active' : ''}`} type="button" role="switch" aria-checked={adaptiveBitrate} onClick={() => changeAdaptiveBitrate(!adaptiveBitrate)}><Icon name="link"/><span className="toggle-row-copy"><strong>Bitrate adaptativo</strong><small>O WebRTC reduz o envio quando a rede apertar</small></span><span className="toggle-row-switch"><i/></span></button>
            <div className={`bitrate-control sidebar-bitrate-control ${adaptiveBitrate ? 'is-disabled' : ''}`}><label htmlFor="sidebar-bitrate"><strong>Limite manual</strong><small>Disponível com o modo adaptativo desligado</small></label><input id="sidebar-bitrate" aria-label="Limite manual de bitrate" type="range" min={MIN_BITRATE_MBPS} max={MAX_BITRATE_MBPS} step="0.5" value={bitrateMbps} disabled={adaptiveBitrate} onChange={event => changeBitrate(Number(event.target.value))}/><output>{formatBitrate(bitrateMbps)}</output></div>
          </div>
        </section>
        <section className="panel-section interface-motion-section">
          <div className="section-heading"><h3>Interface</h3><small>ESTE DISPOSITIVO</small></div>
          <button className={`toggle-row ${animationsEnabled ? 'is-active' : ''}`} type="button" role="switch" aria-checked={animationsEnabled} onClick={() => setAnimationsEnabled(enabled => !enabled)}><Icon name="motion"/><span className="toggle-row-copy"><strong>Animações e movimento</strong><small>{animationsEnabled ? 'Fundo, mascote e transições suaves' : 'Efeitos visuais pausados'}</small></span><span className="toggle-row-switch"><i/></span></button>
        </section>
    </div>
  );

  const callDock = session && mode !== 'error' ? (
    <div className="host-call-dock unified-call-dock" ref={dockRef} aria-label="Controles da chamada">
      <button className={`dock-connection-indicator ${connectionQuality}`} type="button" aria-label={mediaLatency === null ? 'RTT P2P aguardando medição' : `RTT P2P ${mediaLatency} milissegundos`} data-label="Conexão P2P"><Icon name="link"/><span className="connection-tooltip"><strong>{latencyLabel} ms</strong><small>RTT WebRTC · {connectedPeerCount} par{connectedPeerCount === 1 ? '' : 'es'} · {turnAvailable ? 'TURN pronto' : 'STUN'}</small></span></button>
      <button className={playbackEnabled ? 'is-on' : ''} type="button" onClick={togglePlayback} aria-label={playbackEnabled ? 'Silenciar chamada' : 'Ouvir chamada'} data-label="Áudio"><Icon name={playbackEnabled ? 'volume' : 'volumeOff'}/></button>
      <div className="dock-split-control">
        <button className={microphoneEnabled ? 'is-on' : ''} type="button" onClick={() => void toggleMicrophone()} disabled={microphonePending} aria-busy={microphonePending} aria-label={microphonePending ? 'Abrindo microfone' : microphoneEnabled ? 'Silenciar microfone' : 'Ativar microfone'} data-label={microphonePending ? 'Abrindo…' : 'Microfone'}><Icon name={microphoneEnabled ? 'microphone' : 'microphoneOff'}/></button>
        <button className={`dock-chevron ${audioMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setAudioMenuOpen(open => !open); setScreenMenuOpen(false); setMoreMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={audioMenuOpen} aria-label="Configurações de áudio" data-label="Ajustes"><Icon name="chevronDown"/></button>
      </div>
      {(!mobile || screenShareSupported) && <div className="dock-split-control screen-split-control">
        <button className={`${sharing ? 'is-on' : ''} ${!sharing && !screenShareSupported ? 'is-unsupported' : ''}`} type="button" onClick={() => void toggleScreenShare()} disabled={screenSharePending || (!sharing && !screenShareSupported)} aria-label={screenSharePending ? 'Abrindo seletor de tela' : sharing ? 'Parar compartilhamento' : screenShareSupported ? 'Compartilhar tela' : 'Compartilhamento de tela indisponível neste navegador'} aria-pressed={sharing} aria-busy={screenSharePending} data-label={screenSharePending ? 'Abrindo…' : sharing ? 'Parar tela' : screenShareSupported ? 'Compartilhar' : 'Indisponível'} title={!sharing && !screenShareSupported ? 'Este navegador não permite compartilhar a tela' : undefined}><Icon name="screen"/></button>
        <button className={`dock-chevron ${screenMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setScreenMenuOpen(open => !open); setAudioMenuOpen(false); setMoreMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={screenMenuOpen} aria-label="Configurações da tela" data-label="Ajustes"><Icon name="chevronDown"/></button>
      </div>}
      <button className={`dock-chat-button ${activeChat ? 'is-on' : ''}`} type="button" onClick={toggleChatSidebar} aria-label={activeChat ? 'Fechar chat' : unreadMessages ? `Abrir chat, ${unreadMessages} mensagem${unreadMessages === 1 ? '' : 's'} não lida${unreadMessages === 1 ? '' : 's'}` : 'Abrir chat'} data-label="Chat"><Icon name="chat"/>{unreadMessages > 0 && <span className="chat-unread-badge" aria-hidden="true">{unreadMessages === 99 ? '99+' : unreadMessages}</span>}</button>
      <button className={moreMenuOpen ? 'is-on' : ''} type="button" onClick={() => { setMoreMenuOpen(open => !open); setAudioMenuOpen(false); setScreenMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={moreMenuOpen} aria-label="Mais opções" data-label="Mais"><Icon name="more"/></button>
      {mobile && <button className={controlsOpen ? 'is-on mobile-controls-trigger' : 'mobile-controls-trigger'} type="button" onClick={() => { setControlsOpen(open => !open); setChatOpen(false); setProfileOpen(false); setAudioMenuOpen(false); setScreenMenuOpen(false); setMoreMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={controlsOpen} aria-label="Abrir controles" data-label="Controles"><Icon name="settings"/></button>}
      <span className="dock-divider"/>
      <button className="hangup" type="button" onClick={() => { setLeaveMenuOpen(open => !open); setAudioMenuOpen(false); setScreenMenuOpen(false); setMoreMenuOpen(false); }} aria-expanded={leaveMenuOpen} aria-label="Opções para sair da chamada" data-label="Sair"><Icon name="hangup"/></button>
      {!phone && dockPopovers}
    </div>
  ) : null;

  const stageContent = sharingParticipants.length ? (
    <div className={`unified-screens-grid count-${sharingParticipants.length}`}>
      {sharingParticipants.map(participant => {
        if (participant.id === selfId && localScreen) {
          return <ScreenTile key={participant.id} stream={localScreen} name={participant.name} local/>;
        }
        const stream = peersRef.current.get(participant.id)?.screenStream;
        return stream ? <ScreenTile key={participant.id} stream={stream} name={participant.name}/> : null;
      })}
    </div>
  ) : (
    <div className="stage-empty unified-stage-empty">
      {session && mode === 'connected' && connectedParticipants.length ? (
        <div className="stage-identities">{connectedParticipants.map(participant => <div className="stage-identity" key={participant.id}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} leader={participant.id === leaderId} size="large"/><strong>{participant.name}</strong><small>{participant.status}</small></div>)}</div>
      ) : <div className="stage-echo"><Avatar avatar="echo" name="Echo" size="large"/></div>}
      <h1>{!session ? 'Inicie uma chamada' : mode === 'connecting' ? 'Entrando na chamada' : mode === 'error' ? 'Sala indisponível' : 'Chamada em andamento'}</h1>
      {mode !== 'connected' && <p>{!session ? 'Crie uma sala ou entre com um código. Quem estiver no computador também pode compartilhar a própria tela.' : mode === 'connecting' ? 'Reconectando à sala sem interromper quem já está aqui…' : error}</p>}
      {!session && <div className="stage-entry-actions"><button className="primary-action" type="button" onClick={() => void createRoom()}><Icon name="users"/> Iniciar chamada</button>{mobile && <button className="secondary-action" type="button" onClick={() => { setControlsOpen(true); setChatOpen(false); }}><Icon name="link"/> Entrar com código</button>}</div>}
      {mode === 'error' && <button className="primary-action" type="button" onClick={leaveRoom}>Voltar</button>}
    </div>
  );

  return (
    <div className={`app room-app unified-room-app ${mobile ? 'viewer-mode is-mobile-room' : ''} ${phone ? 'is-phone-room' : ''} ${activeChat ? 'is-chat-open' : ''} ${controlsOpen ? 'is-controls-open' : ''} ${mobilePresentationOpen ? 'has-mobile-overlay' : ''} ${animationsEnabled ? '' : 'animations-disabled'}`}>
      <header className="topbar">
        <div className="brand"><BrandMark/><strong>ScreenLink</strong></div>
        <div className={`status-pill room-status-${connectionQuality}`}><i/>{session ? connectionStatusLabel : 'Pronto'}</div>
      </header>
      <main className="host-main unified-room-main">
          <aside className={`unified-chat-sidebar ${activeChat ? 'is-open' : 'is-closed'}`} aria-label="Chat da chamada" aria-hidden={!activeChat}>
            <header className="unified-sidebar-header">
              <div className="unified-sidebar-title"><Icon name="chat"/><span><strong>Chat</strong><small>{session ? `Sala ${roomLabel}` : 'LOCAL'}</small></span></div>
              <div className="unified-sidebar-actions">
                <div className="unified-chat-settings-anchor" ref={chatSettingsRef}>
                  <button className={`chat-settings-trigger ${chatSettingsOpen ? 'is-open' : ''}`} type="button" aria-label="Personalizar aparência do chat" aria-expanded={chatSettingsOpen} onClick={() => setChatSettingsOpen(open => !open)}><Icon name="settings"/></button>
                  {chatSettingsOpen && <section className="chat-settings-popover" aria-label="Aparência do chat" {...chatSettingsSheetGesture}>
                    <header><strong>Aparência do chat</strong><small>SÓ NESTE DISPOSITIVO</small></header>
                    <label><span><strong>Seu balão</strong><small>Destaque das suas mensagens</small></span><input type="color" value={chatAppearance.ownBubble} aria-label="Cor do seu balão" onChange={event => setChatAppearance(current => ({ ...current, ownBubble: event.currentTarget.value }))}/></label>
                    <label><span><strong>Outros balões</strong><small>Mensagens dos participantes</small></span><input type="color" value={chatAppearance.otherBubble} aria-label="Cor dos outros balões" onChange={event => setChatAppearance(current => ({ ...current, otherBubble: event.currentTarget.value }))}/></label>
                    <label><span><strong>Nomes</strong><small>Branco por padrão</small></span><input type="color" value={chatAppearance.nameColor} aria-label="Cor dos nomes" onChange={event => setChatAppearance(current => ({ ...current, nameColor: event.currentTarget.value }))}/></label>
                    <button className="chat-settings-reset" type="button" onClick={() => setChatAppearance(DEFAULT_CHAT_APPEARANCE)}>Restaurar padrão</button>
                  </section>}
                </div>
                {mobile && <button className="unified-sidebar-close" type="button" onClick={() => { setChatOpen(false); setProfileOpen(false); setChatSettingsOpen(false); }} aria-label="Fechar chat"><Icon name="close"/></button>}
              </div>
            </header>
            {chatPanel}
            <button ref={profileBarRef} className="unified-profile-bar" type="button" onClick={() => setProfileOpen(open => !open)} aria-expanded={profileOpen} aria-label={profileOpen ? 'Fechar perfil' : 'Abrir perfil'}>
              <Avatar avatar={profile.avatar} name={profile.name} speaking={speakingIds.has(selfId)} leader={Boolean(selfId && selfId === leaderId)} size="small"/>
              <span><strong>{profile.name}</strong><small>{profile.status}</small></span>
              <Icon name="settings"/>
            </button>
          </aside>
        <section ref={stageRef} className={`share-stage unified-room-stage ${sharingParticipants.length ? 'has-screens' : ''}`}>
          <GradientWaves
            className="room-gradient-waves"
            horizonColor="#00c4ff"
            waveColor="#ffffff"
            crestColor="#ffffff"
            speed={0.1}
            amplitude={2.5}
            waveScale={0.5}
            waveRatio={0.9}
            swell={35}
            turbulence={20}
            tilt={1.11}
            zoom={1}
            height={5.5}
            fogDepth={15}
            detail={mobile ? 'low' : 'medium'}
            brightness={1}
            opacity={1}
            mouseInteraction={animationsEnabled && !mobilePresentationOpen}
            parallaxStrength={0.5}
            grain={animationsEnabled && !mobilePresentationOpen}
            grainIntensity={0.05}
            animated={animationsEnabled && !mobilePresentationOpen}
          />
          {stageContent}
          {session && sharingParticipants.length > 0 && mode === 'connected' && (
            <div className="participant-rail">{connectedParticipants.map(participant => <div key={participant.id} className={speakingIds.has(participant.id) ? 'is-speaking' : ''}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} leader={participant.id === leaderId} size="small"/><span><strong>{participant.name}</strong><small>{participant.status}</small></span></div>)}</div>
          )}
          {callDock}
        </section>
        <aside className={`control-panel unified-control-panel ${controlsOpen ? 'is-open' : ''}`} role={phone && controlsOpen ? 'dialog' : undefined} aria-modal={phone && controlsOpen || undefined} aria-hidden={mobile && !controlsOpen} {...controlsSheetGesture}>
          <div className="panel-header"><div><h2>Controles</h2></div><span className="audience-count">{connectedParticipants.length}/{maxParticipants}</span>{mobile && <button className="mobile-panel-close" type="button" onClick={() => setControlsOpen(false)} aria-label="Fechar controles"><Icon name="close"/></button>}</div>
          {mobile && <button className="mobile-control-profile" type="button" onClick={() => { setProfileOpen(true); setControlsOpen(false); }}><Avatar avatar={profile.avatar} name={profile.name} leader={Boolean(selfId && selfId === leaderId)} size="small"/><span><strong>{profile.name}</strong><small>{profile.status}</small></span><Icon name="settings"/></button>}
          <div className="panel-view">{callPanel}</div>
        </aside>
      </main>
      {phone && (controlsOpen || profileOpen) && (
        <button className="mobile-overlay-backdrop" type="button" tabIndex={-1} aria-label="Fechar painel" onClick={() => {
          if (profileOpen) {
            commitProfileName();
            commitProfileStatus();
            setProfileOpen(false);
          }
          setControlsOpen(false);
        }}/>
      )}
      {dockSheetOpen && <div ref={mobileSheetRef} className="mobile-sheet-layer">
        <button className="mobile-sheet-backdrop" type="button" tabIndex={-1} aria-label="Fechar painel" onClick={closeDockSheets}/>
        <div className="mobile-sheet-host">{dockPopovers}</div>
      </div>}
      {profileOpen && (
        <div ref={profilePopoverRef} className="room-popover profile-popover unified-profile-popover" role={phone ? 'dialog' : undefined} aria-modal={phone || undefined} aria-labelledby="profile-sheet-title" {...profileSheetGesture}>
          <header><div><span className="eyebrow">SEU PERFIL</span><h3 id="profile-sheet-title">Como você aparece</h3></div><button type="button" onClick={() => { commitProfileName(); commitProfileStatus(); setProfileOpen(false); }} aria-label="Fechar perfil"><Icon name="close"/></button></header>
          <label htmlFor="profile-name">Nome</label><input id="profile-name" value={profileNameDraft} onChange={event => { profileEditRevisionRef.current += 1; profileNameDraftRef.current = event.target.value; setProfileNameDraft(event.target.value); }} onBlur={commitProfileName} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { profileNameDraftRef.current = profileRef.current.name; setProfileNameDraft(profileRef.current.name); event.currentTarget.blur(); } }} maxLength={28}/>
          <label htmlFor="profile-status">Mensagem de status</label><input id="profile-status" value={profileStatusDraft} onChange={event => { profileEditRevisionRef.current += 1; profileStatusDraftRef.current = event.target.value; setProfileStatusDraft(event.target.value); }} onBlur={commitProfileStatus} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { profileStatusDraftRef.current = profileRef.current.status; setProfileStatusDraft(profileRef.current.status); event.currentTarget.blur(); } }} maxLength={64} placeholder="Disponível"/>
          <div className="profile-photo-heading"><label>Foto</label><small>{profileSaveState === 'saving' ? 'SALVANDO…' : profileSaveState === 'saved' ? profileStorageKind() === 'sqlite' ? 'SALVO NO SQLITE LOCAL' : 'SALVO NESTE NAVEGADOR' : profileSaveState === 'error' ? 'ERRO AO SALVAR' : 'ARMAZENAMENTO LOCAL'}</small></div>
          <div className="profile-photo-actions"><Avatar avatar={profile.avatar} name={profile.name} size="normal"/><label className="profile-photo-upload">{avatarUploading ? 'Preparando…' : 'Escolher foto'}<input type="file" accept="image/*" onChange={event => void uploadAvatar(event)} disabled={avatarUploading}/></label>{profile.avatar.startsWith('data:image/') && <button type="button" onClick={removeCustomAvatar}>Remover</button>}</div>
          <label>Avatares do app</label><div className="avatar-picker">{AVATARS.map(avatar => <button className={profile.avatar === avatar.id ? 'selected' : ''} type="button" key={avatar.id} onClick={() => updateProfile({ avatar: avatar.id })}><Avatar avatar={avatar.id} name={avatar.label}/><span>{avatar.label}</span></button>)}</div>
        </div>
      )}
      {qrOpen && <div className="modal-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) setQrOpen(false); }}><section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="room-qr-title" {...qrSheetGesture}><span className="eyebrow">SALA {roomLabel}</span><h2 id="room-qr-title">Entrar pelo QR Code</h2><p>Aponte a câmera do celular para abrir o convite completo.</p>{qrCode ? <img src={qrCode} alt={`QR Code da sala ${roomLabel}`}/> : <div className="qr-loading">Gerando QR Code…</div>}<button type="button" onClick={() => setQrOpen(false)}>Fechar</button></section></div>}
      {error && mode !== 'error' && <button className="call-error" type="button" onClick={() => setError('')}>{error}<Icon name="close"/></button>}
    </div>
  );
}
