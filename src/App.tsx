import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import {
  createPrivateRoom,
  inviteUrl,
  parseInvite,
  signalUrl,
  type IceServerConfig,
  type Invite,
  type ServerMessage
} from './protocol';

type IconName = 'screen' | 'link' | 'shield' | 'stop' | 'copy' | 'phone' | 'expand' | 'check' | 'signal' | 'volume' | 'volumeOff' | 'pause' | 'play' | 'microphone' | 'microphoneOff' | 'share' | 'qr' | 'zoom' | 'pip' | 'wake' | 'auto';
type HostStatus = 'idle' | 'starting' | 'live' | 'reconnecting' | 'error';
type AudienceStatus = 'empty' | 'connecting' | 'connected';
type ViewerStatus = 'connecting' | 'waiting' | 'live' | 'ended' | 'error';
type PeerRecord = { id: string; pc: RTCPeerConnection; queued: RTCIceCandidateInit[]; remoteAudio: HTMLAudioElement | null };
type RuntimeConfig = { viewerOrigin?: string; mode?: 'p2p-stun'; turnEnabled?: boolean };
type Resolution = 360 | 480 | 720 | 1080;
type FrameRate = 15 | 30 | 45 | 60;
type VideoProfile = { resolution: Resolution; fps: FrameRate };
type ProfileStatus = 'idle' | 'applying' | 'applied' | 'error';
type ConnectionQuality = 'waiting' | 'excellent' | 'good' | 'limited' | 'blocked';
type ConnectionMetrics = { bitrateKbps: number; availableKbps: number; rttMs: number; packetLoss: number };
type HostPanel = 'stream' | 'audio';

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void, options?: AddEventListenerOptions) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
};

type PictureInPictureVideo = HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
type PictureInPictureDocument = Document & { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element; exitPictureInPicture?: () => Promise<void> };

const RESOLUTIONS: readonly Resolution[] = [360, 480, 720, 1080];
const FRAME_RATES: readonly FrameRate[] = [15, 30, 45, 60];
const VIEWER_LIMITS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const VIDEO_SIZES: Record<Resolution, { width: number; height: number; bitrate: number }> = {
  360: { width: 640, height: 360, bitrate: 1_500_000 },
  480: { width: 854, height: 480, bitrate: 2_500_000 },
  720: { width: 1280, height: 720, bitrate: 5_500_000 },
  1080: { width: 1920, height: 1080, bitrate: 9_000_000 }
};

function videoSettings(profile: VideoProfile) {
  const size = VIDEO_SIZES[profile.resolution];
  const frameRateFactor = profile.fps === 15 ? .7 : profile.fps === 30 ? 1 : profile.fps === 45 ? 1.25 : 1.5;
  return { ...size, fps: profile.fps, bitrate: Math.round(size.bitrate * frameRateFactor) };
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function useSessionDuration(startedAt: number | null) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!startedAt) {
      setSeconds(0);
      return;
    }
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return formatDuration(seconds);
}

function classifyConnection(metrics: ConnectionMetrics): ConnectionQuality {
  if (metrics.packetLoss >= 8 || metrics.rttMs >= 450) return 'limited';
  if (metrics.packetLoss >= 3 || metrics.rttMs >= 250) return 'good';
  return 'excellent';
}

function automaticProfile(metrics: ConnectionMetrics): VideoProfile {
  const capacity = metrics.availableKbps;
  if (metrics.packetLoss >= 8 || metrics.rttMs >= 450 || (capacity > 0 && capacity < 1_200)) return { resolution: 360, fps: 15 };
  if (metrics.packetLoss >= 4 || metrics.rttMs >= 280 || (capacity > 0 && capacity < 2_500)) return { resolution: 480, fps: 30 };
  if (metrics.packetLoss >= 2 || metrics.rttMs >= 170 || (capacity > 0 && capacity < 4_500)) return { resolution: 720, fps: 30 };
  if (!capacity) return { resolution: 720, fps: 30 };
  if (metrics.rttMs >= 120 || capacity < 7_500) return { resolution: 720, fps: 45 };
  if (capacity < 12_000) return { resolution: 1080, fps: 45 };
  return { resolution: 1080, fps: 60 };
}

async function configureVideoSender(sender: RTCRtpSender, profile: VideoProfile) {
  const settings = videoSettings(profile);
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  parameters.encodings[0]!.maxBitrate = settings.bitrate;
  parameters.encodings[0]!.maxFramerate = settings.fps;
  parameters.degradationPreference = 'maintain-framerate';
  await sender.setParameters(parameters);
}

