import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { createPrivateRoom, parseInvite, signalUrl, type IceServerConfig, type Invite, type RoomParticipant, type RoomProfile, type SessionDescription } from './protocol';
import { loadStoredProfile, prepareAvatar, profileStorageKind, saveStoredProfile } from './profileStore';
import './room.css';

type RoomMode = 'landing' | 'connecting' | 'connected' | 'error';
type IconName = 'screen' | 'microphone' | 'microphoneOff' | 'volume' | 'volumeOff' | 'chat' | 'send' | 'hangup' | 'link' | 'copy' | 'settings' | 'users' | 'crown' | 'close' | 'chevron' | 'chevronDown' | 'smile' | 'qr';
type Session = { invite: Invite; joinCode?: string; joinByCode?: boolean; ownerKey?: string; participantId?: string; maxParticipants?: number };
type RoomEntry = { kind: 'invite'; invite: Invite } | { kind: 'code'; code: string };
type ChatMessage = { id: string; senderId: string; senderName: string; text: string; sentAt: number; system?: boolean };
type Resolution = 360 | 480 | 720 | 1080;
type FrameRate = 15 | 30 | 45 | 60;
type AudioSettings = { inputDeviceId: string; outputDeviceId: string; inputVolume: number; outputVolume: number; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };

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
  | { type: 'room-closed' }
  | { type: 'pong'; at: number }
  | { type: 'error'; code: string; message: string };

const OWNER_ROOM_KEY = 'screenlink-owner-room-v2';
const PROFILE_KEY = 'screenlink-room-profile-v2';
const PEER_KEY_PREFIX = 'screenlink-room-peer:';
const CHAT_LIMIT = 160;
const RESOLUTIONS: Resolution[] = [360, 480, 720, 1080];
const FRAME_RATES: FrameRate[] = [15, 30, 45, 60];
const PARTICIPANT_LIMITS = [2, 3, 4, 5, 6, 7, 8];
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

const AVATARS = [
  { id: 'orbit', label: 'Órbita', colors: ['#8ee6ed', '#387f99'], face: 'robot' },
  { id: 'nova', label: 'Nova', colors: ['#ffcf91', '#9c5e7e'], face: 'fox' },
  { id: 'pixel', label: 'Pixel', colors: ['#a9d18e', '#397266'], face: 'frog' },
  { id: 'lumen', label: 'Lumen', colors: ['#dbb5ff', '#6656ac'], face: 'cat' },
  { id: 'byte', label: 'Byte', colors: ['#ffd0d0', '#a55367'], face: 'bear' },
  { id: 'echo', label: 'Echo', colors: ['#aec8ff', '#4d6099'], face: 'owl' }
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
    settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></>,
    users: <><circle cx="9" cy="9" r="3"/><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M16 6.5a3 3 0 0 1 0 5.8M16.5 14c2.5.5 3.7 2.4 4 5"/></>,
    crown: <path d="m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7Z"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    chevronDown: <path d="m6 9 6 6 6-6"/>,
    smile: <><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c2 2 5 2 7 0M9 9.5h.01M15 9.5h.01"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 14h3M21 14v3M14 19h3v2M19 18h2v3"/></>
  };
  return <svg className={`room-icon icon icon-${name}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function SegmentedSelector<T extends number>({ label, suffix, options, value, disabled = false, premium, fullWidth = false, onChange }: { label: string; suffix: string; options: T[]; value: T; disabled?: boolean; premium?: T; fullWidth?: boolean; onChange: (value: T) => void }) {
  const activeIndex = Math.max(0, options.indexOf(value));
  return <fieldset className={`profile-fieldset ${fullWidth ? 'is-full-width' : ''}`}><legend><span>{label}</span><small>{suffix}</small></legend><div className={`segmented-control ${premium === value ? 'is-premium-selected' : ''}`} style={{ '--active-index': activeIndex, '--option-count': options.length } as React.CSSProperties}>{premium === value && <span className="premium-particles" aria-hidden="true">{PREMIUM_PARTICLES.map(([x, y, size, duration, delay, jitter], index) => <i key={index} style={{ '--particle-x': x, '--particle-y': y, '--particle-size': size, '--particle-duration': duration, '--particle-delay': delay, '--particle-jitter': jitter } as React.CSSProperties}/>)}</span>}{options.map(option => <button key={option} className={`${option === value ? 'is-active' : ''} ${option === premium ? 'is-premium' : ''}`} type="button" disabled={disabled} onClick={() => onChange(option)}>{option}{label === 'Resolução' ? 'p' : ''}</button>)}</div></fieldset>;
}

function MascotMark() {
  return (
    <svg className="room-mascot" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 13V8" fill="none" stroke="#79ced9" strokeWidth="3" strokeLinecap="round"/><circle cx="32" cy="6" r="3" fill="#a6edf2"/>
      <path d="M17 22c-5-4-10-4-13-1 5 1 7 5 8 10l5-9Zm30 0c5-4 10-4 13-1-5 1-7 5-8 10l-5-9Z" fill="#58b7c8"/>
      <path d="M17 17c8-5 22-5 30 0 8 5 11 15 9 25-2 9-7 14-15 16-5 1-13 1-18 0-8-2-13-7-15-16-2-10 1-20 9-25Z" fill="#72cfdb" stroke="#b9f0f3" strokeWidth="2"/>
      <ellipse cx="24" cy="35" rx="3.2" ry="3.6" fill="#082b35"/><ellipse cx="40" cy="35" rx="3.2" ry="3.6" fill="#082b35"/>
      <path d="M26.5 43c3.6 3.5 7.4 3.5 11 0" fill="none" stroke="#082b35" strokeWidth="2.4" strokeLinecap="round"/><circle cx="18.5" cy="43" r="2.3" fill="#f3a09c"/><circle cx="45.5" cy="43" r="2.3" fill="#f3a09c"/>
    </svg>
  );
}

function Avatar({ avatar, name, speaking = false, leader = false, size = 'normal' }: { avatar: string; name: string; speaking?: boolean; leader?: boolean; size?: 'small' | 'normal' | 'large' }) {
  if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(avatar)) {
    return <span className={`preset-avatar avatar-${size} custom-avatar ${speaking ? 'is-speaking' : ''}`} title={name}><img src={avatar} alt="" draggable={false}/>{leader && <span className="avatar-crown" aria-label="Líder da sala"><Icon name="crown"/></span>}</span>;
  }
  const preset = AVATARS.find(item => item.id === avatar) ?? AVATARS[0];
  const gradientId = `avatar-bg-${preset.id}`;
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
        {preset.face === 'owl' && <><path d="M16 18c4.7-4.7 10.8-4.8 16-1 5.2-3.8 11.3-3.7 16 1 4.3 4.3 5.7 12.9 3.2 22.1C48.8 49 41.8 54 32 54s-16.8-5-19.2-13.9C10.3 30.9 11.7 22.3 16 18Z" fill="rgba(27,40,82,.72)"/><circle cx="24" cy="31" r="9" fill="#e8f0ff"/><circle cx="40" cy="31" r="9" fill="#e8f0ff"/><circle cx="24" cy="31" r="3"/><circle cx="40" cy="31" r="3"/><path d="m29 40 3 4 3-4" fill="#ffd080"/></>}
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
    {open && <div className="room-device-options" role="listbox" aria-label={label} onPointerEnter={openPicker} onPointerLeave={scheduleClose}>{[{ deviceId: '', label: 'Padrão do sistema' }, ...available].map((device, index) => <button key={`${device.deviceId || 'default'}-${index}`} type="button" role="option" aria-selected={device.deviceId === value} onClick={() => { onChange(device.deviceId); setOpen(false); }}><Icon name={kind === 'audioinput' ? 'microphone' : 'volume'}/><span>{device.label || `${label} ${index + 1}`}</span>{device.deviceId === value && <b>✓</b>}</button>)}</div>}
  </div>;
}

function normalizeName(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28) || 'Você';
}

function normalizeStatus(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Disponível';
}

function isMobileDevice() {
  return window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 980px)').matches;
}

function loadProfile(): RoomProfile {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') as Partial<RoomProfile>;
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
    const stored = JSON.parse(localStorage.getItem(OWNER_ROOM_KEY) || 'null') as Session | null;
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

function roomCode(invite: Invite) {
  return `${invite.roomId}.${invite.token}`;
}

function groupInviteUrl(invite: Invite) {
  const url = new URL(window.location.origin);
  url.hash = new URLSearchParams({ room: invite.roomId, key: invite.token }).toString();
  return url.toString();
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
  if (/^[A-Z2-9]{4}$/.test(shortCode)) return { kind: 'code', code: shortCode };
  const [roomId, token, extra] = trimmed.split('.');
  if (extra || !/^[A-Za-z0-9_-]{12,64}$/.test(roomId || '') || !/^[A-Za-z0-9_-]{32,128}$/.test(token || '')) return null;
  return { kind: 'invite', invite: { roomId, token } };
}

function send(socket: WebSocket | null, payload: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
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

function ScreenTile({ stream, name, local }: { stream: MediaStream; name: string; local?: boolean; playbackEnabled?: boolean; volume?: number; outputDeviceId?: string }) {
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
  const [profile, setProfile] = useState<RoomProfile>(() => loadProfile());
  const profileRef = useRef(profile);
  const [profileNameDraft, setProfileNameDraft] = useState(profile.name);
  const [profileStatusDraft, setProfileStatusDraft] = useState(profile.status);
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
  const [maxParticipants, setMaxParticipants] = useState(8);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const microphoneEnabledRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const sharingRef = useRef(false);
  const [playbackEnabled, setPlaybackEnabled] = useState(true);
  const playbackEnabledRef = useRef(true);
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(() => new Set());
  const [chatOpen, setChatOpen] = useState(() => !isMobileDevice());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const seenMessageIdsRef = useRef(new Set<string>());
  const [chatValue, setChatValue] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | ''>('');
  const [mediaLatency, setMediaLatency] = useState<number | null>(null);
  const [peerVersion, setPeerVersion] = useState(0);
  const [mobile] = useState(isMobileDevice);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({ inputDeviceId: '', outputDeviceId: '', inputVolume: 100, outputVolume: 100, echoCancellation: true, noiseSuppression: true, autoGainControl: true });

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
  const dockRef = useRef<HTMLDivElement>(null);
  const profileBarRef = useRef<HTMLButtonElement>(null);
  const profilePopoverRef = useRef<HTMLDivElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    profileRef.current = profile;
    const localAvatar = AVATARS.some(item => item.id === profile.avatar) ? profile.avatar : 'orbit';
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...profile, avatar: localAvatar }));
  }, [profile]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);
  useEffect(() => { microphoneEnabledRef.current = microphoneEnabled; }, [microphoneEnabled]);
  useEffect(() => { sharingRef.current = sharing; }, [sharing]);
  useEffect(() => { playbackEnabledRef.current = playbackEnabled; }, [playbackEnabled]);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);
  useEffect(() => { audioSettingsRef.current = audioSettings; }, [audioSettings]);

  useEffect(() => {
    let cancelled = false;
    void loadStoredProfile().then(stored => {
      if (cancelled || !stored) return;
      const restored = {
        ...profileRef.current,
        name: normalizeName(stored.name),
        avatar: normalizeAvatar(stored.avatar),
        status: normalizeStatus(stored.status)
      };
      profileRef.current = restored;
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
    if (!audioMenuOpen && !screenMenuOpen && !leaveMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!dockRef.current?.contains(event.target as Node)) {
        setAudioMenuOpen(false);
        setScreenMenuOpen(false);
        setLeaveMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [audioMenuOpen, leaveMenuOpen, screenMenuOpen]);

  useEffect(() => {
    if (!emojiOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!emojiPickerRef.current?.contains(event.target as Node)) setEmojiOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [emojiOpen]);

  useEffect(() => {
    if (!session?.invite.token) {
      setQrCode('');
      setQrOpen(false);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(groupInviteUrl(session.invite), {
      width: 720,
      margin: 2,
      color: { dark: '#071013', light: '#f7fbfc' },
      errorCorrectionLevel: 'M'
    }).then(value => { if (!cancelled) setQrCode(value); }).catch(() => { if (!cancelled) setQrCode(''); });
    return () => { cancelled = true; };
  }, [session?.invite.roomId, session?.invite.token]);

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

  useLayoutEffect(() => {
    const log = chatLogRef.current;
    if (!log || !chatOpen) return;
    log.scrollTop = log.scrollHeight;
  }, [chatMessages, chatOpen, chatValue]);

  const appendMessage = useCallback((message: ChatMessage) => {
    if (seenMessageIdsRef.current.has(message.id)) return;
    seenMessageIdsRef.current.add(message.id);
    setChatMessages(current => [...current, message].slice(-CHAT_LIMIT));
  }, []);

  const systemMessage = useCallback((text: string) => {
    appendMessage({ id: `system-${Date.now()}-${randomSecret(4)}`, senderId: 'system', senderName: '', text, sentAt: Date.now(), system: true });
  }, [appendMessage]);

  const updateParticipant = useCallback((participant: RoomParticipant) => {
    setParticipants(current => ({ ...current, [participant.id]: participant }));
  }, []);

  const updateSelfMediaState = useCallback((next: { sharing?: boolean; microphoneEnabled?: boolean } = {}) => {
    const id = selfIdRef.current;
    if (id) {
      setParticipants(current => {
        const self = current[id];
        if (!self) return current;
        return { ...current, [id]: { ...self, sharing: next.sharing ?? sharingRef.current, microphoneEnabled: next.microphoneEnabled ?? microphoneEnabledRef.current } };
      });
    }
    send(socketRef.current, {
      type: 'participant-state',
      profile: profileRef.current,
      sharing: next.sharing ?? sharingRef.current,
      microphoneEnabled: next.microphoneEnabled ?? microphoneEnabledRef.current
    });
  }, []);

  const attachChatChannel = useCallback((record: PeerRecord, channel: RTCDataChannel) => {
    record.chatChannel = channel;
    channel.onmessage = event => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as ChatMessage;
        if (!message?.id || typeof message.text !== 'string' || message.text.length > 1_000) return;
        appendMessage(message);
      } catch {
        // Mensagens inválidas não afetam a chamada.
      }
    };
    channel.onclose = () => { if (record.chatChannel === channel) record.chatChannel = null; };
  }, [appendMessage]);

  const destroyPeer = useCallback((peerId: string) => {
    const record = peersRef.current.get(peerId);
    if (!record) return;
    peersRef.current.delete(peerId);
    record.chatChannel?.close();
    record.callAudio?.remove();
    record.screenAudio?.remove();
    record.pc.ontrack = null;
    record.pc.onicecandidate = null;
    record.pc.onconnectionstatechange = null;
    record.pc.ondatachannel = null;
    record.pc.close();
    setPeerVersion(version => version + 1);
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
    const callTrack = call.receiver.track;
    if (!record.callAudio || !(record.callAudio.srcObject instanceof MediaStream) || record.callAudio.srcObject.getAudioTracks()[0]?.id !== callTrack.id) {
      record.callAudio?.remove();
      const audioElement = document.createElement('audio');
      audioElement.autoplay = true;
      audioElement.muted = !playbackEnabledRef.current;
      audioElement.volume = audioSettingsRef.current.outputVolume / 100;
      const sinkable = audioElement as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
      if (audioSettingsRef.current.outputDeviceId && sinkable.setSinkId) void sinkable.setSinkId(audioSettingsRef.current.outputDeviceId).catch(() => undefined);
      audioElement.srcObject = mediaStreamWith(callTrack);
      audioElement.dataset.roomPeer = record.id;
      document.body.append(audioElement);
      record.callAudio = audioElement;
      if (playbackEnabledRef.current) void audioElement.play().catch(() => undefined);
    }
    const screenAudioTrack = screenAudio.receiver.track;
    if (!record.screenAudio || !(record.screenAudio.srcObject instanceof MediaStream) || record.screenAudio.srcObject.getAudioTracks()[0]?.id !== screenAudioTrack.id) {
      record.screenAudio?.remove();
      const audioElement = document.createElement('audio');
      audioElement.autoplay = true;
      audioElement.muted = !playbackEnabledRef.current;
      audioElement.volume = audioSettingsRef.current.outputVolume / 100;
      const sinkable = audioElement as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
      if (audioSettingsRef.current.outputDeviceId && sinkable.setSinkId) void sinkable.setSinkId(audioSettingsRef.current.outputDeviceId).catch(() => undefined);
      audioElement.srcObject = mediaStreamWith(screenAudioTrack);
      audioElement.dataset.roomScreenAudioPeer = record.id;
      document.body.append(audioElement);
      record.screenAudio = audioElement;
      if (playbackEnabledRef.current) void audioElement.play().catch(() => undefined);
    }
    const screenVideoTrack = screenVideo.receiver.track;
    for (const track of record.screenStream.getTracks()) record.screenStream.removeTrack(track);
    record.screenStream.addTrack(screenVideoTrack);
    screenVideoTrack.addEventListener('unmute', () => setPeerVersion(version => version + 1));
    screenVideoTrack.addEventListener('mute', () => setPeerVersion(version => version + 1));
    setPeerVersion(version => version + 1);
  }, []);

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
      screenStream: new MediaStream()
    };
    peersRef.current.set(peerId, record);
    pc.onicecandidate = event => {
      if (event.candidate) send(socketRef.current, { type: 'peer-signal', targetId: peerId, kind: 'ice-candidate', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = () => { window.setTimeout(() => void syncPeerMedia(record), 0); };
    pc.ondatachannel = event => { if (event.channel.label === 'room-chat') attachChatChannel(record, event.channel); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') destroyPeer(peerId);
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
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send(socketRef.current, { type: 'peer-signal', targetId: peerId, kind: 'offer', sdp: offer });
    }
    setPeerVersion(version => version + 1);
    return record;
  }, [attachChatChannel, destroyPeer, syncPeerMedia]);

  const handleRoomMessage = useCallback(async (message: RoomMessage) => {
    if (message.type === 'room-ready') {
      iceServersRef.current = message.iceServers;
      selfIdRef.current = message.selfId;
      setSelfId(message.selfId);
      setLeaderId(message.leaderId);
      if (message.maxParticipants) setMaxParticipants(message.maxParticipants);
      const next = Object.fromEntries(message.participants.map(participant => [participant.id, participant]));
      setParticipants(next);
      setMode('connected');
      setError('');
      const activeSession = sessionRef.current;
      if (activeSession) {
        const nextSession = { ...activeSession, invite: message.invite, joinCode: message.joinCode, joinByCode: false, participantId: message.selfId };
        sessionRef.current = nextSession;
        setSession(nextSession);
        if (nextSession.ownerKey) localStorage.setItem(OWNER_ROOM_KEY, JSON.stringify(nextSession));
        else {
          sessionStorage.setItem(`${PEER_KEY_PREFIX}${message.roomId}`, message.selfId);
          history.replaceState(null, '', `${location.pathname}#${new URLSearchParams({ room: message.invite.roomId, key: message.invite.token })}`);
        }
      }
      for (const participant of message.participants) {
        if (participant.id !== message.selfId && participant.connected) await createPeer(participant.id, true);
      }
      updateSelfMediaState();
      return;
    }
    if (message.type === 'participant-joined') {
      updateParticipant(message.participant);
      systemMessage(`${message.participant.name} entrou na chamada.`);
      return;
    }
    if (message.type === 'participant-left') {
      const name = participantsRef.current[message.peerId]?.name || 'Um participante';
      destroyPeer(message.peerId);
      setParticipants(current => { const next = { ...current }; delete next[message.peerId]; return next; });
      systemMessage(`${name} saiu da chamada.`);
      return;
    }
    if (message.type === 'participant-state') {
      updateParticipant(message.participant);
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
        await record.pc.setRemoteDescription(message.sdp);
        await syncPeerMedia(record);
        for (const candidate of record.queuedCandidates.splice(0)) await record.pc.addIceCandidate(candidate).catch(() => undefined);
        const answer = await record.pc.createAnswer();
        await record.pc.setLocalDescription(answer);
        send(socketRef.current, { type: 'peer-signal', targetId: message.fromId, kind: 'answer', sdp: answer });
        return;
      }
      if (message.kind === 'answer') {
        if (!record) return;
        await record.pc.setRemoteDescription(message.sdp);
        await syncPeerMedia(record);
        for (const candidate of record.queuedCandidates.splice(0)) await record.pc.addIceCandidate(candidate).catch(() => undefined);
        return;
      }
      if (!record) record = await createPeer(message.fromId, false);
      if (record.pc.remoteDescription) await record.pc.addIceCandidate(message.candidate).catch(() => undefined);
      else record.queuedCandidates.push(message.candidate);
      return;
    }
    if (message.type === 'chat-fallback') {
      appendMessage(message.message);
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'room-closed') {
      if (sessionRef.current?.ownerKey) localStorage.removeItem(OWNER_ROOM_KEY);
      setError('O criador encerrou a sala.');
      setMode('error');
      return;
    }
    if (message.type === 'error') {
      setError(message.message);
      if (message.code === 'ROOM_NOT_FOUND') {
        setMode('error');
        if (sessionRef.current?.ownerKey) localStorage.removeItem(OWNER_ROOM_KEY);
      }
    }
  }, [appendMessage, createPeer, destroyPeer, syncPeerMedia, systemMessage, updateParticipant, updateSelfMediaState]);

  useEffect(() => {
    if (!session) return;
    disposedRef.current = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    let pingTimer: number | null = null;

    const connect = () => {
      if (disposedRef.current) return;
      setMode(current => current === 'connected' ? current : 'connecting');
      socket = new WebSocket(signalUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        attempts = 0;
        const current = sessionRef.current;
        if (!current) return;
        if (current.ownerKey) {
          send(socket, { type: 'create-group-room', ...current.invite, ownerKey: current.ownerKey, participantId: current.participantId, profile: profileRef.current, maxParticipants: current.maxParticipants ?? maxParticipants });
        } else if (current.joinByCode && current.joinCode) {
          const participantId = current.participantId || sessionStorage.getItem(`${PEER_KEY_PREFIX}${current.joinCode}`) || undefined;
          send(socket, { type: 'join-group-room-code', code: current.joinCode, participantId, profile: profileRef.current });
        } else {
          const participantId = current.participantId || sessionStorage.getItem(`${PEER_KEY_PREFIX}${current.invite.roomId}`) || undefined;
          send(socket, { type: 'join-group-room', ...current.invite, participantId, profile: profileRef.current });
        }
        if (pingTimer !== null) window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => send(socket, { type: 'ping', at: Date.now() }), 3_000);
      };
      socket.onmessage = event => {
        try { void handleRoomMessage(JSON.parse(String(event.data)) as RoomMessage); }
        catch { setError('A sala enviou uma resposta inválida.'); }
      };
      socket.onerror = () => setError('O servidor está demorando para responder…');
      socket.onclose = event => {
        if (pingTimer !== null) window.clearInterval(pingTimer);
        if (disposedRef.current || event.code === 1000) return;
        setMode('connecting');
        reconnectTimerRef.current = window.setTimeout(connect, Math.min(7_000, 600 * 2 ** Math.min(attempts++, 4)));
      };
    };
    connect();
    return () => {
      disposedRef.current = true;
      if (pingTimer !== null) window.clearInterval(pingTimer);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      socket?.close(1000, 'Session changed');
      if (socketRef.current === socket) socketRef.current = null;
    };
  // Os dados da sessão podem ser enriquecidos após entrar por código curto. A conexão
  // deve sobreviver a essa atualização; ela só nasce ou termina com a própria sessão.
  }, [handleRoomMessage, Boolean(session)]);

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

  const acquireMicrophone = useCallback(async (force = false) => {
    const current = localMicrophoneTrackRef.current;
    if (!force && current?.readyState === 'live') {
      current.enabled = true;
      setMicrophoneEnabled(true);
      microphoneEnabledRef.current = true;
      updateSelfMediaState({ microphoneEnabled: true });
      return true;
    }
    try {
      const settings = audioSettingsRef.current;
      const sourceStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl
        }
      });
      const sourceTrack = sourceStream.getAudioTracks()[0];
      if (!sourceTrack) return false;
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
        disposeMicrophonePipeline();
        microphoneEnabledRef.current = false;
        setMicrophoneEnabled(false);
        updateSelfMediaState({ microphoneEnabled: false });
      }, { once: true });
      return true;
    } catch {
      setError('Não foi possível abrir o microfone. Confira a permissão e o dispositivo de entrada.');
      return false;
    }
  }, [disposeMicrophonePipeline, updateSelfMediaState]);

  const toggleMicrophone = useCallback(async () => {
    if (!localMicrophoneTrackRef.current || localMicrophoneTrackRef.current.readyState !== 'live') {
      await acquireMicrophone();
      return;
    }
    const next = !microphoneEnabledRef.current;
    localMicrophoneTrackRef.current.enabled = next;
    microphoneEnabledRef.current = next;
    setMicrophoneEnabled(next);
    updateSelfMediaState({ microphoneEnabled: next });
  }, [acquireMicrophone, updateSelfMediaState]);

  const stopScreenShare = useCallback(() => {
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
  }, [updateSelfMediaState]);

  const toggleScreenShare = useCallback(async () => {
    if (sharingRef.current) {
      stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Este navegador não oferece compartilhamento de tela. No celular, use um navegador que disponibilize essa permissão.');
      return;
    }
    try {
      const activeResolution = automaticQuality ? 720 : resolution;
      const activeFps = automaticQuality ? 30 : fps;
      const preset = VIDEO_PRESETS[activeResolution];
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: preset.width, max: preset.width }, height: { ideal: preset.height, max: preset.height }, frameRate: { ideal: activeFps, max: activeFps } }, audio: true });
      const video = stream.getVideoTracks()[0];
      if (!video) return;
      localScreenStreamRef.current = stream;
      video.contentHint = activeFps >= 45 ? 'motion' : 'detail';
      const screenAudio = stream.getAudioTracks()[0] ?? null;
      await Promise.all([...peersRef.current.values()].flatMap(peer => [
        peer.screenVideoSender?.replaceTrack(video).then(async () => {
          if (!peer.screenVideoSender) return;
          const parameters = peer.screenVideoSender.getParameters();
          parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
          parameters.encodings[0]!.maxBitrate = Math.round(preset.bitrate * (activeFps / 30));
          parameters.encodings[0]!.maxFramerate = activeFps;
          await peer.screenVideoSender.setParameters(parameters);
        }).catch(() => undefined),
        peer.screenAudioSender?.replaceTrack(screenAudio).catch(() => undefined)
      ]).filter(Boolean));
      sharingRef.current = true;
      setSharing(true);
      updateSelfMediaState({ sharing: true });
      video.addEventListener('ended', stopScreenShare, { once: true });
    } catch (screenError) {
      if (screenError instanceof DOMException && screenError.name === 'NotAllowedError') return;
      setError('Não foi possível iniciar o compartilhamento. Tente escolher novamente a tela, janela ou aba.');
    }
  }, [automaticQuality, fps, resolution, stopScreenShare, updateSelfMediaState]);

  const applyVideoProfile = useCallback(async (nextResolution: Resolution, nextFps: FrameRate) => {
    setResolution(nextResolution);
    setFps(nextFps);
    const track = localScreenStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const preset = VIDEO_PRESETS[nextResolution];
    track.contentHint = nextFps >= 45 ? 'motion' : 'detail';
    await track.applyConstraints({ width: { ideal: preset.width, max: preset.width }, height: { ideal: preset.height, max: preset.height }, frameRate: { ideal: nextFps, max: nextFps } }).catch(() => undefined);
    await Promise.all([...peersRef.current.values()].map(async peer => {
      if (!peer.screenVideoSender?.track) return;
      const parameters = peer.screenVideoSender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0]!.maxBitrate = Math.round(preset.bitrate * (nextFps / 30));
      parameters.encodings[0]!.maxFramerate = nextFps;
      await peer.screenVideoSender.setParameters(parameters).catch(() => undefined);
    }));
  }, []);

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
    localScreenStreamRef.current?.getTracks().forEach(track => track.stop());
    disposeMicrophonePipeline();
  }, [destroyPeer, disposeMicrophonePipeline]);

  function updateProfile(next: Partial<RoomProfile>) {
    const updated = { ...profileRef.current, ...next, name: normalizeName(next.name ?? profileRef.current.name), avatar: normalizeAvatar(next.avatar ?? profileRef.current.avatar), status: normalizeStatus(next.status ?? profileRef.current.status), device: mobile ? 'mobile' : 'desktop' } as RoomProfile;
    profileRef.current = updated;
    setProfile(updated);
    const id = selfIdRef.current;
    if (id && participantsRef.current[id]) updateParticipant({ ...participantsRef.current[id], ...updated });
    updateSelfMediaState();
  }

  function commitProfileName() {
    const name = normalizeName(profileNameDraft || profileRef.current.name);
    setProfileNameDraft(name);
    if (name !== profileRef.current.name) updateProfile({ name });
  }

  function commitProfileStatus() {
    const status = normalizeStatus(profileStatusDraft || profileRef.current.status);
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
    const invite = createPrivateRoom();
    const next: Session = { invite, ownerKey: randomSecret(), maxParticipants };
    localStorage.setItem(OWNER_ROOM_KEY, JSON.stringify(next));
    setError('');
    history.replaceState(null, '', location.pathname);
    setSession(next);
    setMode('connecting');
    void acquireMicrophone();
  }

  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    const entry = parseRoomEntry(joinValue);
    if (!entry) {
      setError('Cole um código ou link de sala válido.');
      return;
    }
    setError('');
    if (entry.kind === 'invite') {
      history.replaceState(null, '', `${location.pathname}#${new URLSearchParams({ room: entry.invite.roomId, key: entry.invite.token })}`);
      setSession({ invite: entry.invite });
    } else {
      history.replaceState(null, '', location.pathname);
      setSession({ invite: { roomId: entry.code, token: '' }, joinCode: entry.code, joinByCode: true });
    }
    setMode('connecting');
    void acquireMicrophone();
  }

  function exitRoom(closeRequested: boolean) {
    const connectedCount = Object.values(participantsRef.current).filter(participant => participant.connected).length;
    const closeForEveryone = closeRequested || (Boolean(sessionRef.current?.ownerKey) && connectedCount <= 1);
    send(socketRef.current, { type: closeForEveryone ? 'close-group-room' : 'leave-group-room' });
    if (closeForEveryone) localStorage.removeItem(OWNER_ROOM_KEY);
    socketRef.current?.close(1000, closeForEveryone ? 'Room closed' : 'Participant left');
    for (const peerId of [...peersRef.current.keys()]) destroyPeer(peerId);
    stopScreenShare();
    disposeMicrophonePipeline();
    setMicrophoneEnabled(false);
    setParticipants({});
    setSelfId('');
    selfIdRef.current = '';
    setLeaderId('');
    setSession(null);
    setMode('landing');
    setLeaveMenuOpen(false);
    setControlsOpen(false);
    setQrOpen(false);
    history.replaceState(null, '', location.pathname);
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
      if (peer.callAudio) peer.callAudio.volume = value / 100;
      if (peer.screenAudio) peer.screenAudio.volume = value / 100;
    }
  }

  function changeVoiceSetting(key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl') {
    const next = { ...audioSettingsRef.current, [key]: !audioSettingsRef.current[key] };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    const sourceTrack = microphoneSourceStreamRef.current?.getAudioTracks()[0];
    if (sourceTrack) void sourceTrack.applyConstraints({ echoCancellation: next.echoCancellation, noiseSuppression: next.noiseSuppression, autoGainControl: next.autoGainControl }).catch(() => undefined);
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
        if (next) void audioElement.play().catch(() => undefined);
      }
    }
  }

  function sendChat(event: FormEvent) {
    event.preventDefault();
    const text = chatValue.trim().slice(0, 1_000);
    if (!text || !selfIdRef.current) return;
    const message: ChatMessage = { id: `${selfIdRef.current}-${Date.now()}-${randomSecret(4)}`, senderId: selfIdRef.current, senderName: profileRef.current.name, text, sentAt: Date.now() };
    appendMessage(message);
    const payload = JSON.stringify(message);
    let directDeliveries = 0;
    for (const peer of peersRef.current.values()) {
      if (peer.chatChannel?.readyState !== 'open') continue;
      peer.chatChannel.send(payload);
      directDeliveries += 1;
    }
    const expectedDeliveries = Object.values(participantsRef.current).filter(participant => participant.connected && participant.id !== selfIdRef.current).length;
    if (directDeliveries < expectedDeliveries) send(socketRef.current, { type: 'chat-fallback', message: { id: message.id, text: message.text, sentAt: message.sentAt } });
    setChatValue('');
    setEmojiOpen(false);
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
    });
  }

  function toggleChatSidebar() {
    if (chatOpen) setProfileOpen(false);
    setAudioMenuOpen(false);
    setScreenMenuOpen(false);
    setLeaveMenuOpen(false);
    setControlsOpen(false);
    setEmojiOpen(false);
    setChatOpen(!chatOpen);
  }

  async function copyValue(kind: 'code' | 'link') {
    if (!session) return;
    const value = kind === 'code' ? (session.joinCode || session.invite.roomId.slice(0, 4).toUpperCase()) : groupInviteUrl(session.invite);
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
  const sharingParticipants = connectedParticipants.filter(participant => participant.sharing);
  const localScreen = localScreenStreamRef.current;
  const isOwner = Boolean(session?.ownerKey);
  const isLeader = selfId === leaderId;
  const roomLabel = session ? (session.joinCode || session.invite.roomId.slice(0, 4)).toUpperCase() : '';
  const remoteParticipantCount = connectedParticipants.filter(participant => participant.id !== selfId).length;
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
  void peerVersion;

  const chatPanel = (
    <div className="chat-panel unified-chat-panel">
      <div className="chat-log" ref={chatLogRef}>
        {chatMessages.length ? chatMessages.map(message => message.system ? (
          <p className="chat-system" key={message.id}>{message.text}</p>
        ) : (
          <article className={`chat-message ${message.senderId === selfId ? 'is-own' : ''}`} key={message.id}>
            <header><strong>{message.senderId === selfId ? 'Você' : message.senderName}</strong><time>{new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time></header>
            <p>{message.text}</p>
          </article>
        )) : <div className="chat-empty"><Icon name="chat"/><strong>A conversa começa aqui</strong><span>As mensagens são temporárias e somem ao encerrar a chamada.</span></div>}
      </div>
      <form className="chat-composer" onSubmit={sendChat}>
        <div className="emoji-picker-anchor" ref={emojiPickerRef}>
          <button className={emojiOpen ? 'is-open' : ''} type="button" onClick={() => setEmojiOpen(open => !open)} disabled={!session} aria-expanded={emojiOpen} aria-label="Escolher emoji"><Icon name="smile"/></button>
          {emojiOpen && <div className="emoji-picker" role="listbox" aria-label="Emojis">{CHAT_EMOJIS.map(emoji => <button key={emoji} type="button" role="option" aria-label={`Emoji ${emoji}`} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}</div>}
        </div>
        <textarea ref={chatInputRef} value={chatValue} onChange={event => setChatValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={session ? 'Escrever mensagem…' : 'Entre em uma chamada para conversar'} maxLength={1000} disabled={!session}/>
        <button type="submit" disabled={!chatValue.trim() || !session} aria-label="Enviar mensagem"><Icon name="send"/></button>
      </form>
    </div>
  );

  const audioPopover = audioMenuOpen ? (
    <section className="dock-popover audio-popover unified-audio-popover" aria-label="Configurações de áudio">
      <header><strong>Áudio</strong><small>DISPOSITIVOS E VOZ</small></header>
      <div className="room-device-stack">
        <RoomDevicePicker input label="Dispositivo de entrada" value={audioSettings.inputDeviceId} devices={audioDevices} onChange={deviceId => void changeInputDevice(deviceId)}/>
        <RoomDevicePicker label="Dispositivo de saída" value={audioSettings.outputDeviceId} devices={audioDevices} onChange={changeOutputDevice}/>
      </div>
      <div className="audio-popover-scroll">
        <section className="audio-menu-section">
          <header><strong>Volumes</strong><small>LOCAL</small></header>
          <div className="volume-control"><label htmlFor="room-input-volume"><strong>Volume de entrada</strong><small>Ganho do seu microfone</small></label><input id="room-input-volume" type="range" min="0" max="150" value={audioSettings.inputVolume} onChange={event => changeInputVolume(Number(event.target.value))}/><output>{audioSettings.inputVolume}%</output></div>
          <div className="volume-control"><label htmlFor="room-output-volume"><strong>Volume de saída</strong><small>Áudio recebido da chamada</small></label><input id="room-output-volume" type="range" min="0" max="100" value={audioSettings.outputVolume} onChange={event => changeOutputVolume(Number(event.target.value))}/><output>{audioSettings.outputVolume}%</output></div>
        </section>
        <section className="audio-menu-section">
          <header><strong>Tratamento de voz</strong><small>MICROFONE</small></header>
          <div className="voice-settings">
            {([
              ['noiseSuppression', 'Isolamento de voz', 'Reduz ruídos ao redor'],
              ['echoCancellation', 'Controle de eco', 'Evita retorno nos alto-falantes'],
              ['autoGainControl', 'Ganho automático', 'Equilibra o volume da sua voz']
            ] as const).map(([key, label, description]) => (
              <button key={key} className="voice-setting" type="button" role="switch" aria-checked={audioSettings[key]} onClick={() => changeVoiceSetting(key)}><span><strong>{label}</strong><small>{description}</small></span><i><b/></i></button>
            ))}
          </div>
        </section>
      </div>
    </section>
  ) : null;

  const screenPopover = screenMenuOpen ? (
    <section className="dock-popover more-popover screen-popover unified-screen-popover" aria-label="Configurações do compartilhamento">
      <header><strong>Compartilhamento</strong><small>{sharing ? 'ATIVO' : 'PRONTO'}</small></header>
      <button type="button" onClick={() => { void toggleScreenShare(); setScreenMenuOpen(false); }}><Icon name="screen"/><span><strong>{sharing ? 'Parar compartilhamento' : 'Compartilhar tela'}</strong><small>{sharing ? 'A chamada continuará ativa' : 'Escolha uma tela, janela ou aba'}</small></span></button>
      <button type="button" onClick={() => setScreenMenuOpen(false)}><Icon name="settings"/><span><strong>Qualidade do vídeo</strong><small>{automaticQuality ? 'Automática' : `${resolution}p · ${fps} FPS`}</small></span></button>
    </section>
  ) : null;

  const exitPopover = leaveMenuOpen ? (
    <section className="dock-popover audio-popover exit-popover" aria-label="Opções para sair da chamada">
      <header><strong>Sair da chamada</strong><small>AÇÕES DA SALA</small></header>
      <div className="exit-options">
        <button type="button" onClick={leaveRoom}><Icon name="hangup"/><span><strong>Sair da chamada</strong><small>A sala continua para quem permanecer</small></span></button>
        {isOwner && <button className="is-danger" type="button" onClick={closeRoom}><Icon name="close"/><span><strong>Encerrar sala</strong><small>Desconecta todas as pessoas agora</small></span></button>}
      </div>
    </section>
  ) : null;

  const callPanel = (
    <div className="panel-page unified-call-page">
      {!session ? (
        <section className="panel-section unified-join-section">
          <div className="section-heading"><h3>Entrar em uma chamada</h3><small>CÓDIGO OU LINK</small></div>
          <form onSubmit={joinRoom} className="unified-join-form"><div><Icon name="link"/><input value={joinValue} onChange={event => setJoinValue(event.target.value)} placeholder="Cole o código da sala" autoComplete="off"/><button type="submit">Entrar</button></div></form>
          {loadOwnerSession() && <button className="unified-resume" type="button" onClick={() => { setSession(loadOwnerSession()); setMode('connecting'); }}>Retomar sua última sala</button>}
        </section>
      ) : (
        <section className="panel-section unified-invite-section">
          <div className="section-heading"><h3>Convite da chamada</h3><small>SALA {roomLabel}</small></div>
          <div className="invite-code-display"><span>Código curto</span><strong>{roomLabel || '••••'}</strong></div>
          <div className="invite-actions"><button type="button" onClick={() => void copyValue('link')}><Icon name="link"/>{copied === 'link' ? 'Link copiado' : 'Copiar link'}</button><button type="button" onClick={() => setQrOpen(true)} disabled={!qrCode}><Icon name="qr"/>QR Code</button></div>
        </section>
      )}
        <section className="panel-section quality-section">
          <div className="section-heading"><h3>Qualidade do vídeo</h3><small>{automaticQuality ? 'AUTOMÁTICA' : 'MANUAL'}</small></div>
          <button className={`toggle-row ${automaticQuality ? 'is-active' : ''}`} type="button" role="switch" aria-checked={automaticQuality} onClick={() => { const next = !automaticQuality; setAutomaticQuality(next); if (next) void applyVideoProfile(720, 30); }}><Icon name="settings"/><span className="toggle-row-copy"><strong>Ajuste automático</strong><small>{activeResolution}p · até {activeFps} FPS</small></span><span className="toggle-row-switch"><i/></span></button>
          <div className="quality-controls">
            <SegmentedSelector label="Resolução" suffix="resolução" options={RESOLUTIONS} value={resolution} disabled={automaticQuality} premium={1080} onChange={value => { setAutomaticQuality(false); void applyVideoProfile(value, fps); }}/>
            <SegmentedSelector label="Fluidez" suffix="FPS" options={FRAME_RATES} value={fps} disabled={automaticQuality} premium={60} onChange={value => { setAutomaticQuality(false); void applyVideoProfile(resolution, value); }}/>
            {!session && <SegmentedSelector label="Participantes" suffix="máximo" options={PARTICIPANT_LIMITS} value={maxParticipants} fullWidth onChange={setMaxParticipants}/>}
          </div>
          <p className="profile-summary"><i/>Bitrate adaptativo ativo</p>
        </section>
      <p className="privacy-note">Voz e tela P2P · chat com fallback pela sala · nada é gravado</p>
    </div>
  );

  const callDock = session && mode !== 'error' ? (
    <div className="host-call-dock unified-call-dock" ref={dockRef} aria-label="Controles da chamada">
      <button className={`dock-connection-indicator ${connectionQuality}`} type="button" aria-label={mediaLatency === null ? 'RTT P2P aguardando medição' : `RTT P2P ${mediaLatency} milissegundos`} data-label="Conexão P2P"><Icon name="link"/><span className="connection-tooltip"><strong>{latencyLabel} ms</strong><small>RTT WebRTC · {connectedPeerCount} par{connectedPeerCount === 1 ? '' : 'es'}</small></span></button>
      <button className={playbackEnabled ? 'is-on' : ''} type="button" onClick={togglePlayback} aria-label={playbackEnabled ? 'Silenciar chamada' : 'Ouvir chamada'} data-label="Áudio"><Icon name={playbackEnabled ? 'volume' : 'volumeOff'}/></button>
      <div className="dock-split-control">
        <button className={microphoneEnabled ? 'is-on' : ''} type="button" onClick={() => void toggleMicrophone()} aria-label={microphoneEnabled ? 'Silenciar microfone' : 'Ativar microfone'} data-label="Microfone"><Icon name={microphoneEnabled ? 'microphone' : 'microphoneOff'}/></button>
        <button className={`dock-chevron ${audioMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setAudioMenuOpen(open => !open); setScreenMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={audioMenuOpen} aria-label="Configurações de áudio" data-label="Ajustes"><Icon name="chevronDown"/></button>
      </div>
      <div className="dock-split-control screen-split-control">
        <button className={sharing ? 'is-on' : ''} type="button" onClick={() => void toggleScreenShare()} aria-label={sharing ? 'Parar compartilhamento' : 'Compartilhar tela'} aria-pressed={sharing} data-label={sharing ? 'Parar tela' : 'Compartilhar'}><Icon name="screen"/></button>
        <button className={`dock-chevron ${screenMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setScreenMenuOpen(open => !open); setAudioMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={screenMenuOpen} aria-label="Configurações da tela" data-label="Ajustes"><Icon name="chevronDown"/></button>
      </div>
      <button className={activeChat ? 'is-on' : ''} type="button" onClick={toggleChatSidebar} aria-label={activeChat ? 'Fechar chat' : 'Abrir chat'} data-label="Chat"><Icon name="chat"/></button>
      {mobile && <button className={controlsOpen ? 'is-on mobile-controls-trigger' : 'mobile-controls-trigger'} type="button" onClick={() => { setControlsOpen(open => !open); setChatOpen(false); setProfileOpen(false); setAudioMenuOpen(false); setScreenMenuOpen(false); setLeaveMenuOpen(false); }} aria-expanded={controlsOpen} aria-label="Abrir controles" data-label="Controles"><Icon name="settings"/></button>}
      <span className="dock-divider"/>
      <button className="hangup" type="button" onClick={() => { setLeaveMenuOpen(open => !open); setAudioMenuOpen(false); setScreenMenuOpen(false); }} aria-expanded={leaveMenuOpen} aria-label="Opções para sair da chamada" data-label="Sair"><Icon name="hangup"/></button>
      {audioPopover}
      {screenPopover}
      {exitPopover}
    </div>
  ) : null;

  const stageContent = sharingParticipants.length ? (
    <div className={`unified-screens-grid count-${sharingParticipants.length}`}>
      {sharingParticipants.map(participant => {
        if (participant.id === selfId && localScreen) {
          return <ScreenTile key={participant.id} stream={localScreen} name={participant.name} local playbackEnabled={false} volume={0}/>;
        }
        const stream = peersRef.current.get(participant.id)?.screenStream;
        return stream ? <ScreenTile key={participant.id} stream={stream} name={participant.name} playbackEnabled={playbackEnabled} volume={audioSettings.outputVolume / 100} outputDeviceId={audioSettings.outputDeviceId}/> : null;
      })}
    </div>
  ) : (
    <div className="stage-empty unified-stage-empty">
      {session && mode === 'connected' && connectedParticipants.length ? (
        <div className="stage-identities">{connectedParticipants.map(participant => <div className="stage-identity" key={participant.id}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} leader={participant.id === leaderId} size="large"/><strong>{participant.id === selfId ? 'Você' : participant.name}</strong><small>{participant.status}</small></div>)}</div>
      ) : <div className="stage-echo"><Avatar avatar="echo" name="Echo" size="large"/></div>}
      <span className="eyebrow">Voz e tela P2P · chat resiliente</span>
      <h1>{!session ? 'Inicie uma chamada' : mode === 'connecting' ? 'Entrando na chamada' : mode === 'error' ? 'Sala indisponível' : 'Chamada em andamento'}</h1>
      <p>{!session ? 'Crie uma sala ou entre com um código. Depois, qualquer pessoa no computador pode compartilhar a própria tela.' : mode === 'connecting' ? 'Reconectando à sala sem interromper quem já está aqui…' : mode === 'error' ? error : 'A conversa continua normalmente mesmo quando nenhuma tela está sendo compartilhada.'}</p>
      {!session && <div className="stage-entry-actions"><button className="primary-action" type="button" onClick={() => void createRoom()}><Icon name="users"/> Iniciar chamada</button>{mobile && <button className="secondary-action" type="button" onClick={() => { setControlsOpen(true); setChatOpen(false); }}><Icon name="link"/> Entrar com código</button>}</div>}
      {mode === 'error' && <button className="primary-action" type="button" onClick={leaveRoom}>Voltar</button>}
      <small className="stage-note">Voz, tela e chat temporários · nada é gravado</small>
    </div>
  );

  return (
    <div className={`app room-app unified-room-app ${mobile ? 'viewer-mode is-mobile-room' : ''} ${activeChat ? 'is-chat-open' : ''} ${controlsOpen ? 'is-controls-open' : ''}`}>
      <header className="topbar">
        <div className="brand"><span className="unified-brand-mark"><Icon name="screen"/></span><strong>ScreenLink</strong></div>
        <div className={`status-pill room-status-${connectionQuality}`}><i/>{session ? connectionStatusLabel : 'Pronto'}</div>
      </header>
      <main className="host-main unified-room-main">
          <aside className={`unified-chat-sidebar ${activeChat ? 'is-open' : 'is-closed'}`} aria-label="Chat da chamada" aria-hidden={!activeChat}>
            <header className="unified-sidebar-header">
              <div><Icon name="chat"/><span><strong>Chat</strong><small>{session ? `Sala ${roomLabel}` : 'LOCAL'}</small></span></div>
              {mobile && <button type="button" onClick={() => { setChatOpen(false); setProfileOpen(false); }} aria-label="Fechar chat"><Icon name="close"/></button>}
            </header>
            {chatPanel}
            <button ref={profileBarRef} className="unified-profile-bar" type="button" onClick={() => setProfileOpen(open => !open)} aria-expanded={profileOpen} aria-label={profileOpen ? 'Fechar perfil' : 'Abrir perfil'}>
              <Avatar avatar={profile.avatar} name={profile.name} speaking={speakingIds.has(selfId)} leader={Boolean(selfId && selfId === leaderId)} size="small"/>
              <span><strong>{profile.name}</strong><small>{profile.status}</small></span>
              <Icon name="settings"/>
            </button>
          </aside>
        <section className={`share-stage unified-room-stage ${sharingParticipants.length ? 'has-screens' : ''}`}>
          {stageContent}
          {session && !sharingParticipants.length && mode === 'connected' && (
            <div className="participant-rail">{connectedParticipants.map(participant => <div key={participant.id} className={speakingIds.has(participant.id) ? 'is-speaking' : ''}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} leader={participant.id === leaderId} size="small"/><span><strong>{participant.id === selfId ? 'Você' : participant.name}</strong><small>{participant.status}</small></span></div>)}</div>
          )}
          {callDock}
        </section>
        <aside className={`control-panel unified-control-panel ${controlsOpen ? 'is-open' : ''}`} aria-hidden={mobile && !controlsOpen}>
          <div className="panel-header"><div><h2>Controles</h2></div><span className="audience-count">{connectedParticipants.length}/{maxParticipants}</span>{mobile && <button className="mobile-panel-close" type="button" onClick={() => setControlsOpen(false)} aria-label="Fechar controles"><Icon name="close"/></button>}</div>
          {mobile && <button className="mobile-control-profile" type="button" onClick={() => { setProfileOpen(true); setControlsOpen(false); }}><Avatar avatar={profile.avatar} name={profile.name} leader={Boolean(selfId && selfId === leaderId)} size="small"/><span><strong>{profile.name}</strong><small>{profile.status}</small></span><Icon name="settings"/></button>}
          <div className="panel-view">{callPanel}</div>
        </aside>
      </main>
      {profileOpen && (
        <div ref={profilePopoverRef} className="room-popover profile-popover unified-profile-popover">
          <header><div><span className="eyebrow">SEU PERFIL</span><h3>Como você aparece</h3></div><button type="button" onClick={() => { commitProfileName(); commitProfileStatus(); setProfileOpen(false); }} aria-label="Fechar perfil"><Icon name="close"/></button></header>
          <label htmlFor="profile-name">Nome</label><input id="profile-name" value={profileNameDraft} onChange={event => setProfileNameDraft(event.target.value)} onBlur={commitProfileName} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setProfileNameDraft(profileRef.current.name); event.currentTarget.blur(); } }} maxLength={28}/>
          <label htmlFor="profile-status">Mensagem de status</label><input id="profile-status" value={profileStatusDraft} onChange={event => setProfileStatusDraft(event.target.value)} onBlur={commitProfileStatus} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setProfileStatusDraft(profileRef.current.status); event.currentTarget.blur(); } }} maxLength={64} placeholder="Disponível"/>
          <div className="profile-photo-heading"><label>Foto</label><small>{profileSaveState === 'saving' ? 'SALVANDO…' : profileSaveState === 'saved' ? profileStorageKind() === 'sqlite' ? 'SALVO NO SQLITE LOCAL' : 'SALVO NESTE NAVEGADOR' : profileSaveState === 'error' ? 'ERRO AO SALVAR' : 'ARMAZENAMENTO LOCAL'}</small></div>
          <div className="profile-photo-actions"><Avatar avatar={profile.avatar} name={profile.name} size="normal"/><label className="profile-photo-upload">{avatarUploading ? 'Preparando…' : 'Escolher foto'}<input type="file" accept="image/*" onChange={event => void uploadAvatar(event)} disabled={avatarUploading}/></label>{profile.avatar.startsWith('data:image/') && <button type="button" onClick={removeCustomAvatar}>Remover</button>}</div>
          <label>Avatares do app</label><div className="avatar-picker">{AVATARS.map(avatar => <button className={profile.avatar === avatar.id ? 'selected' : ''} type="button" key={avatar.id} onClick={() => updateProfile({ avatar: avatar.id })}><Avatar avatar={avatar.id} name={avatar.label}/><span>{avatar.label}</span></button>)}</div>
        </div>
      )}
      {qrOpen && <div className="modal-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) setQrOpen(false); }}><section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="room-qr-title"><span className="eyebrow">SALA {roomLabel}</span><h2 id="room-qr-title">Entrar pelo QR Code</h2><p>Aponte a câmera do celular para abrir o convite completo.</p>{qrCode ? <img src={qrCode} alt={`QR Code da sala ${roomLabel}`}/> : <div className="qr-loading">Gerando QR Code…</div>}<button type="button" onClick={() => setQrOpen(false)}>Fechar</button></section></div>}
      {error && mode !== 'error' && <button className="call-error" type="button" onClick={() => setError('')}>{error}<Icon name="close"/></button>}
    </div>
  );
}