function SegmentedControl<T extends number>({ label, suffix, options, value, disabled = false, onChange }: {
  label: string;
  suffix: string;
  options: readonly T[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const activeIndex = options.indexOf(value);
  return (
    <fieldset className="profile-fieldset">
      <legend><span>{label}</span><small>{suffix}</small></legend>
      <div className="segmented-control" role="radiogroup" aria-label={label} style={{ '--active-index': activeIndex, '--option-count': options.length } as CSSProperties}>
        {options.map(option => {
          const premium = (suffix === 'resolução' && option === 1080) || (suffix === 'FPS' && option === 60);
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === value}
              disabled={disabled}
              className={[option === value ? 'is-active' : '', premium ? 'is-premium' : ''].filter(Boolean).join(' ')}
              onClick={() => onChange(option)}
            >
              {option}{suffix === 'resolução' ? 'p' : ''}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function ToggleRow({ icon, label, description, checked, disabled = false, onClick }: {
  icon: IconName;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`toggle-row ${checked ? 'is-active' : ''}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="toggle-row-copy"><strong>{label}</strong><small>{description}</small></span>
      <span className="toggle-row-switch" aria-hidden="true"><i /></span>
    </button>
  );
}

function VolumeControl({ id, label, description, value, disabled = false, onChange }: {
  id: string;
  label: string;
  description: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={`volume-control ${disabled ? 'is-disabled' : ''}`}>
      <label htmlFor={id}><strong>{label}</strong><small>{description}</small></label>
      <input
        id={id}
        type="range"
        min="0"
        max="100"
        step="1"
        value={value}
        disabled={disabled}
        aria-valuetext={`${value}%`}
        onChange={event => onChange(Number(event.currentTarget.value))}
      />
      <output htmlFor={id}>{value}%</output>
    </div>
  );
}

type ModelContext = {
  registerTool: (tool: {
    name: string;
    title: string;
    description: string;
    inputSchema: object;
    annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
    execute: (input: unknown) => unknown | Promise<unknown>;
  }, options?: { signal?: AbortSignal }) => void | Promise<void>;
};

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    screen: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2A5 5 0 0 0 12 4l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></>,
    shield: <><path d="M12 3 4.5 6v5.5c0 4.7 3.2 7.8 7.5 9.5 4.3-1.7 7.5-4.8 7.5-9.5V6L12 3Z"/><path d="m9.5 12 1.7 1.7 3.7-4"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    phone: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    signal: <><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8 16a6 6 0 0 1 8 0"/><path d="M11 19.5a2 2 0 0 1 2 0"/></>,
    volume: <><path d="M11 5 6.5 9H3v6h3.5l4.5 4V5Z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M17.8 6.8a8 8 0 0 1 0 10.4"/></>,
    volumeOff: <><path d="M11 5 6.5 9H3v6h3.5l4.5 4V5Z"/><path d="m16 10 5 5M21 10l-5 5"/></>,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></>,
    play: <path d="m8 5 11 7-11 7V5Z"/>,
    microphone: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/></>,
    microphoneOff: <><path d="m4 4 16 16"/><path d="M9 5.5V11a3 3 0 0 0 4.9 2.3M15 9V6a3 3 0 0 0-5.1-2.1M5.5 11.5a6.5 6.5 0 0 0 10.8 4.9M18.5 11.5a6.5 6.5 0 0 1-.7 2.9M12 18v3M8.5 21h7"/></>,
    share: <><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 8-5M8 13l8 5"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 14h2M19 18v3M14 20h2"/></>,
    zoom: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6"/></>,
    pip: <><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1"/></>,
    wake: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    auto: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></>
  };

  return <svg className={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function ScreenLinkMascot() {
  return (
    <svg className="waiting-mascot" viewBox="0 0 180 160" aria-hidden="true">
      <ellipse className="mascot-shadow" cx="91" cy="144" rx="40" ry="6" />
      <g className="mascot-float">
        <g className="mascot-signal-group">
          <path className="mascot-signal-arc" d="M91 39c0-7 1-11 3-15" />
          <circle className="mascot-signal" cx="94" cy="20" r="3.5" />
          <circle className="mascot-signal-ring" cx="94" cy="20" r="7" />
        </g>
        <path className="mascot-ear mascot-ear-left" d="M51 51C39 43 25 45 23 57c8-3 13 2 14 11 5-3 10-8 14-17Z" />
        <path className="mascot-ear mascot-ear-right" d="M130 48c13-7 25-3 27 8-7-2-12 3-13 12-6-4-10-10-14-20Z" />
        <path className="mascot-body" d="M53 38c20-13 57-13 77 3 17 14 18 53 4 72-15 20-64 23-86 6-18-14-18-61 5-81Z" />
        <path className="mascot-belly" d="M58 101c19 11 48 11 67-2-5 19-16 27-34 28-17 0-28-8-33-26Z" />
        <path className="mascot-highlight" d="M59 43c13-8 35-10 49-6" />
        <g className="mascot-face">
          <ellipse cx="74" cy="73" rx="4" ry="5" />
          <ellipse cx="108" cy="72" rx="4" ry="5" />
          <path d="M82 87c6 5 14 5 20 0" />
        </g>
        <circle className="mascot-cheek" cx="62" cy="87" r="3.5" />
        <circle className="mascot-cheek" cx="120" cy="86" r="3.5" />
        <g className="mascot-mark">
          <rect x="82" y="106" width="12" height="9" rx="3" />
          <rect x="96" y="106" width="12" height="9" rx="3" />
          <path d="M92 110h6" />
        </g>
        <g className="mascot-spark mascot-spark-one"><path d="m147 29 1-9m-5 5 10-1" /></g>
        <g className="mascot-spark mascot-spark-two"><path d="m31 40-3-6m0 8-7-2" /></g>
      </g>
    </svg>
  );
}

function Header({ status, live = false, meta }: { status: string; live?: boolean; meta?: string }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><span /></span><strong>ScreenLink</strong></div>
      <div className="topbar-session">
        {meta && <span className="topbar-meta">{meta}</span>}
        {!live && <div className="status-pill"><i />{status}</div>}
      </div>
    </header>
  );
}

function send(socket: WebSocket | null, payload: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function closePeer(record: PeerRecord | null) {
  if (!record) return;
  record.pc.onicecandidate = null;
  record.pc.onconnectionstatechange = null;
  record.pc.ontrack = null;
  record.pc.close();
  if (record.remoteAudio) {
    const stream = record.remoteAudio.srcObject instanceof MediaStream ? record.remoteAudio.srcObject : null;
    stream?.getTracks().forEach(track => track.stop());
    record.remoteAudio.srcObject = null;
    record.remoteAudio.remove();
    record.remoteAudio = null;
  }
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop());
}

function HostApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peersRef = useRef(new Map<string, PeerRecord>());
  const inviteRef = useRef<Invite | null>(null);
  const viewerOriginRef = useRef(window.location.origin);
  const iceServersRef = useRef<IceServerConfig[]>([]);
  const videoProfileRef = useRef<VideoProfile>({ resolution: 720, fps: 30 });
  const profileRequestRef = useRef(0);
  const stoppingRef = useRef(false);
  const connectionTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const screenAudioTracksRef = useRef<MediaStreamTrack[]>([]);
  const microphoneTrackRef = useRef<MediaStreamTrack | null>(null);
  const microphoneSourceStreamRef = useRef<MediaStream | null>(null);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneGainRef = useRef<GainNode | null>(null);
  const videoPausedRef = useRef(false);
  const audioEnabledRef = useRef(true);
  const microphoneEnabledRef = useRef(false);
  const inputVolumeRef = useRef(100);
  const outputVolumeRef = useRef(100);
  const viewerVolumesRef = useRef<Record<string, number>>({});
  const viewerLabelsRef = useRef(new Map<string, number>());
  const nextViewerLabelRef = useRef(1);
  const automaticQualityRef = useRef(true);
  const manualProfileRef = useRef<VideoProfile>({ resolution: 720, fps: 30 });
  const maxViewersRef = useRef<(typeof VIEWER_LIMITS)[number]>(1);
  const previousStatsRef = useRef<{ bytes: number; at: number } | null>(null);
  const handleSignalRef = useRef<(message: ServerMessage) => Promise<void>>(async () => undefined);
  const connectHostSignalRef = useRef<() => void>(() => undefined);
  const stopSharingRef = useRef<() => void>(() => {});

  const [status, setStatus] = useState<HostStatus>('idle');
  const [audience, setAudience] = useState<AudienceStatus>('empty');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [resolution, setResolution] = useState<Resolution>(720);
  const [fps, setFps] = useState<FrameRate>(30);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('idle');
  const [automaticQuality, setAutomaticQuality] = useState(true);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>('waiting');
  const [connectionMetrics, setConnectionMetrics] = useState<ConnectionMetrics>({ bitrateKbps: 0, availableKbps: 0, rttMs: 0, packetLoss: 0 });
  const [maxViewers, setMaxViewers] = useState<(typeof VIEWER_LIMITS)[number]>(1);
  const [viewerCount, setViewerCount] = useState(0);
  const [connectedViewerCount, setConnectedViewerCount] = useState(0);
  const [turnAvailable, setTurnAvailable] = useState(false);
  const [videoPaused, setVideoPaused] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [microphoneAvailable, setMicrophoneAvailable] = useState<boolean | null>(null);
  const [panelSection, setPanelSection] = useState<HostPanel>('stream');
  const [inputVolume, setInputVolume] = useState(100);
  const [outputVolume, setOutputVolume] = useState(100);
  const [viewerIds, setViewerIds] = useState<string[]>([]);
  const [viewerVolumes, setViewerVolumes] = useState<Record<string, number>>({});
  const [qrCode, setQrCode] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const sessionDuration = useSessionDuration(sessionStartedAt);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/runtime-config', { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<RuntimeConfig> : Promise.reject(new Error('Runtime configuration unavailable')))
      .then(configuration => {
        if (configuration.viewerOrigin) viewerOriginRef.current = configuration.viewerOrigin;
        setTurnAvailable(Boolean(configuration.turnEnabled));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
  useEffect(() => { microphoneEnabledRef.current = microphoneEnabled; }, [microphoneEnabled]);
  useEffect(() => { videoPausedRef.current = videoPaused; }, [videoPaused]);
  useEffect(() => { automaticQualityRef.current = automaticQuality; }, [automaticQuality]);
  useEffect(() => { maxViewersRef.current = maxViewers; }, [maxViewers]);

  useEffect(() => {
    let active = true;
    if (!shareUrl) {
      setQrCode('');
      setQrOpen(false);
      return;
    }
    void QRCode.toDataURL(shareUrl, {
      width: 360,
      margin: 2,
      color: { dark: '#090909', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    }).then(value => { if (active) setQrCode(value); }).catch(() => { if (active) setQrCode(''); });
    return () => { active = false; };
  }, [shareUrl]);

  useEffect(() => {
    if (!qrOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQrOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [qrOpen]);

  const syncAudience = useCallback(() => {
    const peers = [...peersRef.current.values()];
    const connected = peers.filter(peer => peer.pc.connectionState === 'connected').length;
    setViewerIds(peers.map(peer => peer.id));
    setViewerCount(peers.length);
    setConnectedViewerCount(connected);
    setAudience(connected > 0 ? 'connected' : peers.length > 0 ? 'connecting' : 'empty');
  }, []);

  const applyViewerVolume = useCallback((peerId: string) => {
    const audio = peersRef.current.get(peerId)?.remoteAudio;
    if (!audio) return;
    const individualVolume = viewerVolumesRef.current[peerId] ?? 100;
    audio.volume = Math.min(1, (outputVolumeRef.current / 100) * (individualVolume / 100));
  }, []);

  const changeOutputVolume = useCallback((value: number) => {
    outputVolumeRef.current = value;
    setOutputVolume(value);
    for (const peerId of peersRef.current.keys()) applyViewerVolume(peerId);
  }, [applyViewerVolume]);

  const changeViewerVolume = useCallback((peerId: string, value: number) => {
    viewerVolumesRef.current = { ...viewerVolumesRef.current, [peerId]: value };
    setViewerVolumes(viewerVolumesRef.current);
    applyViewerVolume(peerId);
  }, [applyViewerVolume]);

  const changeInputVolume = useCallback((value: number) => {
    inputVolumeRef.current = value;
    setInputVolume(value);
    const context = microphoneAudioContextRef.current;
    const gain = microphoneGainRef.current;
    if (context && gain) gain.gain.setTargetAtTime(value / 100, context.currentTime, .015);
  }, []);

  const disposeMicrophonePipeline = useCallback(() => {
    stopStream(microphoneSourceStreamRef.current);
    microphoneSourceStreamRef.current = null;
    microphoneGainRef.current = null;
    const context = microphoneAudioContextRef.current;
    microphoneAudioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }, []);

  const destroyPeer = useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    peersRef.current.delete(peerId);
    closePeer(peer);
    syncAudience();
  }, [syncAudience]);

  const destroyAllPeers = useCallback(() => {
    for (const peer of peersRef.current.values()) closePeer(peer);
    peersRef.current.clear();
    viewerLabelsRef.current.clear();
    nextViewerLabelRef.current = 1;
    viewerVolumesRef.current = {};
    setViewerVolumes({});
    syncAudience();
  }, [syncAudience]);

  const clearConnectionTimer = useCallback(() => {
    if (connectionTimerRef.current !== null) {
      window.clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const broadcastMediaState = useCallback((overrides: Partial<{
    videoPaused: boolean;
    screenAudioEnabled: boolean;
    microphoneEnabled: boolean;
  }> = {}) => {
    for (const peerId of peersRef.current.keys()) {
      send(socketRef.current, {
        type: 'media-state',
        peerId,
        videoPaused: overrides.videoPaused ?? videoPausedRef.current,
        screenAudioEnabled: overrides.screenAudioEnabled ?? audioEnabledRef.current,
        microphoneEnabled: overrides.microphoneEnabled ?? microphoneEnabledRef.current
      });
    }
  }, []);

  const applyVideoProfile = useCallback(async (profile: VideoProfile) => {
    videoProfileRef.current = profile;
    setResolution(profile.resolution);
    setFps(profile.fps);
    const stream = streamRef.current;
    if (!stream) {
      setProfileStatus('idle');
      return;
    }

    const requestId = ++profileRequestRef.current;
    setProfileStatus('applying');
    const settings = videoSettings(profile);
    try {
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Video track unavailable');
      track.contentHint = profile.fps >= 45 ? 'motion' : 'detail';
      await track.applyConstraints({
        width: { ideal: settings.width, max: settings.width },
        height: { ideal: settings.height, max: settings.height },
        frameRate: { ideal: settings.fps, max: settings.fps }
      });
      await Promise.all([...peersRef.current.values()].map(async peer => {
        const sender = peer.pc.getSenders().find(candidate => candidate.track?.kind === 'video');
        if (sender) await configureVideoSender(sender, profile);
      }));
      if (profileRequestRef.current === requestId) setProfileStatus('applied');
    } catch {
      if (profileRequestRef.current === requestId) setProfileStatus('error');
    }
  }, []);

  const selectManualProfile = useCallback((profile: VideoProfile) => {
    manualProfileRef.current = profile;
    void applyVideoProfile(profile);
  }, [applyVideoProfile]);

  const toggleAutomaticQuality = useCallback(() => {
    const nextAutomatic = !automaticQualityRef.current;
    automaticQualityRef.current = nextAutomatic;
    setAutomaticQuality(nextAutomatic);
    if (!nextAutomatic) void applyVideoProfile(manualProfileRef.current);
  }, [applyVideoProfile]);

  const toggleScreenAudio = useCallback(() => {
    const nextEnabled = !audioEnabledRef.current;
    if (!streamRef.current) {
      audioEnabledRef.current = nextEnabled;
      setAudioEnabled(nextEnabled);
      return;
    }
    const audioTracks = screenAudioTracksRef.current;
    if (!audioTracks.length) {
      setAudioAvailable(false);
      return;
    }
    for (const track of audioTracks) track.enabled = nextEnabled;
    audioEnabledRef.current = nextEnabled;
    setAudioEnabled(nextEnabled);
    broadcastMediaState({ screenAudioEnabled: nextEnabled });
  }, [broadcastMediaState]);

  const toggleMicrophone = useCallback(() => {
    const nextEnabled = !microphoneEnabledRef.current;
    if (!streamRef.current) {
      microphoneEnabledRef.current = nextEnabled;
      setMicrophoneEnabled(nextEnabled);
      return;
    }
    const track = microphoneTrackRef.current;
    if (!track) {
      setMicrophoneAvailable(false);
      return;
    }
    track.enabled = nextEnabled;
    microphoneEnabledRef.current = nextEnabled;
    setMicrophoneEnabled(nextEnabled);
    broadcastMediaState({ microphoneEnabled: nextEnabled });
  }, [broadcastMediaState]);

  const toggleVideoPaused = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const nextPaused = !videoPausedRef.current;
    for (const track of stream.getVideoTracks()) track.enabled = !nextPaused;
    videoPausedRef.current = nextPaused;
    setVideoPaused(nextPaused);
    broadcastMediaState({ videoPaused: nextPaused });
  }, [broadcastMediaState]);

  const failSession = useCallback((message: string) => {
    stoppingRef.current = true;
    clearConnectionTimer();
    clearReconnectTimer();
    destroyAllPeers();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Session failed');
    stopStream(streamRef.current);
    disposeMicrophonePipeline();
    streamRef.current = null;
    setLocalStream(null);
    setSourceLabel('');
    inviteRef.current = null;
    setShareUrl('');
    setProfileStatus('idle');
    screenAudioTracksRef.current = [];
    microphoneTrackRef.current = null;
    videoPausedRef.current = false;
    setVideoPaused(false);
    setAudioAvailable(null);
    setMicrophoneAvailable(null);
    setConnectionQuality('waiting');
    setSessionStartedAt(null);
    setError(message);
    setStatus('error');
  }, [clearConnectionTimer, clearReconnectTimer, destroyAllPeers, disposeMicrophonePipeline]);

  const stopSharing = useCallback(() => {
    stoppingRef.current = true;
    clearConnectionTimer();
    clearReconnectTimer();
    send(socketRef.current, { type: 'leave-room' });
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Host ended');
    destroyAllPeers();
    stopStream(streamRef.current);
    disposeMicrophonePipeline();
    streamRef.current = null;
    inviteRef.current = null;
    setLocalStream(null);
    setSourceLabel('');
    setShareUrl('');
    setCopied(false);
    setProfileStatus('idle');
    screenAudioTracksRef.current = [];
    microphoneTrackRef.current = null;
    videoPausedRef.current = false;
    setVideoPaused(false);
    setAudioAvailable(null);
    setMicrophoneAvailable(null);
    setConnectionQuality('waiting');
    setConnectionMetrics({ bitrateKbps: 0, availableKbps: 0, rttMs: 0, packetLoss: 0 });
    setSessionStartedAt(null);
    setError('');
    setStatus('idle');
  }, [clearConnectionTimer, clearReconnectTimer, destroyAllPeers, disposeMicrophonePipeline]);
  stopSharingRef.current = stopSharing;

  const createPeerForViewer = useCallback(async (peerId: string, force = false) => {
    const stream = streamRef.current;
    if (!stream) return;

    const existing = peersRef.current.get(peerId);
    if (existing && !force && existing.pc.connectionState !== 'failed' && existing.pc.connectionState !== 'closed') {
      const pendingOffer = existing.pc.localDescription;
      if (existing.pc.signalingState === 'have-local-offer' && pendingOffer?.type === 'offer') {
        send(socketRef.current, { type: 'offer', peerId, sdp: pendingOffer });
        broadcastMediaState();
      }
      syncAudience();
      return;
    }
    if (existing) destroyPeer(peerId);

    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current as RTCIceServer[],
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4
    });
    if (!viewerLabelsRef.current.has(peerId)) {
      viewerLabelsRef.current.set(peerId, nextViewerLabelRef.current++);
    }
    if (viewerVolumesRef.current[peerId] === undefined) {
      viewerVolumesRef.current = { ...viewerVolumesRef.current, [peerId]: 100 };
      setViewerVolumes(viewerVolumesRef.current);
    }
    const record: PeerRecord = { id: peerId, pc, queued: [], remoteAudio: null };
    peersRef.current.set(peerId, record);
    syncAudience();

    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === 'video') {
        track.contentHint = videoProfileRef.current.fps >= 45 ? 'motion' : 'detail';
        await configureVideoSender(sender, videoProfileRef.current).catch(() => undefined);
      }
    }

    pc.onicecandidate = event => {
      if (event.candidate) {
        send(socketRef.current, { type: 'ice-candidate', peerId, candidate: event.candidate.toJSON() });
      }
    };
    pc.ontrack = event => {
      if (event.track.kind !== 'audio') return;
      if (record.remoteAudio) {
        const previousStream = record.remoteAudio.srcObject instanceof MediaStream ? record.remoteAudio.srcObject : null;
        previousStream?.getTracks().forEach(track => track.stop());
        record.remoteAudio.srcObject = null;
        record.remoteAudio.remove();
      }
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = new MediaStream([event.track]);
      audio.dataset.screenlinkViewer = peerId;
      audio.style.display = 'none';
      document.body.append(audio);
      record.remoteAudio = audio;
      applyViewerVolume(peerId);
      syncAudience();
      event.track.addEventListener('ended', () => {
        if (record.remoteAudio !== audio) return;
        audio.srcObject = null;
        audio.remove();
        record.remoteAudio = null;
        syncAudience();
      }, { once: true });
      void audio.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnectionQuality('good');
      }
      syncAudience();
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (pc.connectionState === 'failed') setConnectionQuality('blocked');
        if (peersRef.current.get(peerId)?.pc === pc) destroyPeer(peerId);
      }
    };

    const offer = await pc.createOffer({ iceRestart: force });
    await pc.setLocalDescription(offer);
    send(socketRef.current, { type: 'offer', peerId, sdp: offer });
    broadcastMediaState();
  }, [applyViewerVolume, broadcastMediaState, destroyPeer, syncAudience]);

  const handleSignal = useCallback(async (message: ServerMessage) => {
    if (message.type === 'room-created') {
      clearConnectionTimer();
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      iceServersRef.current = message.iceServers;
      setTurnAvailable(message.iceServers.some(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some(url => /^turns?:/i.test(url));
      }));
      if (VIEWER_LIMITS.includes(message.maxViewers as (typeof VIEWER_LIMITS)[number])) {
        const acceptedLimit = message.maxViewers as (typeof VIEWER_LIMITS)[number];
        maxViewersRef.current = acceptedLimit;
        setMaxViewers(acceptedLimit);
      }
      const serverViewers = new Set(message.viewerIds);
      for (const peerId of [...peersRef.current.keys()]) {
        if (!serverViewers.has(peerId)) destroyPeer(peerId);
      }
      for (const peerId of message.viewerIds) {
        const peer = peersRef.current.get(peerId);
        if (!peer || peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed' || peer.pc.connectionState === 'disconnected') {
          await createPeerForViewer(peerId, Boolean(peer));
        }
      }
      setStatus('live');
      setError('');
      setSessionStartedAt(current => current ?? Date.now());
      syncAudience();
      return;
    }
    if (message.type === 'viewer-joined') {
      const peer = peersRef.current.get(message.peerId);
      const shouldRebuild = Boolean(peer && (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed' || peer.pc.connectionState === 'disconnected'));
      await createPeerForViewer(message.peerId, shouldRebuild);
      return;
    }
    if (message.type === 'viewer-left') {
      destroyPeer(message.peerId);
      return;
    }
    if (message.type === 'offer') {
      const peer = peersRef.current.get(message.peerId);
      if (!peer) return;
      if (peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }
      await peer.pc.setRemoteDescription(message.sdp);
      for (const candidate of peer.queued.splice(0)) {
        await peer.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      send(socketRef.current, { type: 'answer', peerId: message.peerId, sdp: answer });
      return;
    }
    if (message.type === 'answer') {
      const peer = peersRef.current.get(message.peerId);
      if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription(message.sdp);
      for (const candidate of peer.queued.splice(0)) {
        await peer.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      return;
    }
    if (message.type === 'ice-candidate') {
      const peer = peersRef.current.get(message.peerId);
      if (!peer) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate).catch(() => undefined);
      else peer.queued.push(message.candidate);
      return;
    }
    if (message.type === 'error') {
      if (message.code === 'PEER_OFFLINE') {
        setError('Um espectador está temporariamente em segundo plano. A transmissão continuará e tentará recuperar a sinalização.');
        return;
      }
      failSession(message.message);
    }
  }, [clearConnectionTimer, clearReconnectTimer, createPeerForViewer, destroyPeer, failSession, syncAudience]);
  handleSignalRef.current = handleSignal;

  const connectHostSignal = useCallback(() => {
    const invite = inviteRef.current;
    if (!invite || !streamRef.current || stoppingRef.current) return;

    clearConnectionTimer();
    const previousSocket = socketRef.current;
    socketRef.current = null;
    if (previousSocket?.readyState === WebSocket.OPEN || previousSocket?.readyState === WebSocket.CONNECTING) {
      previousSocket.close(1000, 'Replacing connection');
    }

    const socket = new WebSocket(signalUrl());
    socketRef.current = socket;
    setStatus(reconnectAttemptRef.current ? 'reconnecting' : 'starting');
    if (reconnectAttemptRef.current) setError('Reconectando ao serviço sem interromper sua tela…');

    connectionTimerRef.current = window.setTimeout(() => {
      if (socketRef.current === socket && socket.readyState !== WebSocket.OPEN) {
        socket.close(4000, 'Signal timeout');
      }
    }, 12_000);

    socket.onopen = () => send(socket, { type: 'create-room', ...invite, maxViewers: maxViewersRef.current });
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        void handleSignalRef.current(message).catch(() => {
          setError('A negociação do vídeo falhou. Aguardando uma nova tentativa do espectador.');
        });
      } catch {
        setError('O serviço respondeu de forma inesperada. Reconectando…');
        socket.close(4000, 'Invalid response');
      }
    };
    socket.onerror = () => setError('O serviço de conexão está temporariamente indisponível.');
    socket.onclose = event => {
      clearConnectionTimer();
      if (socketRef.current === socket) socketRef.current = null;
      if (stoppingRef.current || event.code === 1000) return;
      setStatus('reconnecting');
      const delay = Math.min(8_000, 600 * 2 ** Math.min(reconnectAttemptRef.current++, 4));
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connectHostSignalRef.current();
      }, delay);
    };
  }, [clearConnectionTimer, clearReconnectTimer]);
  connectHostSignalRef.current = connectHostSignal;

  const startSharing = useCallback(async () => {
    setError('');
    setCopied(false);
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Use Chrome ou Edge no computador para compartilhar a tela.');
      setStatus('error');
      return;
    }

    stoppingRef.current = false;
    setStatus('starting');
    try {
      const selectedProfile = videoProfileRef.current;
      const selectedSettings = videoSettings(selectedProfile);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: selectedSettings.width, max: selectedSettings.width },
          height: { ideal: selectedSettings.height, max: selectedSettings.height },
          frameRate: { ideal: selectedSettings.fps, max: selectedSettings.fps }
        },
        audio: audioEnabledRef.current
      });
      stream.getVideoTracks()[0]!.contentHint = selectedProfile.fps >= 45 ? 'motion' : 'detail';
      const capturedAudio = stream.getAudioTracks();
      screenAudioTracksRef.current = capturedAudio;
      setAudioAvailable(capturedAudio.length > 0);
      for (const track of capturedAudio) track.enabled = audioEnabledRef.current;

      if (microphoneEnabledRef.current && navigator.mediaDevices?.getUserMedia) {
        try {
          const microphoneStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
          microphoneSourceStreamRef.current = microphoneStream;
          const sourceTrack = microphoneStream.getAudioTracks()[0] ?? null;
          let microphoneTrack = sourceTrack;
          if (sourceTrack) {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(new MediaStream([sourceTrack]));
            const gain = audioContext.createGain();
            const destination = audioContext.createMediaStreamDestination();
            gain.gain.value = inputVolumeRef.current / 100;
            source.connect(gain).connect(destination);
            microphoneAudioContextRef.current = audioContext;
            microphoneGainRef.current = gain;
            microphoneTrack = destination.stream.getAudioTracks()[0] ?? sourceTrack;
            void audioContext.resume().catch(() => undefined);
          }
          microphoneTrackRef.current = microphoneTrack;
          setMicrophoneAvailable(Boolean(microphoneTrack));
          if (microphoneTrack) stream.addTrack(microphoneTrack);
        } catch {
          disposeMicrophonePipeline();
          microphoneTrackRef.current = null;
          microphoneEnabledRef.current = false;
          setMicrophoneEnabled(false);
          setMicrophoneAvailable(false);
        }
      } else {
        microphoneTrackRef.current = null;
        setMicrophoneAvailable(null);
      }

      streamRef.current = stream;
      setLocalStream(stream);
      setSourceLabel(stream.getVideoTracks()[0]?.label || 'Tela ou janela selecionada');
      videoPausedRef.current = false;
      setVideoPaused(false);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopSharingRef.current(), { once: true });

      const invite = createPrivateRoom();
      inviteRef.current = invite;
      setShareUrl(inviteUrl(invite, viewerOriginRef.current));
      reconnectAttemptRef.current = 0;
      connectHostSignalRef.current();
    } catch (reason) {
      if ((reason as DOMException)?.name === 'NotAllowedError') {
        setStatus('idle');
      } else {
        failSession('Não foi possível iniciar o compartilhamento. Tente novamente.');
      }
    }
  }, [disposeMicrophonePipeline, failSession]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    const resumeViewerAudio = () => {
      const microphoneContext = microphoneAudioContextRef.current;
      if (microphoneContext?.state === 'suspended') void microphoneContext.resume().catch(() => undefined);
      for (const peer of peersRef.current.values()) {
        if (peer.remoteAudio) void peer.remoteAudio.play().catch(() => undefined);
      }
    };
    window.addEventListener('pointerdown', resumeViewerAudio, { passive: true });
    return () => window.removeEventListener('pointerdown', resumeViewerAudio);
  }, []);

  useEffect(() => {
    if (!localStream) {
      previousStatsRef.current = null;
      return;
    }

    let active = true;
    let adapting = false;
    const sample = async () => {
      const connectedPeers = [...peersRef.current.values()].filter(peer => peer.pc.connectionState === 'connected');
      if (!connectedPeers.length) {
        if (active) setConnectionQuality('waiting');
        return;
      }
      try {
        let bytes = 0;
        let rttMs = 0;
        let packetLoss = 0;
        const capacities: number[] = [];
        await Promise.all(connectedPeers.map(async peer => {
          const report = await peer.pc.getStats();
          report.forEach(stat => {
            if (stat.type === 'outbound-rtp' && stat.kind === 'video' && !stat.isRemote) bytes += Number(stat.bytesSent || 0);
            if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
              packetLoss = Math.max(packetLoss, Number(stat.fractionLost || 0) * 100);
              if (stat.roundTripTime) rttMs = Math.max(rttMs, Number(stat.roundTripTime) * 1_000);
            }
            if (stat.type === 'candidate-pair' && (stat.selected || stat.nominated)) {
              if (stat.currentRoundTripTime) rttMs = Math.max(rttMs, Number(stat.currentRoundTripTime) * 1_000);
              if (stat.availableOutgoingBitrate) capacities.push(Math.round(Number(stat.availableOutgoingBitrate) / 1_000));
            }
          });
        }));
        const availableKbps = capacities.length
          ? Math.max(1, Math.floor(Math.min(...capacities) / connectedPeers.length))
          : 0;
        const now = performance.now();
        const previous = previousStatsRef.current;
        const bitrateKbps = previous && now > previous.at
          ? Math.max(0, Math.round(((bytes - previous.bytes) * 8) / (now - previous.at)))
          : 0;
        previousStatsRef.current = { bytes, at: now };
        const metrics = { bitrateKbps, availableKbps, rttMs: Math.round(rttMs), packetLoss: Math.round(packetLoss * 10) / 10 };
        if (!active) return;
        setConnectionMetrics(metrics);
        setConnectionQuality(classifyConnection(metrics));

        if (automaticQualityRef.current && !adapting) {
          const target = automaticProfile(metrics);
          const current = videoProfileRef.current;
          if (target.resolution !== current.resolution || target.fps !== current.fps) {
            adapting = true;
            await applyVideoProfile(target);
            adapting = false;
          }
        }
      } catch {
        if (active) setConnectionQuality('good');
      }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      previousStatsRef.current = null;
    };
  }, [applyVideoProfile, localStream]);

  useEffect(() => {
    const recoverSignaling = () => {
      if (!streamRef.current || stoppingRef.current) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      clearReconnectTimer();
      connectHostSignalRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recoverSignaling();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', recoverSignaling);
    window.addEventListener('online', recoverSignaling);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', recoverSignaling);
      window.removeEventListener('online', recoverSignaling);
    };
  }, [clearReconnectTimer]);

  useEffect(() => () => {
    stoppingRef.current = true;
    clearConnectionTimer();
    clearReconnectTimer();
    send(socketRef.current, { type: 'leave-room' });
    socketRef.current?.close(1000, 'Page closed');
    for (const peer of peersRef.current.values()) closePeer(peer);
    peersRef.current.clear();
    stopStream(streamRef.current);
    disposeMicrophonePipeline();
  }, [clearConnectionTimer, clearReconnectTimer, disposeMicrophonePipeline]);

  useEffect(() => {
    const modelContext = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    const safeRegister = (tool: Parameters<ModelContext['registerTool']>[0]) => {
      try {
        void Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
      } catch {
        // WebMCP is optional and must never interfere with screen sharing.
      }
    };

    safeRegister({
      name: 'read_screenlink_status',
      title: 'Read ScreenLink status',
      description: 'Read whether this computer is sharing and whether a viewer is connected.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ sharing: status === 'live', viewer: audience })
    });
    safeRegister({
      name: 'stop_screen_share',
      title: 'Stop screen sharing',
      description: 'End the active ScreenLink transmission on this computer.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => {
        if (status !== 'live') throw new Error('No ScreenLink transmission is active.');
        stopSharing();
        return { sharing: false };
      }
    });
    return () => lifecycle.abort();
  }, [audience, status, stopSharing]);

  async function copyInvite() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      inviteInputRef.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  async function shareInvite() {
    if (!shareUrl || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({
        title: 'Assistir no ScreenLink',
        text: 'Abra este link privado para assistir à minha tela:',
        url: shareUrl
      });
    } catch {
      // Cancelar a folha de compartilhamento não altera a sessão.
    }
  }

  const hostLabel = status === 'starting'
    ? 'Preparando'
    : status === 'reconnecting'
      ? 'Reconectando'
      : status === 'live'
        ? videoPaused ? 'Pausado' : 'Sessão ativa'
        : status === 'error' ? 'Atenção' : 'Pronto';
  const audienceCopy = connectedViewerCount > 0
    ? `${connectedViewerCount} espectador${connectedViewerCount === 1 ? '' : 'es'} conectado${connectedViewerCount === 1 ? '' : 's'} · limite ${maxViewers}`
    : audience === 'connecting'
      ? `${viewerCount || 1} espectador${viewerCount === 1 ? '' : 'es'} conectando…`
      : `Aguardando espectadores · limite ${maxViewers}`;
  const qualityCopy = connectionQuality === 'excellent'
    ? 'Conexão excelente'
    : connectionQuality === 'good'
      ? 'Conexão estável'
      : connectionQuality === 'limited'
        ? 'Rede limitada — reduzindo qualidade'
        : connectionQuality === 'blocked'
          ? 'A rede bloqueou a conexão direta'
          : 'Aguardando dados da conexão';
  const metricCopy = connectionMetrics.bitrateKbps
    ? `${(connectionMetrics.bitrateKbps / 1_000).toFixed(1)} Mbps · ${connectionMetrics.rttMs || '—'} ms`
    : 'WebRTC P2P direto';
  const screenAudioCopy = !localStream
    ? audioEnabled ? 'Solicitar ao escolher a tela' : 'Começar sem som do sistema'
    : audioAvailable
      ? audioEnabled ? 'Som da tela sendo enviado' : 'Som da tela silenciado'
      : 'Fonte selecionada sem áudio';
  const microphoneCopy = !localStream
    ? microphoneEnabled ? 'Solicitar antes de transmitir' : 'Desativado por padrão'
    : microphoneAvailable
      ? microphoneEnabled ? 'Sua voz está sendo enviada' : 'Microfone silenciado'
      : 'Permissão não concedida';
  const viewerMixer = viewerIds.map((peerId, index) => {
    const peer = peersRef.current.get(peerId);
    return {
      id: peerId,
      label: `Espectador ${viewerLabelsRef.current.get(peerId) ?? index + 1}`,
      connected: peer?.pc.connectionState === 'connected',
      hasAudio: Boolean(peer?.remoteAudio),
      volume: viewerVolumes[peerId] ?? 100
    };
  });
  const viewerAudioCount = viewerMixer.filter(viewer => viewer.hasAudio).length;

  return (
    <div className="app">
      <Header
        status={hostLabel}
        live={status === 'live'}
        meta={localStream ? `${sessionDuration} · ${connectedViewerCount}/${maxViewers} assistindo` : 'Sessão privada · P2P'}
      />
      <main className="host-main">
        <section className={`share-stage ${localStream ? 'is-live' : ''} ${videoPaused ? 'is-paused' : ''}`}>
          <video ref={videoRef} autoPlay playsInline muted />
          {!localStream && (
            <div className="stage-empty">
              <ScreenLinkMascot />
              <span className="eyebrow">Nenhuma fonte selecionada</span>
              <h1>Escolha uma tela ou janela</h1>
              <p>Você confere a prévia aqui antes de enviar o link aos espectadores.</p>
              <button className="primary-action" type="button" onClick={startSharing} disabled={status === 'starting'}>
                <Icon name="screen" /> {status === 'starting' ? 'Abrindo seletor…' : 'Escolher tela'}
              </button>
              <small className="stage-note"><Icon name="shield" /> Transmissão direta, privada e sem gravação.</small>
              {error && <p className="error-message" role="alert">{error}</p>}
            </div>
          )}
          {localStream && (
            <>
              <div className={`live-badge ${videoPaused ? 'paused' : ''}`}>{videoPaused ? 'Transmissão pausada' : `${resolution}p · até ${fps} FPS`} · {sessionDuration}</div>
              <div className="source-live-chip"><Icon name="screen" /><span><strong>{sourceLabel}</strong></span></div>
              <div className="host-call-dock" aria-label="Controles da transmissão">
                <button type="button" onClick={toggleVideoPaused} aria-label={videoPaused ? 'Retomar transmissão' : 'Pausar transmissão'} aria-pressed={videoPaused} data-label={videoPaused ? 'Retomar' : 'Pausar'}>
                  <Icon name={videoPaused ? 'play' : 'pause'} />
                </button>
                <button className={audioEnabled && audioAvailable !== false ? 'is-on' : ''} type="button" onClick={toggleScreenAudio} aria-label={audioEnabled ? 'Silenciar áudio da tela' : 'Ativar áudio da tela'} aria-pressed={audioEnabled && audioAvailable !== false} data-label="Áudio" disabled={audioAvailable === false}>
                  <Icon name={audioEnabled && audioAvailable !== false ? 'volume' : 'volumeOff'} />
                </button>
                <button className={microphoneEnabled && microphoneAvailable !== false ? 'is-on' : ''} type="button" onClick={toggleMicrophone} aria-label={microphoneEnabled ? 'Silenciar microfone' : 'Ativar microfone'} aria-pressed={microphoneEnabled && microphoneAvailable !== false} data-label="Microfone" disabled={microphoneAvailable !== true}>
                  <Icon name={microphoneEnabled && microphoneAvailable !== false ? 'microphone' : 'microphoneOff'} />
                </button>
                <span />
                <button className="hangup" type="button" onClick={stopSharing} aria-label="Encerrar compartilhamento" data-label="Encerrar"><Icon name="stop" /></button>
              </div>
            </>
          )}
        </section>

        <aside className="control-panel">
          <header className="panel-header">
            <div><h2>Controles</h2></div>
            <span className="audience-count">{connectedViewerCount}/{maxViewers}</span>
          </header>

          <nav className="panel-tabs" role="tablist" aria-label="Seções dos controles">
            <button type="button" role="tab" aria-selected={panelSection === 'stream'} aria-controls="stream-panel" className={panelSection === 'stream' ? 'is-active' : ''} onClick={() => setPanelSection('stream')}>Transmissão</button>
            <button type="button" role="tab" aria-selected={panelSection === 'audio'} aria-controls="audio-panel" className={panelSection === 'audio' ? 'is-active' : ''} onClick={() => setPanelSection('audio')}>Áudio <span>{viewerAudioCount}</span></button>
          </nav>

          <div className="panel-view">
            {panelSection === 'stream' && (
              <div id="stream-panel" role="tabpanel" className="panel-page">
                <section className="panel-section source-section" aria-labelledby="source-title">
                  <div className="section-heading"><h3 id="source-title">Fonte</h3><small>{localStream ? 'ATIVA' : 'NÃO SELECIONADA'}</small></div>
                  <div className="source-row">
                    <Icon name="screen" />
                    <span><strong>{localStream ? sourceLabel : 'Tela, janela ou aba'}</strong><small>{localStream ? 'Prévia visível neste computador' : 'Escolhida ao iniciar'}</small></span>
                  </div>
                </section>

                <section className="panel-section quality-section" aria-labelledby="quality-title">
                  <div className="section-heading"><h3 id="quality-title">Qualidade</h3><small>{automaticQuality ? 'AUTOMÁTICA' : 'MANUAL'}</small></div>
                  <ToggleRow
                    icon="auto"
                    label="Ajuste automático"
                    description={`${resolution}p · até ${fps} FPS`}
                    checked={automaticQuality}
                    onClick={toggleAutomaticQuality}
                  />
                  <div className="quality-controls">
                    <SegmentedControl label="Resolução" suffix="resolução" options={RESOLUTIONS} value={resolution} disabled={profileStatus === 'applying' || automaticQuality} onChange={nextResolution => selectManualProfile({ resolution: nextResolution, fps })} />
                    <SegmentedControl label="Fluidez" suffix="FPS" options={FRAME_RATES} value={fps} disabled={profileStatus === 'applying' || automaticQuality} onChange={nextFps => selectManualProfile({ resolution, fps: nextFps })} />
                    <SegmentedControl label="Espectadores" suffix="máximo" options={VIEWER_LIMITS} value={maxViewers} disabled={Boolean(localStream)} onChange={setMaxViewers} />
                  </div>
                  <p className={`profile-summary ${profileStatus}`} aria-live="polite"><i />{profileStatus === 'applying' ? 'Aplicando…' : profileStatus === 'error' ? 'Modo compatível mantido' : 'Bitrate adaptativo ativo'}</p>
                </section>

                <section className="panel-section invite-section" aria-labelledby="invite-title">
                  <div className="section-heading"><h3 id="invite-title">Convite</h3><small>{shareUrl ? audienceCopy : 'APÓS INICIAR'}</small></div>
                  {shareUrl ? (
                    <>
                      <div className="invite-row">
                        <input id="invite-link" ref={inviteInputRef} aria-label="Link privado para assistir" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
                        <button type="button" onClick={copyInvite} aria-label="Copiar link privado"><Icon name={copied ? 'check' : 'copy'} /></button>
                      </div>
                      <div className="invite-actions">
                        <button type="button" onClick={() => setQrOpen(true)} disabled={!qrCode}><Icon name="qr" /> QR Code</button>
                        {typeof navigator.share === 'function' && <button type="button" onClick={shareInvite}><Icon name="share" /> Compartilhar</button>}
                      </div>
                      <div className={`connection-row ${connectionQuality}`}><Icon name="signal" /><span><strong>{qualityCopy}</strong><small>{audience === 'connected' ? metricCopy : `P2P + STUN${turnAvailable ? '/TURN' : ''}`}</small></span></div>
                    </>
                  ) : (
                    <p className="empty-row"><Icon name="link" /> O link e o QR Code aparecem aqui.</p>
                  )}
                </section>
              </div>
            )}

            {panelSection === 'audio' && (
              <div id="audio-panel" role="tabpanel" className="panel-page audio-page">
                <section className="panel-section" aria-labelledby="send-audio-title">
                  <div className="section-heading"><h3 id="send-audio-title">Áudio enviado</h3><small>PARA TODOS</small></div>
                  <ToggleRow icon={audioEnabled && audioAvailable !== false ? 'volume' : 'volumeOff'} label="Áudio da tela" description={screenAudioCopy} checked={audioEnabled && audioAvailable !== false} disabled={Boolean(localStream && audioAvailable === false)} onClick={toggleScreenAudio} />
                  <ToggleRow icon={microphoneEnabled && microphoneAvailable !== false ? 'microphone' : 'microphoneOff'} label="Microfone" description={microphoneCopy} checked={microphoneEnabled && microphoneAvailable !== false} disabled={Boolean(localStream && microphoneAvailable !== true)} onClick={toggleMicrophone} />
                  <VolumeControl id="input-volume" label="Volume de entrada" description="Ganho do seu microfone" value={inputVolume} onChange={changeInputVolume} />
                </section>

                <section className="panel-section mixer-section" aria-labelledby="mixer-title">
                  <div className="section-heading"><h3 id="mixer-title">Retorno dos espectadores</h3><small>{viewerAudioCount} COM ÁUDIO</small></div>
                  <VolumeControl id="output-volume" label="Volume de saída" description="Retorno geral neste computador" value={outputVolume} onChange={changeOutputVolume} />
                  <div className={`viewer-mixer ${viewerMixer.length > 5 ? 'is-dense' : ''}`}>
                    {viewerMixer.length ? viewerMixer.map(viewer => (
                      <VolumeControl
                        key={viewer.id}
                        id={`viewer-volume-${viewer.id}`}
                        label={viewer.label}
                        description={viewer.hasAudio ? viewer.connected ? 'Microfone conectado' : 'Conectando áudio…' : 'Microfone indisponível'}
                        value={viewer.volume}
                        disabled={!viewer.hasAudio}
                        onChange={value => changeViewerVolume(viewer.id, value)}
                      />
                    )) : <p className="empty-row"><Icon name="microphoneOff" /> Nenhum espectador conectado.</p>}
                  </div>
                </section>
              </div>
            )}
          </div>

          <footer className="panel-footer"><Icon name="shield" /><span>Conexão privada · nada é gravado</span></footer>
        </aside>
      </main>
      {qrOpen && qrCode && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setQrOpen(false)}>
          <section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title" onMouseDown={event => event.stopPropagation()}>
            <span className="eyebrow"><Icon name="phone" /> Abrir no celular</span>
            <h2 id="qr-title">Escaneie para assistir</h2>
            <p>O convite continua privado e aceita até {maxViewers} espectador{maxViewers === 1 ? '' : 'es'}.</p>
            <img src={qrCode} alt="QR Code do link privado da transmissão" />
            <button type="button" onClick={() => setQrOpen(false)}>Fechar</button>
          </section>
        </div>
      )}
    </div>
  );
}

function ViewerApp({ invite }: { invite: Invite }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const viewerSocketRef = useRef<WebSocket | null>(null);
  const viewerPeerRef = useRef<RTCPeerConnection | null>(null);
  const viewerPeerIdRef = useRef('');
  const viewerMicrophoneStreamRef = useRef<MediaStream | null>(null);
  const viewerMicrophoneTrackRef = useRef<MediaStreamTrack | null>(null);
  const viewerMicrophoneSenderRef = useRef<RTCRtpSender | null>(null);
  const ensureViewerMicrophoneRef = useRef<() => Promise<void>>(async () => undefined);
  const viewerMicrophoneEnabledRef = useRef(false);
  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [message, setMessage] = useState('Conectando ao computador…');
  const [hasAudio, setHasAudio] = useState(false);
  const [viewerMuted, setViewerMuted] = useState(true);
  const [streamDetails, setStreamDetails] = useState('');
  const [viewerQuality, setViewerQuality] = useState<ConnectionQuality>('waiting');
  const [viewerMetrics, setViewerMetrics] = useState<ConnectionMetrics>({ bitrateKbps: 0, availableKbps: 0, rttMs: 0, packetLoss: 0 });
  const [remotePaused, setRemotePaused] = useState(false);
  const [screenAudioActive, setScreenAudioActive] = useState(false);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [viewerMicrophoneEnabled, setViewerMicrophoneEnabled] = useState(false);
  const [viewerMicrophoneAvailable, setViewerMicrophoneAvailable] = useState<boolean | null>(null);
  const [viewerMicrophoneMessage, setViewerMicrophoneMessage] = useState('');
  const [zoom, setZoom] = useState(1);
  const [keepAwake, setKeepAwake] = useState(true);
  const [wakeActive, setWakeActive] = useState(false);
  const [viewerStartedAt, setViewerStartedAt] = useState<number | null>(null);
  const viewerDuration = useSessionDuration(viewerStartedAt);

  useEffect(() => {
    let disposed = false;
    let terminal = false;
    let attempt = 0;
    let peerFailures = 0;
    let reconnectTimer: number | null = null;
    let peerTimer: number | null = null;
    let statsTimer: number | null = null;
    let activeSocket: WebSocket | null = null;
    let peer: RTCPeerConnection | null = null;
    let remoteStream: MediaStream | null = null;
    let peerId = '';
    let initialNegotiationComplete = false;
    let microphoneRenegotiationPending = false;
    let queuedCandidates: RTCIceCandidateInit[] = [];
    let previousBytes: { bytes: number; at: number } | null = null;

    function clearPeerTimers() {
      if (peerTimer !== null) window.clearTimeout(peerTimer);
      if (statsTimer !== null) window.clearInterval(statsTimer);
      peerTimer = null;
      statsTimer = null;
    }

    function destroyViewerPeer() {
      clearPeerTimers();
      if (peer) {
        peer.ontrack = null;
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }
      peer = null;
      viewerPeerRef.current = null;
      viewerMicrophoneSenderRef.current = null;
      initialNegotiationComplete = false;
      microphoneRenegotiationPending = false;
      remoteStream = null;
      queuedCandidates = [];
      if (videoRef.current) videoRef.current.srcObject = null;
      setHasAudio(false);
      setViewerMuted(true);
      setStreamDetails('');
      setViewerQuality('waiting');
      setViewerMetrics({ bitrateKbps: 0, availableKbps: 0, rttMs: 0, packetLoss: 0 });
      setRemotePaused(false);
      setScreenAudioActive(false);
      setMicrophoneActive(false);
      previousBytes = null;
    }

    async function ensureViewerMicrophone() {
      const currentPeer = peer;
      const track = viewerMicrophoneTrackRef.current;
      const microphoneStream = viewerMicrophoneStreamRef.current;
      if (
        disposed ||
        !currentPeer ||
        !track ||
        !microphoneStream ||
        !viewerMicrophoneEnabledRef.current ||
        !initialNegotiationComplete ||
        activeSocket?.readyState !== WebSocket.OPEN ||
        currentPeer.signalingState !== 'stable'
      ) return;

      if (!viewerMicrophoneSenderRef.current) {
        viewerMicrophoneSenderRef.current = currentPeer.addTrack(track, microphoneStream);
        microphoneRenegotiationPending = true;
      }
      if (!microphoneRenegotiationPending) return;
      const offer = await currentPeer.createOffer();
      await currentPeer.setLocalDescription(offer);
      microphoneRenegotiationPending = false;
      send(activeSocket, { type: 'offer', peerId, sdp: offer });
    }
    ensureViewerMicrophoneRef.current = ensureViewerMicrophone;

    function retry(copy: string, resetPeer = false) {
      if (disposed || terminal || reconnectTimer !== null) return;
      if (resetPeer) destroyViewerPeer();
      const mediaAlive = peer?.connectionState === 'connected';
      if (!mediaAlive) {
        setStatus('connecting');
        setMessage(copy);
      }
      const delay = Math.min(5_000, 500 * 2 ** Math.min(attempt++, 4));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function failPermanently(copy: string) {
      terminal = true;
      destroyViewerPeer();
      setStatus('error');
      setMessage(copy);
      activeSocket?.close(1000, 'Terminal error');
    }

    function startViewerStats(currentPeer: RTCPeerConnection) {
      if (statsTimer !== null) return;
      const sample = async () => {
        try {
          const report = await currentPeer.getStats();
          let bytes = 0;
          let rttMs = 0;
          let packetLoss = 0;
          let framesPerSecond = 0;
          report.forEach(stat => {
            if (stat.type === 'inbound-rtp' && stat.kind === 'video' && !stat.isRemote) {
              bytes = Number(stat.bytesReceived || 0);
              packetLoss = Math.max(packetLoss, Number(stat.packetsLost || 0) > 0 && Number(stat.packetsReceived || 0) > 0
                ? (Number(stat.packetsLost) / (Number(stat.packetsLost) + Number(stat.packetsReceived))) * 100
                : 0);
              framesPerSecond = Number(stat.framesPerSecond || 0);
            }
            if (stat.type === 'candidate-pair' && (stat.selected || stat.nominated)) {
              if (stat.currentRoundTripTime) rttMs = Math.max(rttMs, Number(stat.currentRoundTripTime) * 1_000);
            }
          });
          const now = performance.now();
          const bitrateKbps = previousBytes && now > previousBytes.at
            ? Math.max(0, Math.round(((bytes - previousBytes.bytes) * 8) / (now - previousBytes.at)))
            : 0;
          previousBytes = { bytes, at: now };
          const metrics = {
            bitrateKbps,
            availableKbps: 0,
            rttMs: Math.round(rttMs),
            packetLoss: Math.round(packetLoss * 10) / 10
          };
          setViewerMetrics(metrics);
          setViewerQuality(classifyConnection(metrics));
          const height = videoRef.current?.videoHeight || remoteStream?.getVideoTracks()[0]?.getSettings().height;
          setStreamDetails([
            height ? `${height}p` : '',
            framesPerSecond ? `${Math.round(framesPerSecond)} FPS` : '',
            bitrateKbps ? `${(bitrateKbps / 1_000).toFixed(1)} Mbps` : ''
          ].filter(Boolean).join(' · '));
        } catch {
          // Estatísticas são complementares e não interrompem a reprodução.
        }
      };
      void sample();
      statsTimer = window.setInterval(() => void sample(), 2_000);
    }

    function connect() {
      if (disposed || terminal) return;
      if (activeSocket?.readyState === WebSocket.OPEN || activeSocket?.readyState === WebSocket.CONNECTING) return;
      const socket = new WebSocket(signalUrl());
      activeSocket = socket;
      viewerSocketRef.current = socket;
      if (peer?.connectionState !== 'connected') {
        setStatus('connecting');
        setMessage(attempt ? 'Reconectando ao computador…' : 'Conectando ao computador…');
      }

      socket.onopen = () => {
        const rememberedPeerId = peerId || sessionStorage.getItem(`screenlink-peer:${invite.roomId}`) || undefined;
        send(socket, { type: 'join-room', ...invite, peerId: rememberedPeerId });
      };
      socket.onerror = () => setMessage('O servidor está demorando para responder…');
      socket.onclose = event => {
        if (activeSocket === socket) activeSocket = null;
        if (viewerSocketRef.current === socket) viewerSocketRef.current = null;
        if (!disposed && !terminal && event.code !== 1000) retry('A conexão caiu. Tentando novamente…');
      };
      socket.onmessage = event => {
        let serverMessage: ServerMessage;
        try {
          serverMessage = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          failPermanently('O servidor enviou uma resposta inválida.');
          return;
        }
        void handleMessage(serverMessage, socket).catch(() => {
          destroyViewerPeer();
          socket.close(4002, 'WebRTC failed');
          retry('O vídeo não conectou. Tentando novamente…', true);
        });
      };
    }

    async function handleMessage(serverMessage: ServerMessage, socket: WebSocket) {
      if (serverMessage.type === 'joined') {
        attempt = 0;
        const currentExistingPeer = peer;
        const samePeer = Boolean(currentExistingPeer && peerId === serverMessage.peerId && currentExistingPeer.connectionState !== 'failed' && currentExistingPeer.connectionState !== 'closed');
        peerId = serverMessage.peerId;
        viewerPeerIdRef.current = peerId;
        sessionStorage.setItem(`screenlink-peer:${invite.roomId}`, peerId);
        if (serverMessage.resumed && samePeer && currentExistingPeer) {
          const pendingOffer = currentExistingPeer.localDescription;
          if (currentExistingPeer.signalingState === 'have-local-offer' && pendingOffer?.type === 'offer') {
            send(socket, { type: 'offer', peerId, sdp: pendingOffer });
          } else {
            void ensureViewerMicrophoneRef.current().catch(() => undefined);
          }
          if (currentExistingPeer.connectionState === 'connected' && videoRef.current?.srcObject) {
            setStatus('live');
            setMessage('');
          }
          return;
        }
        destroyViewerPeer();
        peerId = serverMessage.peerId;
        viewerPeerIdRef.current = peerId;
        setStatus('waiting');
        setMessage('Conectado. Aguardando o vídeo…');
        peer = new RTCPeerConnection({
          iceServers: serverMessage.iceServers as RTCIceServer[],
          bundlePolicy: 'max-bundle',
          iceCandidatePoolSize: 4
        });
        const currentPeer = peer;
        viewerPeerRef.current = currentPeer;
        currentPeer.onicecandidate = event => {
          if (event.candidate) send(socket, { type: 'ice-candidate', peerId, candidate: event.candidate.toJSON() });
        };
        currentPeer.ontrack = event => {
          const isFirstTrack = remoteStream === null;
          if (event.streams[0]) remoteStream = event.streams[0];
          else {
            remoteStream ??= new MediaStream();
            remoteStream.addTrack(event.track);
          }
          const stream = remoteStream;
          const syncAudioAvailability = () => setHasAudio(stream.getAudioTracks().some(track => track.readyState === 'live'));
          syncAudioAvailability();
          stream.addEventListener('removetrack', syncAudioAvailability);
          if (event.track.kind === 'audio') {
            event.track.addEventListener('ended', syncAudioAvailability, { once: true });
          }
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            if (isFirstTrack) {
              videoRef.current.muted = true;
              setViewerMuted(true);
            }
            void videoRef.current.play().catch(() => undefined);
          }
          if (event.track.kind === 'video') {
            setStatus('live');
            setMessage('');
            setViewerStartedAt(current => current ?? Date.now());
            startViewerStats(currentPeer);
          }
        };
        currentPeer.onconnectionstatechange = () => {
          if (currentPeer.connectionState === 'connected') {
            if (peerTimer !== null) window.clearTimeout(peerTimer);
            peerTimer = null;
            peerFailures = 0;
            if (videoRef.current?.srcObject) {
              setStatus('live');
              setMessage('');
            }
            startViewerStats(currentPeer);
            void ensureViewerMicrophoneRef.current().catch(() => undefined);
          }
          if (currentPeer.connectionState === 'disconnected') {
            setStatus('connecting');
            setMessage('Recuperando a conexão…');
            if (peerTimer !== null) window.clearTimeout(peerTimer);
            peerTimer = window.setTimeout(() => {
              destroyViewerPeer();
              socket.close(4002, 'WebRTC disconnected');
            }, 12_000);
          }
          if (currentPeer.connectionState === 'failed') {
            peerFailures += 1;
            if (peerFailures >= 3) {
              setViewerQuality('blocked');
              failPermanently('Esta rede bloqueou a conexão direta. Tente outra rede ou habilite TURN no ScreenLink.');
            } else {
              destroyViewerPeer();
              socket.close(4002, 'WebRTC failed');
            }
          }
        };
        peerTimer = window.setTimeout(() => {
          peerFailures += 1;
          if (peerFailures >= 3) failPermanently('O computador foi encontrado, mas a rede bloqueou o vídeo direto.');
          else {
            destroyViewerPeer();
            socket.close(4002, 'WebRTC timeout');
          }
        }, 18_000);
        return;
      }
      if (serverMessage.type === 'offer') {
        if (!peer || serverMessage.peerId !== peerId) return;
        if (peer.signalingState === 'have-local-offer') {
          await peer.setLocalDescription({ type: 'rollback' });
          microphoneRenegotiationPending = Boolean(viewerMicrophoneSenderRef.current);
        }
        await peer.setRemoteDescription(serverMessage.sdp);
        for (const candidate of queuedCandidates.splice(0)) await peer.addIceCandidate(candidate).catch(() => undefined);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send(socket, { type: 'answer', peerId, sdp: answer });
        initialNegotiationComplete = true;
        window.setTimeout(() => void ensureViewerMicrophoneRef.current().catch(() => undefined), 0);
        return;
      }
      if (serverMessage.type === 'answer') {
        if (!peer || serverMessage.peerId !== peerId || peer.signalingState !== 'have-local-offer') return;
        await peer.setRemoteDescription(serverMessage.sdp);
        return;
      }
      if (serverMessage.type === 'ice-candidate') {
        if (!peer || serverMessage.peerId !== peerId) return;
        if (peer.remoteDescription) await peer.addIceCandidate(serverMessage.candidate).catch(() => undefined);
        else queuedCandidates.push(serverMessage.candidate);
        return;
      }
      if (serverMessage.type === 'media-state') {
        if (serverMessage.peerId !== peerId) return;
        setRemotePaused(serverMessage.videoPaused);
        setScreenAudioActive(serverMessage.screenAudioEnabled);
        setMicrophoneActive(serverMessage.microphoneEnabled);
        return;
      }
      if (serverMessage.type === 'host-ended') {
        terminal = true;
        destroyViewerPeer();
        setStatus('ended');
        setMessage('O compartilhamento foi encerrado no computador.');
        socket.close(1000, 'Host ended');
        return;
      }
      if (serverMessage.type === 'error') {
        if (serverMessage.code === 'HOST_OFFLINE') {
          socket.close(4001, 'Host offline');
          retry('O computador está reconectando ou ainda não iniciou. Tentando novamente…');
        } else if (serverMessage.code === 'ROOM_FULL') {
          failPermanently(serverMessage.message || 'Esta transmissão atingiu o limite de espectadores.');
        } else if (serverMessage.code === 'UNAUTHORIZED' || serverMessage.code === 'BAD_ROOM') {
          failPermanently('Este convite é inválido ou já expirou. Peça um novo link ao apresentador.');
        } else {
          failPermanently(serverMessage.message);
        }
      }
    }

    const recoverAfterBackground = () => {
      if (disposed || terminal) return;
      if (document.visibilityState === 'visible') {
        void videoRef.current?.play().catch(() => undefined);
        void ensureViewerMicrophoneRef.current().catch(() => undefined);
      }
      if (activeSocket?.readyState === WebSocket.OPEN || activeSocket?.readyState === WebSocket.CONNECTING) return;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recoverAfterBackground();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', recoverAfterBackground);
    window.addEventListener('online', recoverAfterBackground);
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', recoverAfterBackground);
      window.removeEventListener('online', recoverAfterBackground);
      send(activeSocket, { type: 'leave-room' });
      activeSocket?.close(1000, 'Viewer left');
      viewerSocketRef.current = null;
      destroyViewerPeer();
      stopStream(viewerMicrophoneStreamRef.current);
      viewerMicrophoneStreamRef.current = null;
      viewerMicrophoneTrackRef.current = null;
      viewerMicrophoneSenderRef.current = null;
      ensureViewerMicrophoneRef.current = async () => undefined;
      sessionStorage.removeItem(`screenlink-peer:${invite.roomId}`);
    };
  }, [invite.roomId, invite.token]);

  useEffect(() => {
    const wakeNavigator = navigator as WakeLockNavigator;
    let disposed = false;

    const release = async () => {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      setWakeActive(false);
      if (lock && !lock.released) await lock.release().catch(() => undefined);
    };

    const acquire = async () => {
      if (disposed || status !== 'live' || !keepAwake || document.visibilityState !== 'visible' || !wakeNavigator.wakeLock) return;
      try {
        const lock = await wakeNavigator.wakeLock.request('screen');
        if (disposed) {
          await lock.release().catch(() => undefined);
          return;
        }
        wakeLockRef.current = lock;
        setWakeActive(true);
        lock.addEventListener('release', () => {
          if (wakeLockRef.current === lock) wakeLockRef.current = null;
          if (!disposed) setWakeActive(false);
        }, { once: true });
      } catch {
        setWakeActive(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (keepAwake) void acquire();
    else void release();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void release();
    };
  }, [keepAwake, status]);

  const label = status === 'live' ? 'Sessão ativa' : status === 'ended' ? 'Encerrado' : status === 'error' ? 'Atenção' : 'Conectando';
  const title = status === 'ended' ? 'Transmissão encerrada' : status === 'error' ? 'Não foi possível assistir' : 'Preparando a transmissão';

  async function openFullscreen() {
    await stageRef.current?.requestFullscreen?.();
  }

  async function togglePictureInPicture() {
    const pipDocument = document as PictureInPictureDocument;
    const video = videoRef.current as PictureInPictureVideo | null;
    if (!video || !pipDocument.pictureInPictureEnabled || !video.requestPictureInPicture) return;
    try {
      if (pipDocument.pictureInPictureElement) await pipDocument.exitPictureInPicture?.();
      else await video.requestPictureInPicture();
    } catch {
      // Alguns navegadores exigem que o vídeo esteja reproduzindo.
    }
  }

  function cycleZoom() {
    setZoom(current => current === 1 ? 1.5 : current === 1.5 ? 2 : 1);
  }

  async function toggleViewerAudio() {
    const video = videoRef.current;
    if (!video || !hasAudio) return;
    const nextMuted = !viewerMuted;
    video.muted = nextMuted;
    if (!nextMuted) {
      try {
        await video.play();
      } catch {
        video.muted = true;
        setViewerMuted(true);
        return;
      }
    }
    setViewerMuted(nextMuted);
  }

  async function toggleViewerMicrophone() {
    const currentTrack = viewerMicrophoneTrackRef.current;
    if (viewerMicrophoneEnabledRef.current && currentTrack) {
      currentTrack.enabled = false;
      viewerMicrophoneEnabledRef.current = false;
      setViewerMicrophoneEnabled(false);
      setViewerMicrophoneMessage('Seu microfone está silenciado.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setViewerMicrophoneAvailable(false);
      setViewerMicrophoneMessage('Este navegador não oferece acesso ao microfone.');
      return;
    }

    let track = currentTrack;
    if (!track || track.readyState === 'ended') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        track = stream.getAudioTracks()[0] ?? null;
        if (!track) throw new Error('Microphone track unavailable');
        stopStream(viewerMicrophoneStreamRef.current);
        viewerMicrophoneStreamRef.current = stream;
        viewerMicrophoneTrackRef.current = track;
        viewerMicrophoneSenderRef.current = null;
        track.addEventListener('mute', () => {
          if (viewerMicrophoneTrackRef.current === track && viewerMicrophoneEnabledRef.current) {
            setViewerMicrophoneMessage('O sistema suspendeu temporariamente o microfone.');
          }
        });
        track.addEventListener('unmute', () => {
          if (viewerMicrophoneTrackRef.current === track && viewerMicrophoneEnabledRef.current) {
            setViewerMicrophoneMessage('Seu microfone está ativo.');
          }
        });
        track.addEventListener('ended', () => {
          if (viewerMicrophoneTrackRef.current !== track) return;
          viewerMicrophoneTrackRef.current = null;
          viewerMicrophoneSenderRef.current = null;
          viewerMicrophoneEnabledRef.current = false;
          setViewerMicrophoneEnabled(false);
          setViewerMicrophoneAvailable(false);
          setViewerMicrophoneMessage('O acesso ao microfone foi encerrado pelo navegador ou pelo sistema.');
        }, { once: true });
        setViewerMicrophoneAvailable(true);
      } catch {
        setViewerMicrophoneAvailable(false);
        setViewerMicrophoneMessage('Permita o acesso ao microfone para falar com o apresentador.');
        return;
      }
    }

    track.enabled = true;
    viewerMicrophoneEnabledRef.current = true;
    setViewerMicrophoneEnabled(true);
    setViewerMicrophoneMessage('Seu microfone está ativo.');
    void ensureViewerMicrophoneRef.current().catch(() => {
      setViewerMicrophoneMessage('Microfone pronto; reconectando o canal de voz…');
    });
  }

  function updateStreamDetails() {
    const video = videoRef.current;
    const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
    const settings = stream?.getVideoTracks()[0]?.getSettings();
    const height = video?.videoHeight || settings?.height;
    const frameRate = settings?.frameRate;
    setStreamDetails([
      height ? `${height}p` : '',
      frameRate ? `até ${Math.round(frameRate)} FPS` : ''
    ].filter(Boolean).join(' · '));
  }

  const liveDescription = [
    streamDetails || 'Conexão P2P direta',
    hasAudio
      ? viewerMuted
        ? 'áudio disponível'
        : [screenAudioActive ? 'som da tela' : '', microphoneActive ? 'microfone' : ''].filter(Boolean).join(' + ') || 'áudio ativo'
      : 'sem áudio',
    viewerMicrophoneEnabled ? 'seu mic ativo' : '',
    viewerMicrophoneAvailable === false && viewerMicrophoneMessage ? 'mic precisa de permissão' : ''
  ].filter(Boolean).join(' · ');
  const viewerQualityLabel = viewerQuality === 'excellent'
    ? 'Excelente'
    : viewerQuality === 'good'
      ? 'Estável'
      : viewerQuality === 'limited'
        ? 'Limitada'
        : viewerQuality === 'blocked' ? 'Bloqueada' : 'Conectando';
  const pictureInPictureSupported = Boolean((document as PictureInPictureDocument).pictureInPictureEnabled && (videoRef.current as PictureInPictureVideo | null)?.requestPictureInPicture);
  const wakeLockSupported = Boolean((navigator as WakeLockNavigator).wakeLock);

  return (
    <div className="app viewer-mode">
      <Header status={label} live={status === 'live'} />
      <main className="viewer-main">
        <section ref={stageRef} className={`viewer-stage ${status === 'live' ? 'has-video' : ''} ${remotePaused ? 'is-paused' : ''}`} aria-live="polite">
          <video
            ref={videoRef}
            className="viewer-video"
            style={{ '--viewer-zoom': zoom } as CSSProperties}
            autoPlay
            playsInline
            muted={viewerMuted}
            onLoadedMetadata={updateStreamDetails}
            onDoubleClick={cycleZoom}
          />
          {status !== 'live' && (
            <div className="viewer-empty">
              {status === 'connecting' || status === 'waiting' ? (
                <ScreenLinkMascot />
              ) : (
                <div className={`connection-visual ${status}`} aria-hidden="true">
                  <Icon name="screen" />
                  <span className="connection-line"><i /></span>
                  <Icon name="link" />
                </div>
              )}
              <h1>{title}</h1>
              <p>{message}</p>
              {status === 'error' && <button className="retry-action" type="button" onClick={() => window.location.reload()}>Tentar novamente</button>}
            </div>
          )}
          {status === 'live' && hasAudio && viewerMuted && (
            <button className="sound-prompt" type="button" onClick={toggleViewerAudio}>
              <Icon name="volume" /> Ouvir áudio
            </button>
          )}
          {status === 'live' && remotePaused && (
            <div className="paused-overlay"><Icon name="pause" /><strong>Transmissão pausada</strong><span>O apresentador retomará em instantes.</span></div>
          )}
          {status === 'live' && (
            <div className={`viewer-live-info ${viewerQuality}`}>
              <span><strong>{viewerQualityLabel} · {viewerDuration}</strong><small>{liveDescription}{viewerMetrics.rttMs ? ` · ${viewerMetrics.rttMs} ms` : ''}</small></span>
            </div>
          )}
          <div className="viewer-bar" aria-label="Controles do espectador">
            <div className="viewer-actions">
              <button className={!viewerMuted && hasAudio ? 'is-on' : ''} type="button" onClick={toggleViewerAudio} aria-label={viewerMuted ? 'Ouvir áudio' : 'Silenciar áudio'} aria-pressed={!viewerMuted && hasAudio} data-label="Áudio" disabled={status !== 'live' || !hasAudio}>
                <Icon name={!hasAudio || viewerMuted ? 'volumeOff' : 'volume'} />
              </button>
              <button className={viewerMicrophoneEnabled ? 'is-on' : ''} type="button" onClick={toggleViewerMicrophone} aria-label={viewerMicrophoneEnabled ? 'Silenciar seu microfone' : 'Ativar seu microfone'} aria-pressed={viewerMicrophoneEnabled} data-label="Falar" disabled={status !== 'live'} title={viewerMicrophoneMessage || undefined}>
                <Icon name={viewerMicrophoneEnabled ? 'microphone' : 'microphoneOff'} />
              </button>
              <button className={wakeActive ? 'is-on' : ''} type="button" onClick={() => setKeepAwake(current => !current)} aria-label={keepAwake ? 'Permitir que a tela adormeça' : 'Manter tela ativa'} aria-pressed={keepAwake} data-label="Tela ativa" disabled={status !== 'live' || !wakeLockSupported}>
                <Icon name="wake" />
              </button>
              <button className={zoom > 1 ? 'is-on' : ''} type="button" onClick={cycleZoom} aria-label={`Alterar zoom, atual ${Math.round(zoom * 100)}%`} aria-pressed={zoom > 1} data-label={`${Math.round(zoom * 100)}%`} disabled={status !== 'live'}>
                <Icon name="zoom" />
              </button>
              <button type="button" onClick={togglePictureInPicture} aria-label="Abrir picture-in-picture" data-label="Mini player" disabled={status !== 'live' || !pictureInPictureSupported}>
                <Icon name="pip" />
              </button>
              <button type="button" onClick={openFullscreen} aria-label="Abrir em tela cheia" data-label="Tela cheia" disabled={status !== 'live'}><Icon name="expand" /></button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const [invite, setInvite] = useState(() => parseInvite());
  useEffect(() => {
    const updateInvite = () => setInvite(parseInvite());
    window.addEventListener('hashchange', updateInvite);
    return () => window.removeEventListener('hashchange', updateInvite);
  }, []);
  return invite ? <ViewerApp invite={invite} /> : <HostApp />;
}