/* Standalone room layout retired after the group engine was merged into the main ScreenLink shell.
  if (!session || mode === 'landing') {
    const saved = loadOwnerSession();
    return (
      <div className="room-app room-landing">
        <header className="room-topbar"><span className="room-brand"><Icon name="screen"/><strong>ScreenLink</strong></span><span>Salas P2P</span></header>
        <main>
          <section className="landing-copy"><MascotMark/><span className="eyebrow">UMA SALA, TODAS AS TELAS</span><h1>Entre na call.<br/>Compartilhe quando quiser.</h1><p>Voz, chat e múltiplas telas em uma sala privada que continua ativa mesmo quando o líder sai.</p></section>
          <section className="landing-card">
            <button className="primary-room-action" type="button" onClick={() => void createRoom()}><Icon name="users"/><span><strong>Criar uma chamada</strong><small>Você começa como líder da sala</small></span><Icon name="chevron"/></button>
            <div className="landing-divider"><span>ou entre em uma sala</span></div>
            <form onSubmit={joinRoom} className="join-code-form"><label htmlFor="room-code">Código ou link da chamada</label><div><Icon name="link"/><input id="room-code" value={joinValue} onChange={event => setJoinValue(event.target.value)} placeholder="Cole o código aqui" autoComplete="off"/><button type="submit">Entrar</button></div></form>
            {saved && <button className="resume-room" type="button" onClick={() => { setSession(saved); setMode('connecting'); }}><span><strong>Retomar sua sala</strong><small>{saved.invite.roomId.slice(0, 4).toUpperCase()} · você reassume a liderança</small></span><Icon name="chevron"/></button>}
            {error && <p className="room-error">{error}</p>}
          </section>
        </main>
      </div>
    );
  }

  if (mode === 'error') {
    return <div className="room-app room-state"><MascotMark/><h1>Sala indisponível</h1><p>{error}</p><button type="button" onClick={leaveRoom}>Voltar</button></div>;
  }

  return (
    <div className={`room-app call-room ${mobile ? 'is-mobile-room' : 'is-desktop-room'} ${chatOpen ? 'has-chat' : ''}`}>
      <header className="room-topbar">
        <span className="room-brand"><Icon name="screen"/><strong>ScreenLink</strong></span>
        <button className="room-title" type="button" onClick={() => setInviteOpen(open => !open)}><span>Sala {roomLabel}</span><small>{connectedParticipants.length} participante{connectedParticipants.length === 1 ? '' : 's'}</small><Icon name="chevron"/></button>
        <span className={`connection-pill ${mode}`}>{mode === 'connected' ? `${latency || '—'} ms` : 'Conectando'}</span>
      </header>

      {!mobile && <aside className="room-sidebar">
        <div className="sidebar-room-heading"><div><span className="eyebrow">SALA ATUAL</span><h2>Call {roomLabel}</h2></div><button type="button" onClick={() => setInviteOpen(open => !open)} aria-label="Abrir convite"><Icon name="link"/></button></div>
        <div className="sidebar-section-title"><span>Na chamada</span><small>{connectedParticipants.length}/8</small></div>
        <div className="participant-list">
          {connectedParticipants.map(participant => <div className="participant-row" key={participant.id}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} size="small"/><span><strong>{participant.id === selfId ? `${participant.name} (você)` : participant.name}</strong><small>{participant.id === leaderId ? 'Líder da sala' : participant.sharing ? 'Compartilhando tela' : participant.microphoneEnabled ? 'Microfone ativo' : 'Silenciado'}</small></span>{participant.id === leaderId && <Icon name="crown"/>}</div>)}
        </div>
        <button className="invite-people" type="button" onClick={() => setInviteOpen(true)}><Icon name="users"/> Convidar pessoas</button>
        <div className="sidebar-profile"><button type="button" onClick={() => setProfileOpen(open => !open)}><Avatar avatar={profile.avatar} name={profile.name} speaking={speakingIds.has(selfId)} size="small"/><span><strong>{profile.name}</strong><small>{isLeader ? 'Líder' : 'Na chamada'}</small></span><Icon name="settings"/></button></div>
      </aside>}

      <main className="room-stage">
        {mode === 'connecting' ? <div className="stage-empty"><MascotMark/><h1>Entrando na chamada</h1><p>Reconectando à sala sem interromper quem já está aqui…</p></div> : sharingParticipants.length ? (
          <div className={`screens-grid count-${sharingParticipants.length}`}>
            {sharingParticipants.map(participant => {
              if (participant.id === selfId && localScreen) return <ScreenTile key={participant.id} stream={localScreen} name={participant.name} local playbackEnabled={false}/>;
              const stream = peersRef.current.get(participant.id)?.screenStream;
              return stream ? <ScreenTile key={participant.id} stream={stream} name={participant.name} playbackEnabled={playbackEnabled}/> : null;
            })}
          </div>
        ) : <div className="stage-empty participant-stage"><div className="stage-avatars">{connectedParticipants.map(participant => <Avatar key={participant.id} avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} size="large"/>)}</div><h1>Chamada em andamento</h1><p>Qualquer pessoa no computador pode compartilhar a tela quando precisar.</p></div>}

        <div className="participant-rail">{connectedParticipants.map(participant => <div key={participant.id} className={speakingIds.has(participant.id) ? 'is-speaking' : ''}><Avatar avatar={participant.avatar} name={participant.name} speaking={speakingIds.has(participant.id)} size="small"/><span>{participant.id === selfId ? 'Você' : participant.name}</span></div>)}</div>

        <div className="room-dock" aria-label="Controles da chamada">
          <button className={playbackEnabled ? 'is-active' : ''} type="button" onClick={togglePlayback} aria-label={playbackEnabled ? 'Silenciar chamada' : 'Ouvir chamada'}><Icon name={playbackEnabled ? 'volume' : 'volumeOff'}/><span>Áudio</span></button>
          <button className={microphoneEnabled ? 'is-active' : ''} type="button" onClick={() => void toggleMicrophone()} aria-label={microphoneEnabled ? 'Silenciar microfone' : 'Ativar microfone'}><Icon name={microphoneEnabled ? 'microphone' : 'microphoneOff'}/><span>Microfone</span></button>
          {!mobile && <button className={sharing ? 'is-sharing' : ''} type="button" onClick={() => void toggleScreenShare()} aria-label={sharing ? 'Parar compartilhamento' : 'Compartilhar tela'}><Icon name="screen"/><span>{sharing ? 'Parar tela' : 'Compartilhar'}</span></button>}
          <button className={chatOpen ? 'is-active' : ''} type="button" onClick={() => setChatOpen(open => !open)} aria-label="Abrir chat"><Icon name="chat"/><span>Chat</span></button>
          <button className="leave-call" type="button" onClick={leaveRoom} aria-label="Sair da chamada"><Icon name="hangup"/><span>Sair</span></button>
        </div>
      </main>

      {chatOpen && <aside className="room-chat-panel"><header><div><span className="eyebrow">DURANTE A CALL</span><h2>Chat da sala</h2></div><button type="button" onClick={() => setChatOpen(false)} aria-label="Fechar chat"><Icon name="close"/></button></header><div className="room-chat-messages">{chatMessages.length ? chatMessages.map(message => message.system ? <p className="system-chat-message" key={message.id}>{message.text}</p> : <article className={message.senderId === selfId ? 'own' : ''} key={message.id}><div><strong>{message.senderId === selfId ? 'Você' : message.senderName}</strong><time>{new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></article>) : <div className="empty-chat"><Icon name="chat"/><p>As mensagens desta sala aparecem aqui e somem quando a call termina.</p></div>}</div><form onSubmit={sendChat}><input value={chatValue} onChange={event => setChatValue(event.target.value)} placeholder="Mensagem para a sala" maxLength={1000}/><button type="submit" disabled={!chatValue.trim()} aria-label="Enviar mensagem"><Icon name="chevron"/></button></form></aside>}

      {inviteOpen && <div className="room-popover invite-popover"><header><div><span className="eyebrow">CONVIDAR</span><h3>Código da sala</h3></div><button type="button" onClick={() => setInviteOpen(false)}><Icon name="close"/></button></header><p>Quem entrar pelo computador poderá falar e compartilhar a própria tela.</p><label>Código curto</label><button className="copy-row" type="button" onClick={() => void copyValue('code')}><code>{roomCode(session.invite)}</code><span>{copied === 'code' ? 'Copiado' : <Icon name="copy"/>}</span></button><button className="copy-link" type="button" onClick={() => void copyValue('link')}><Icon name="link"/>{copied === 'link' ? 'Link copiado' : 'Copiar link completo'}</button>{isOwner && <button className="close-room-action" type="button" onClick={closeRoom}>Encerrar sala para todos</button>}</div>}

      {profileOpen && <div className="room-popover profile-popover"><header><div><span className="eyebrow">SEU PERFIL</span><h3>Como você aparece</h3></div><button type="button" onClick={() => setProfileOpen(false)}><Icon name="close"/></button></header><label htmlFor="profile-name">Nome</label><input id="profile-name" value={profile.name} onChange={event => updateProfile({ name: event.target.value })} maxLength={28}/><label>Avatar</label><div className="avatar-picker">{AVATARS.map(avatar => <button className={profile.avatar === avatar.id ? 'selected' : ''} type="button" key={avatar.id} onClick={() => updateProfile({ avatar: avatar.id })}><Avatar avatar={avatar.id} name={avatar.label}/><span>{avatar.label}</span></button>)}</div></div>}

      {error && <button className="call-error" type="button" onClick={() => setError('')}>{error}<Icon name="close"/></button>}
    </div>
  );
}
*/
