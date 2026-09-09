import { useCallback, useEffect, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
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

type IconName = 'screen' | 'screenOff' | 'link' | 'shield' | 'stop' | 'copy' | 'phone' | 'call' | 'hangup' | 'message' | 'send' | 'expand' | 'check' | 'signal' | 'volume' | 'volumeOff' | 'pause' | 'play' | 'microphone' | 'microphoneOff' | 'share' | 'qr' | 'pip' | 'wake' | 'auto' | 'chevron' | 'more' | 'settings';
type CallState = 'idle' | 'starting' | 'connected' | 'reconnecting' | 'error';
type ScreenShareState = 'idle' | 'selecting' | 'sharing';
type AudienceStatus = 'empty' | 'connecting' | 'connected';
type ViewerStatus = 'connecting' | 'connected' | 'ended' | 'error';
type PeerRecord = {
  id: string;
  pc: RTCPeerConnection;
  queued: RTCIceCandidateInit[];
  remoteAudio: HTMLAudioElement | null;
  callAudioSender: RTCRtpSender;
  screenVideoSender: RTCRtpSender;
  screenAudioSender: RTCRtpSender;
  chatChannel: RTCDataChannel | null;
  displayName: string;
};
type RuntimeConfig = { viewerOrigin?: string; mode?: 'p2p-stun'; turnEnabled?: boolean };
type Resolution = 360 | 480 | 720 | 1080;
type FrameRate = 15 | 30 | 45 | 60;
type VideoProfile = { resolution: Resolution; fps: FrameRate };
type ProfileStatus = 'idle' | 'applying' | 'applied' | 'error';
type ConnectionQuality = 'waiting' | 'excellent' | 'good' | 'limited' | 'blocked';
type ConnectionMetrics = { bitrateKbps: number; availableKbps: number; rttMs: number; packetLoss: number };
type HostPanel = 'stream' | 'chat';
type ChatAppearance = { ownBubble: string; otherBubble: string; nameColor: string };
type ChatMessage = {
  id: string;
  kind: 'message' | 'system';
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
};
type ChatWirePayload =
  | { type: 'chat-send'; text: string }
  | { type: 'chat-profile'; name: string }
  | { type: 'chat-message'; message: ChatMessage }
  | { type: 'chat-history'; messages: ChatMessage[] };

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
type SinkableMediaElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
type VoiceProcessing = { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };

const RESOLUTIONS: readonly Resolution[] = [360, 480, 720, 1080];
const FRAME_RATES: readonly FrameRate[] = [15, 30, 45, 60];
const VIEWER_LIMITS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const CHAT_MESSAGE_LIMIT = 1_000;
const CHAT_HISTORY_LIMIT = 120;
const CHAT_BUFFER_LIMIT = 256_000;
const DEFAULT_CHAT_APPEARANCE: ChatAppearance = { ownBubble: '#383838', otherBubble: '#1c1c1c', nameColor: '#ffffff' };
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

function messageId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeChatText(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim().slice(0, CHAT_MESSAGE_LIMIT);
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 24);
}

function storedDisplayName(key: string, fallback: string) {
  try {
    return normalizeDisplayName(window.localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function rememberDisplayName(key: string, value: string) {
  try {
    const name = normalizeDisplayName(value);
    if (name) window.localStorage.setItem(key, name);
    else window.localStorage.removeItem(key);
  } catch {
    // O nome continua válido nesta chamada mesmo sem armazenamento local.
  }
}

function normalizeChatColor(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function storedChatAppearance(key: string): ChatAppearance {
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) || '{}') as Partial<ChatAppearance>;
    return {
      ownBubble: normalizeChatColor(stored.ownBubble, DEFAULT_CHAT_APPEARANCE.ownBubble),
      otherBubble: normalizeChatColor(stored.otherBubble, DEFAULT_CHAT_APPEARANCE.otherBubble),
      nameColor: normalizeChatColor(stored.nameColor, DEFAULT_CHAT_APPEARANCE.nameColor)
    };
  } catch {
    return DEFAULT_CHAT_APPEARANCE;
  }
}

function rememberChatAppearance(key: string, appearance: ChatAppearance) {
  try {
    window.localStorage.setItem(key, JSON.stringify(appearance));
  } catch {
    // A aparência continua aplicada durante a chamada atual.
  }
}

function useDismissOnOutside(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !ref.current?.contains(target)) onDismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [active, onDismiss, ref]);
}

function microphoneConstraints(deviceId: string, processing: VoiceProcessing): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: processing.echoCancellation,
    noiseSuppression: processing.noiseSuppression,
    autoGainControl: processing.autoGainControl
  };
}

function useAudioDevices(active: boolean) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!active || !mediaDevices?.enumerateDevices) return;
    let disposed = false;
    const refresh = () => {
      void mediaDevices.enumerateDevices().then(devices => {
        if (disposed) return;
        setInputs(devices.filter(device => device.kind === 'audioinput'));
        setOutputs(devices.filter(device => device.kind === 'audiooutput'));
      }).catch(() => undefined);
    };
    refresh();
    mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      disposed = true;
      mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, [active]);

  return { inputs, outputs };
}

function validChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === 'string' && message.id.length <= 100 &&
    (message.kind === 'message' || message.kind === 'system') &&
    typeof message.senderId === 'string' && message.senderId.length <= 100 &&
    typeof message.senderName === 'string' && message.senderName.length <= 80 &&
    typeof message.text === 'string' && message.text.length <= CHAT_MESSAGE_LIMIT &&
    typeof message.sentAt === 'number' && Number.isFinite(message.sentAt)
  );
}

function parseChatPayload(raw: string): ChatWirePayload | null {
  if (raw.length > 16_000) return null;
  try {
    const payload = JSON.parse(raw) as Partial<ChatWirePayload>;
    if (payload.type === 'chat-send') {
      const text = normalizeChatText(payload.text);
      return text ? { type: 'chat-send', text } : null;
    }
    if (payload.type === 'chat-profile') {
      const name = normalizeDisplayName(payload.name);
      return name ? { type: 'chat-profile', name } : null;
    }
    if (payload.type === 'chat-message' && validChatMessage(payload.message)) {
      return { type: 'chat-message', message: payload.message };
    }
    if (payload.type === 'chat-history' && Array.isArray(payload.messages)) {
      const messages = payload.messages.filter(validChatMessage).slice(-CHAT_HISTORY_LIMIT);
      return { type: 'chat-history', messages };
    }
  } catch {
    // Mensagens inválidas são ignoradas sem afetar a chamada.
  }
  return null;
}

function sendChatPayload(channel: RTCDataChannel | null, payload: ChatWirePayload) {
  if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > CHAT_BUFFER_LIMIT) return false;
  const serialized = JSON.stringify(payload);
  if (serialized.length > 16_000) return false;
  channel.send(serialized);
  return true;
}

function renderMessageText(text: string) {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/gi);
  return parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
    : part
  );
}

function ChatPanel({ messages, currentSenderId, canSend, placeholder, displayName, displayNamePlaceholder, appearance, onDisplayNameChange, onAppearanceChange, onSend }: {
  messages: ChatMessage[];
  currentSenderId: string;
  canSend: boolean;
  placeholder: string;
  displayName: string;
  displayNamePlaceholder: string;
  appearance: ChatAppearance;
  onDisplayNameChange: (name: string) => void;
  onAppearanceChange: (appearance: ChatAppearance) => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useDismissOnOutside(toolbarRef, settingsOpen, closeSettings);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = normalizeChatText(draft);
    if (!text || !canSend) return;
    onSend(text);
    setDraft('');
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-panel" style={{ '--chat-own-bubble': appearance.ownBubble, '--chat-other-bubble': appearance.otherBubble, '--chat-name-color': appearance.nameColor } as CSSProperties}>
      <div className="chat-toolbar" ref={toolbarRef}>
        <label className="chat-identity">
          <span>Você como</span>
          <input
            value={displayName}
            maxLength={24}
            placeholder={displayNamePlaceholder}
            aria-label="Seu nome no chat"
            onChange={event => onDisplayNameChange(event.currentTarget.value)}
            onBlur={event => onDisplayNameChange(normalizeDisplayName(event.currentTarget.value))}
          />
        </label>
        <button className={`chat-settings-trigger ${settingsOpen ? 'is-open' : ''}`} type="button" aria-label="Personalizar aparência do chat" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(current => !current)}><Icon name="settings" /></button>
        {settingsOpen && (
          <section className="chat-settings-popover" aria-label="Aparência do chat">
            <header><strong>Aparência do chat</strong><small>VISÍVEL SÓ PARA VOCÊ</small></header>
            <label><span><strong>Seu balão</strong><small>Destaque das suas mensagens</small></span><input type="color" value={appearance.ownBubble} aria-label="Cor do seu balão" onChange={event => onAppearanceChange({ ...appearance, ownBubble: event.currentTarget.value })} /></label>
            <label><span><strong>Outros balões</strong><small>Mensagens dos participantes</small></span><input type="color" value={appearance.otherBubble} aria-label="Cor dos outros balões" onChange={event => onAppearanceChange({ ...appearance, otherBubble: event.currentTarget.value })} /></label>
            <label><span><strong>Nomes</strong><small>Branco por padrão</small></span><input type="color" value={appearance.nameColor} aria-label="Cor dos nomes" onChange={event => onAppearanceChange({ ...appearance, nameColor: event.currentTarget.value })} /></label>
            <button className="chat-settings-reset" type="button" onClick={() => onAppearanceChange(DEFAULT_CHAT_APPEARANCE)}>Restaurar padrão</button>
          </section>
        )}
      </div>
      <div className="chat-log" ref={listRef} aria-live="polite" aria-label="Mensagens da chamada">
        {messages.length ? messages.map(message => message.kind === 'system' ? (
          <p className="chat-system" key={message.id}>{message.text}</p>
        ) : (
          <article className={`chat-message ${message.senderId === currentSenderId ? 'is-own' : ''}`} key={message.id}>
            <header><strong>{message.senderId === currentSenderId ? 'Você' : message.senderName}</strong><time dateTime={new Date(message.sentAt).toISOString()}>{new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
            <p>{renderMessageText(message.text)}</p>
          </article>
        )) : (
          <div className="chat-empty"><Icon name="message" /><strong>A conversa começa aqui</strong><span>As mensagens são temporárias e somem ao encerrar a chamada.</span></div>
        )}
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <textarea
          aria-label="Escrever mensagem"
          value={draft}
          maxLength={CHAT_MESSAGE_LIMIT}
          rows={1}
          placeholder={placeholder}
          disabled={!canSend}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" disabled={!canSend || !normalizeChatText(draft)} aria-label="Enviar mensagem"><Icon name="send" /></button>
      </form>
      <small className="chat-hint">Enter envia · Shift+Enter quebra a linha · {draft.length}/{CHAT_MESSAGE_LIMIT}</small>
    </div>
  );
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
  const premiumSelected = (suffix === 'resolução' && value === 1080) || (suffix === 'FPS' && value === 60);
  return (
    <fieldset className="profile-fieldset">
      <legend><span>{label}</span><small>{suffix}</small></legend>
      <div className={`segmented-control ${premiumSelected ? 'is-premium-selected' : ''}`} role="radiogroup" aria-label={label} style={{ '--active-index': activeIndex, '--option-count': options.length } as CSSProperties}>
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

function DevicePicker({ id, label, icon, value, devices, onChange }: {
  id: string;
  label: string;
  icon: 'microphone' | 'volume';
  value: string;
  devices: MediaDeviceInfo[];
  onChange: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closePicker = useCallback(() => setOpen(false), []);
  useDismissOnOutside(rootRef, open, closePicker);
  const selectedLabel = devices.find(device => device.deviceId === value)?.label || 'Padrão do sistema';
  const options = [{ deviceId: '', label: 'Padrão do sistema' }, ...devices
    .filter(device => device.deviceId)
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `${label} ${index + 1}` }))];

  const closeWhenFocusLeaves = (event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !rootRef.current?.contains(nextTarget)) setOpen(false);
  };

  return (
    <div
      className={`device-picker ${open ? 'is-open' : ''}`}
      ref={rootRef}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={closeWhenFocusLeaves}
    >
      <button className="device-select" id={id} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-options`} onClick={() => setOpen(true)}>
        <Icon name={icon} />
        <span><strong>{label}</strong><small>{selectedLabel}</small></span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="device-options" id={`${id}-options`} role="listbox" aria-label={label}>
          <header><strong>{label}</strong><small>ESCOLHA UM DISPOSITIVO</small></header>
          <div className="device-options-list">
            {options.map((option, index) => (
              <button
                key={`${option.deviceId || 'default'}-${index}`}
                type="button"
                role="option"
                aria-selected={option.deviceId === value}
                onClick={() => { onChange(option.deviceId); setOpen(false); }}
              >
                <Icon name={icon} />
                <span>{option.label}</span>
                {option.deviceId === value && <Icon name="check" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VoiceSetting({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button className="voice-setting" type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span><strong>{label}</strong><small>{description}</small></span>
      <i aria-hidden="true"><b /></i>
    </button>
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
    screenOff: <><path d="M8 4h11a2 2 0 0 1 2 2v8M17 17H5a2 2 0 0 1-2-2V6c0-.4.1-.8.3-1.1M8 21h8M12 17v4M3 3l18 18"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2A5 5 0 0 0 12 4l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></>,
    shield: <><path d="M12 3 4.5 6v5.5c0 4.7 3.2 7.8 7.5 9.5 4.3-1.7 7.5-4.8 7.5-9.5V6L12 3Z"/><path d="m9.5 12 1.7 1.7 3.7-4"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    phone: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></>,
    call: <path d="M7.4 3.5 10 8 7.8 10c1.4 2.8 3.4 4.8 6.2 6.2l2-2.2 4.5 2.6-.8 3.8c-.2.8-.9 1.3-1.7 1.2C9.7 20.6 3.4 14.3 2.4 6c-.1-.8.4-1.5 1.2-1.7l3.8-.8Z"/>,
    hangup: <><path d="M4.3 15.5c4.9-4.6 10.5-4.6 15.4 0"/><path d="m7.2 13.3-1.4 4.2-3.5-1.2M16.8 13.3l1.4 4.2 3.5-1.2"/></>,
    message: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5.5 4v-4.5A2.5 2.5 0 0 1 4 14V5.5Z"/><path d="M8 8h8M8 12h5"/></>,
    send: <><path d="M12 20V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/></>,
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
    pip: <><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1"/></>,
    wake: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    auto: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></>,
    chevron: <path d="m5.5 8 6.5 6.5 6.5-6.5"/>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>
  };

  return <svg className={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function ScreenLinkMascot() {
  return (
    <svg className="waiting-mascot" viewBox="0 0 180 142" aria-hidden="true">
      <defs>
        <radialGradient id="screenlink-mascot-body" cx="0" cy="0" r="1" gradientTransform="translate(71 54) rotate(68) scale(91 112)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#86dce8" />
          <stop offset=".5" stopColor="#7ad5e2" />
          <stop offset=".78" stopColor="#70cedc" />
          <stop offset="1" stopColor="#62bfd1" />
        </radialGradient>
        <linearGradient id="screenlink-mascot-ear" x1="90" y1="46" x2="90" y2="75" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6bcbd8" />
          <stop offset="1" stopColor="#50aebf" />
        </linearGradient>
        <linearGradient id="screenlink-mascot-antenna" x1="90" y1="10" x2="90" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#b5f1f5" />
          <stop offset=".48" stopColor="#86dce7" />
          <stop offset="1" stopColor="#62c3d3" />
        </linearGradient>
        <linearGradient id="screenlink-mascot-lower" x1="90" y1="94" x2="90" y2="132" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5ab9cb" stopOpacity="0" />
          <stop offset="1" stopColor="#43a7ba" stopOpacity=".22" />
        </linearGradient>
      </defs>
      <g className="mascot-float">
        <g className="mascot-signal-group">
          <path className="mascot-signal-arc" d="M90 30V20" />
          <circle className="mascot-signal" cx="90" cy="15.5" r="4.5" fill="url(#screenlink-mascot-antenna)" />
        </g>
        <path className="mascot-ear mascot-ear-left" d="M44 49c-10-8-23-9-31-3-7 5-9 13-7 20 10-3 19 1 26 11 3-10 7-19 12-28Z" fill="url(#screenlink-mascot-ear)" />
        <path className="mascot-ear mascot-ear-right" d="M136 49c10-8 23-9 31-3 7 5 9 13 7 20-10-3-19 1-26 11-3-10-7-19-12-28Z" fill="url(#screenlink-mascot-ear)" />
        <path className="mascot-body" d="M42 36c14-9 33-12 48-12 16 0 35 3 48 12 14 10 20 30 17 51-2 19-9 32-25 40-17 8-63 8-80 0-16-8-23-21-25-40-3-21 3-41 17-51Z" fill="url(#screenlink-mascot-body)" />
        <path className="mascot-lower-shade" d="M42 36c14-9 33-12 48-12 16 0 35 3 48 12 14 10 20 30 17 51-2 19-9 32-25 40-17 8-63 8-80 0-16-8-23-21-25-40-3-21 3-41 17-51Z" fill="url(#screenlink-mascot-lower)" />
        <path className="mascot-highlight" d="M54 46c15-8 34-10 53-8" />
        <g className="mascot-face">
          <ellipse cx="69" cy="78" rx="6.3" ry="6.7" />
          <ellipse cx="111" cy="78" rx="6.3" ry="6.7" />
          <path d="M77.5 93.5c8 8 17 8 25 0" />
        </g>
        <circle className="mascot-cheek" cx="56.5" cy="94" r="4.6" />
        <circle className="mascot-cheek" cx="123.5" cy="94" r="4.6" />
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
  if (record.chatChannel) {
    record.chatChannel.onopen = null;
    record.chatChannel.onmessage = null;
    record.chatChannel.onclose = null;
    record.chatChannel.close();
    record.chatChannel = null;
  }
  record.pc.onicecandidate = null;
  record.pc.onconnectionstatechange = null;
  record.pc.ontrack = null;
  record.pc.ondatachannel = null;
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
  const hostDockRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const callOutboundStreamRef = useRef(new MediaStream());
  const screenOutboundStreamRef = useRef(new MediaStream());
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
  const microphoneRequestRef = useRef<Promise<MediaStreamTrack | null> | null>(null);
  const videoPausedRef = useRef(false);
  const audioEnabledRef = useRef(true);
  const microphoneEnabledRef = useRef(true);
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
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const panelSectionRef = useRef<HostPanel>('stream');
  const hostNameRef = useRef('Apresentador');
  const hostInputDeviceIdRef = useRef('');
  const hostOutputDeviceIdRef = useRef('');
  const hostVoiceProcessingRef = useRef<VoiceProcessing>({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });

  const [status, setStatus] = useState<CallState>('idle');
  const [screenShareState, setScreenShareState] = useState<ScreenShareState>('idle');
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
  const [videoPaused, setVideoPaused] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [microphoneAvailable, setMicrophoneAvailable] = useState<boolean | null>(null);
  const [panelSection, setPanelSection] = useState<HostPanel>('stream');
  const [inputVolume, setInputVolume] = useState(100);
  const [outputVolume, setOutputVolume] = useState(100);
  const [viewerIds, setViewerIds] = useState<string[]>([]);
  const [viewerVolumes, setViewerVolumes] = useState<Record<string, number>>({});
  const [qrCode, setQrCode] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [hostName, setHostName] = useState(() => storedDisplayName('screenlink-host-name', 'Apresentador'));
  const [hostChatAppearance, setHostChatAppearance] = useState(() => storedChatAppearance('screenlink-host-chat-appearance'));
  const [hostAudioMenuOpen, setHostAudioMenuOpen] = useState(false);
  const [hostScreenMenuOpen, setHostScreenMenuOpen] = useState(false);
  const [hostInputDeviceId, setHostInputDeviceId] = useState('');
  const [hostOutputDeviceId, setHostOutputDeviceId] = useState('');
  const [hostVoiceProcessing, setHostVoiceProcessing] = useState<VoiceProcessing>({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  const hostAudioDevices = useAudioDevices(hostAudioMenuOpen);
  const sessionDuration = useSessionDuration(sessionStartedAt);
  const closeHostMenus = useCallback(() => {
    setHostAudioMenuOpen(false);
    setHostScreenMenuOpen(false);
  }, []);
  useDismissOnOutside(hostDockRef, hostAudioMenuOpen || hostScreenMenuOpen, closeHostMenus);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/runtime-config', { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<RuntimeConfig> : Promise.reject(new Error('Runtime configuration unavailable')))
      .then(configuration => {
        if (configuration.viewerOrigin) viewerOriginRef.current = configuration.viewerOrigin;
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
  useEffect(() => { microphoneEnabledRef.current = microphoneEnabled; }, [microphoneEnabled]);
  useEffect(() => { videoPausedRef.current = videoPaused; }, [videoPaused]);
  useEffect(() => { automaticQualityRef.current = automaticQuality; }, [automaticQuality]);
  useEffect(() => { maxViewersRef.current = maxViewers; }, [maxViewers]);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);
  useEffect(() => { hostNameRef.current = normalizeDisplayName(hostName) || 'Apresentador'; }, [hostName]);
  useEffect(() => {
    if (status === 'idle' || status === 'error') {
      setHostAudioMenuOpen(false);
      setHostScreenMenuOpen(false);
    }
  }, [status]);
  useEffect(() => {
    panelSectionRef.current = panelSection;
    if (panelSection === 'chat') setChatUnread(0);
  }, [panelSection]);

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

  const appendChatMessage = useCallback((message: ChatMessage, notify = false) => {
    const nextMessages = [...chatMessagesRef.current, message].slice(-CHAT_HISTORY_LIMIT);
    chatMessagesRef.current = nextMessages;
    setChatMessages(nextMessages);
    if (notify && panelSectionRef.current !== 'chat') setChatUnread(current => current + 1);
  }, []);

  const broadcastChatMessage = useCallback((message: ChatMessage) => {
    for (const peer of peersRef.current.values()) {
      sendChatPayload(peer.chatChannel, { type: 'chat-message', message });
    }
  }, []);

  const publishSystemMessage = useCallback((text: string) => {
    const message: ChatMessage = {
      id: messageId(),
      kind: 'system',
      senderId: 'system',
      senderName: 'ScreenLink',
      text,
      sentAt: Date.now()
    };
    appendChatMessage(message);
    broadcastChatMessage(message);
  }, [appendChatMessage, broadcastChatMessage]);

  const changeHostName = useCallback((value: string) => {
    const nextValue = value.slice(0, 24);
    setHostName(nextValue);
    const normalized = normalizeDisplayName(nextValue);
    hostNameRef.current = normalized || 'Apresentador';
    rememberDisplayName('screenlink-host-name', normalized);
  }, []);

  const changeHostChatAppearance = useCallback((appearance: ChatAppearance) => {
    setHostChatAppearance(appearance);
    rememberChatAppearance('screenlink-host-chat-appearance', appearance);
  }, []);

  const sendHostChat = useCallback((text: string) => {
    const normalized = normalizeChatText(text);
    if (!normalized || status !== 'connected') return;
    const message: ChatMessage = {
      id: messageId(),
      kind: 'message',
      senderId: 'host',
      senderName: hostNameRef.current,
      text: normalized,
      sentAt: Date.now()
    };
    appendChatMessage(message);
    broadcastChatMessage(message);
  }, [appendChatMessage, broadcastChatMessage, status]);

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
    const sinkableAudio = audio as SinkableMediaElement;
    if (sinkableAudio.setSinkId) void sinkableAudio.setSinkId(hostOutputDeviceIdRef.current).catch(() => undefined);
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

  const changeHostOutputDevice = useCallback((deviceId: string) => {
    hostOutputDeviceIdRef.current = deviceId;
    setHostOutputDeviceId(deviceId);
    for (const peerId of peersRef.current.keys()) applyViewerVolume(peerId);
  }, [applyViewerVolume]);

  const changeInputVolume = useCallback((value: number) => {
    inputVolumeRef.current = value;
    setInputVolume(value);
    const context = microphoneAudioContextRef.current;
    const gain = microphoneGainRef.current;
    if (context && gain) gain.gain.setTargetAtTime(value / 100, context.currentTime, .015);
  }, []);

  const changeHostVoiceProcessing = useCallback((key: keyof VoiceProcessing, enabled: boolean) => {
    const next = { ...hostVoiceProcessingRef.current, [key]: enabled };
    hostVoiceProcessingRef.current = next;
    setHostVoiceProcessing(next);
    const sourceTrack = microphoneSourceStreamRef.current?.getAudioTracks()[0];
    if (sourceTrack?.readyState === 'live') {
      void sourceTrack.applyConstraints(microphoneConstraints(hostInputDeviceIdRef.current, next)).catch(() => undefined);
    }
  }, []);

  const disposeMicrophonePipeline = useCallback(() => {
    const outboundTrack = microphoneTrackRef.current;
    microphoneTrackRef.current = null;
    if (outboundTrack && !microphoneSourceStreamRef.current?.getTracks().includes(outboundTrack)) outboundTrack.stop();
    stopStream(microphoneSourceStreamRef.current);
    microphoneSourceStreamRef.current = null;
    for (const track of callOutboundStreamRef.current.getTracks()) callOutboundStreamRef.current.removeTrack(track);
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
    screenSharing: boolean;
    videoPaused: boolean;
    screenAudioEnabled: boolean;
    microphoneEnabled: boolean;
  }> = {}) => {
    for (const peerId of peersRef.current.keys()) {
      send(socketRef.current, {
        type: 'media-state',
        peerId,
        screenSharing: overrides.screenSharing ?? Boolean(streamRef.current),
        videoPaused: overrides.videoPaused ?? videoPausedRef.current,
        screenAudioEnabled: overrides.screenAudioEnabled ?? Boolean(streamRef.current && screenAudioTracksRef.current.length && audioEnabledRef.current),
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
        if (peer.screenVideoSender.track) await configureVideoSender(peer.screenVideoSender, profile);
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

  const ensureHostMicrophone = useCallback(async () => {
    const existing = microphoneTrackRef.current;
    if (existing?.readyState === 'live') return existing;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneAvailable(false);
      return null;
    }
    if (microphoneRequestRef.current) return microphoneRequestRef.current;

    const request = (async () => {
      try {
        const microphoneStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: microphoneConstraints(hostInputDeviceIdRef.current, hostVoiceProcessingRef.current)
        });
        disposeMicrophonePipeline();
        microphoneSourceStreamRef.current = microphoneStream;
        const sourceTrack = microphoneStream.getAudioTracks()[0] ?? null;
        if (!sourceTrack) throw new Error('Microphone track unavailable');

        let outboundTrack = sourceTrack;
        try {
          const audioContext = new AudioContext();
          const source = audioContext.createMediaStreamSource(new MediaStream([sourceTrack]));
          const gain = audioContext.createGain();
          const destination = audioContext.createMediaStreamDestination();
          gain.gain.value = inputVolumeRef.current / 100;
          source.connect(gain).connect(destination);
          microphoneAudioContextRef.current = audioContext;
          microphoneGainRef.current = gain;
          outboundTrack = destination.stream.getAudioTracks()[0] ?? sourceTrack;
          void audioContext.resume().catch(() => undefined);
        } catch {
          // O áudio bruto continua disponível caso o pipeline de ganho não exista.
        }

        microphoneTrackRef.current = outboundTrack;
        callOutboundStreamRef.current.addTrack(outboundTrack);
        outboundTrack.enabled = microphoneEnabledRef.current;
        setMicrophoneAvailable(true);
        outboundTrack.addEventListener('ended', () => {
          if (microphoneTrackRef.current !== outboundTrack) return;
          microphoneTrackRef.current = null;
          microphoneEnabledRef.current = false;
          setMicrophoneEnabled(false);
          setMicrophoneAvailable(false);
          for (const peer of peersRef.current.values()) void peer.callAudioSender.replaceTrack(null).catch(() => undefined);
          broadcastMediaState({ microphoneEnabled: false });
        }, { once: true });

        await Promise.all([...peersRef.current.values()].map(peer => peer.callAudioSender.replaceTrack(outboundTrack)));
        return outboundTrack;
      } catch {
        disposeMicrophonePipeline();
        setMicrophoneAvailable(false);
        return null;
      } finally {
        microphoneRequestRef.current = null;
      }
    })();
    microphoneRequestRef.current = request;
    return request;
  }, [broadcastMediaState, disposeMicrophonePipeline]);

  const toggleMicrophone = useCallback(async () => {
    const nextEnabled = !microphoneEnabledRef.current;
    microphoneEnabledRef.current = nextEnabled;
    setMicrophoneEnabled(nextEnabled);

    if (!nextEnabled) {
      if (microphoneTrackRef.current) microphoneTrackRef.current.enabled = false;
      broadcastMediaState({ microphoneEnabled: false });
      return;
    }

    const track = await ensureHostMicrophone();
    if (!track) {
      microphoneEnabledRef.current = false;
      setMicrophoneEnabled(false);
      broadcastMediaState({ microphoneEnabled: false });
      return;
    }
    track.enabled = true;
    await Promise.all([...peersRef.current.values()].map(peer => peer.callAudioSender.replaceTrack(track).catch(() => undefined)));
    broadcastMediaState({ microphoneEnabled: true });
  }, [broadcastMediaState, ensureHostMicrophone]);

  const changeHostInputDevice = useCallback(async (deviceId: string) => {
    hostInputDeviceIdRef.current = deviceId;
    setHostInputDeviceId(deviceId);
    const microphoneWasAvailable = microphoneAvailable === true;
    if (!microphoneWasAvailable) return;
    disposeMicrophonePipeline();
    const track = await ensureHostMicrophone();
    if (!track) {
      microphoneEnabledRef.current = false;
      setMicrophoneEnabled(false);
      broadcastMediaState({ microphoneEnabled: false });
    }
  }, [broadcastMediaState, disposeMicrophonePipeline, ensureHostMicrophone, microphoneAvailable]);

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
    const activeScreen = streamRef.current;
    streamRef.current = null;
    stopStream(activeScreen);
    disposeMicrophonePipeline();
    for (const track of screenOutboundStreamRef.current.getTracks()) screenOutboundStreamRef.current.removeTrack(track);
    setLocalStream(null);
    setScreenShareState('idle');
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
    chatMessagesRef.current = [];
    setChatMessages([]);
    setChatUnread(0);
    setPanelSection('stream');
    setError(message);
    setStatus('error');
  }, [clearConnectionTimer, clearReconnectTimer, destroyAllPeers, disposeMicrophonePipeline]);

  const stopScreenShare = useCallback(async (announce = true) => {
    const stream = streamRef.current;
    if (!stream || stoppingRef.current) return;
    streamRef.current = null;
    setLocalStream(null);
    setScreenShareState('idle');
    setSourceLabel('');
    setProfileStatus('idle');
    screenAudioTracksRef.current = [];
    for (const track of screenOutboundStreamRef.current.getTracks()) screenOutboundStreamRef.current.removeTrack(track);
    videoPausedRef.current = false;
    setVideoPaused(false);
    setAudioAvailable(null);
    await Promise.all([...peersRef.current.values()].flatMap(peer => [
      peer.screenVideoSender.replaceTrack(null).catch(() => undefined),
      peer.screenAudioSender.replaceTrack(null).catch(() => undefined)
    ]));
    stopStream(stream);
    broadcastMediaState({ screenSharing: false, videoPaused: false, screenAudioEnabled: false });
    if (announce && inviteRef.current) publishSystemMessage('O compartilhamento de tela foi encerrado.');
  }, [broadcastMediaState, publishSystemMessage]);
  stopSharingRef.current = () => { void stopScreenShare(); };

  const endCall = useCallback(() => {
    stoppingRef.current = true;
    clearConnectionTimer();
    clearReconnectTimer();
    send(socketRef.current, { type: 'leave-room' });
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Host ended');
    destroyAllPeers();
    const activeScreen = streamRef.current;
    streamRef.current = null;
    stopStream(activeScreen);
    disposeMicrophonePipeline();
    for (const track of screenOutboundStreamRef.current.getTracks()) screenOutboundStreamRef.current.removeTrack(track);
    inviteRef.current = null;
    setLocalStream(null);
    setScreenShareState('idle');
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
    chatMessagesRef.current = [];
    setChatMessages([]);
    setChatUnread(0);
    setPanelSection('stream');
    setError('');
    setStatus('idle');
  }, [clearConnectionTimer, clearReconnectTimer, destroyAllPeers, disposeMicrophonePipeline]);

  const createPeerForViewer = useCallback(async (peerId: string, force = false) => {
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
    if (!viewerLabelsRef.current.has(peerId)) viewerLabelsRef.current.set(peerId, nextViewerLabelRef.current++);
    if (viewerVolumesRef.current[peerId] === undefined) {
      viewerVolumesRef.current = { ...viewerVolumesRef.current, [peerId]: 100 };
      setViewerVolumes(viewerVolumesRef.current);
    }

    const microphoneTrack = microphoneTrackRef.current?.readyState === 'live' ? microphoneTrackRef.current : null;
    const screenVideoTrack = streamRef.current?.getVideoTracks()[0] ?? null;
    const screenAudioTrack = streamRef.current?.getAudioTracks()[0] ?? null;
    const callAudioTransceiver = pc.addTransceiver(microphoneTrack ?? 'audio', {
      direction: 'sendrecv',
      streams: [callOutboundStreamRef.current]
    });
    const screenVideoTransceiver = pc.addTransceiver(screenVideoTrack ?? 'video', {
      direction: 'sendonly',
      streams: [screenOutboundStreamRef.current]
    });
    const screenAudioTransceiver = pc.addTransceiver(screenAudioTrack ?? 'audio', {
      direction: 'sendonly',
      streams: [screenOutboundStreamRef.current]
    });
    const chatChannel = pc.createDataChannel('chat', { ordered: true });
    chatChannel.bufferedAmountLowThreshold = 64_000;

    const record: PeerRecord = {
      id: peerId,
      pc,
      queued: [],
      remoteAudio: null,
      callAudioSender: callAudioTransceiver.sender,
      screenVideoSender: screenVideoTransceiver.sender,
      screenAudioSender: screenAudioTransceiver.sender,
      chatChannel,
      displayName: ''
    };
    peersRef.current.set(peerId, record);
    syncAudience();

    const attachViewerAudio = (track: MediaStreamTrack) => {
      const currentStream = record.remoteAudio?.srcObject instanceof MediaStream ? record.remoteAudio.srcObject : null;
      if (currentStream?.getTrackById(track.id)) return;
      if (record.remoteAudio) {
        currentStream?.getTracks().forEach(previousTrack => previousTrack.stop());
        record.remoteAudio.srcObject = null;
        record.remoteAudio.remove();
      }
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = new MediaStream([track]);
      audio.dataset.screenlinkViewer = peerId;
      audio.style.display = 'none';
      document.body.append(audio);
      record.remoteAudio = audio;
      applyViewerVolume(peerId);
      const syncRemoteVoice = () => syncAudience();
      track.addEventListener('mute', syncRemoteVoice);
      track.addEventListener('unmute', syncRemoteVoice);
      track.addEventListener('ended', () => {
        if (record.remoteAudio !== audio) return;
        audio.srcObject = null;
        audio.remove();
        record.remoteAudio = null;
        syncAudience();
      }, { once: true });
      syncAudience();
      void audio.play().catch(() => undefined);
    };
    attachViewerAudio(callAudioTransceiver.receiver.track);

    if (screenVideoTrack) {
      screenVideoTrack.contentHint = videoProfileRef.current.fps >= 45 ? 'motion' : 'detail';
      await configureVideoSender(screenVideoTransceiver.sender, videoProfileRef.current).catch(() => undefined);
    }

    chatChannel.onopen = () => {
      const history = [...chatMessagesRef.current];
      while (history.length > 1 && JSON.stringify({ type: 'chat-history', messages: history }).length > 15_000) history.shift();
      sendChatPayload(chatChannel, { type: 'chat-history', messages: history });
      syncAudience();
    };
    chatChannel.onmessage = event => {
      if (typeof event.data !== 'string') return;
      const payload = parseChatPayload(event.data);
      if (payload?.type === 'chat-profile') {
        record.displayName = payload.name;
        syncAudience();
        return;
      }
      if (payload?.type !== 'chat-send') return;
      const viewerNumber = viewerLabelsRef.current.get(peerId) ?? 1;
      const message: ChatMessage = {
        id: messageId(),
        kind: 'message',
        senderId: peerId,
        senderName: record.displayName || `Espectador ${viewerNumber}`,
        text: payload.text,
        sentAt: Date.now()
      };
      appendChatMessage(message, true);
      broadcastChatMessage(message);
    };
    chatChannel.onclose = () => {
      if (record.chatChannel === chatChannel) record.chatChannel = null;
    };

    pc.onicecandidate = event => {
      if (event.candidate) send(socketRef.current, { type: 'ice-candidate', peerId, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = event => {
      if (event.track.kind !== 'audio') return;
      attachViewerAudio(event.track);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnectionQuality('good');
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
  }, [appendChatMessage, applyViewerVolume, broadcastChatMessage, broadcastMediaState, destroyPeer, syncAudience]);

  const handleSignal = useCallback(async (message: ServerMessage) => {
    if (message.type === 'room-created') {
      clearConnectionTimer();
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      iceServersRef.current = message.iceServers;
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
      setStatus('connected');
      setError('');
      setSessionStartedAt(current => current ?? Date.now());
      syncAudience();
      return;
    }
    if (message.type === 'viewer-joined') {
      const wasKnown = viewerLabelsRef.current.has(message.peerId);
      const peer = peersRef.current.get(message.peerId);
      const shouldRebuild = Boolean(peer && (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed' || peer.pc.connectionState === 'disconnected'));
      await createPeerForViewer(message.peerId, shouldRebuild);
      if (!message.resumed && !wasKnown) {
        const viewerNumber = viewerLabelsRef.current.get(message.peerId) ?? 1;
        publishSystemMessage(`Espectador ${viewerNumber} entrou na chamada.`);
      }
      return;
    }
    if (message.type === 'viewer-left') {
      const viewerNumber = viewerLabelsRef.current.get(message.peerId);
      destroyPeer(message.peerId);
      if (viewerNumber) publishSystemMessage(`Espectador ${viewerNumber} saiu da chamada.`);
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
  }, [clearConnectionTimer, clearReconnectTimer, createPeerForViewer, destroyPeer, failSession, publishSystemMessage, syncAudience]);
  handleSignalRef.current = handleSignal;

  const connectHostSignal = useCallback(() => {
    const invite = inviteRef.current;
    if (!invite || stoppingRef.current) return;

    clearConnectionTimer();
    const previousSocket = socketRef.current;
    socketRef.current = null;
    if (previousSocket?.readyState === WebSocket.OPEN || previousSocket?.readyState === WebSocket.CONNECTING) {
      previousSocket.close(1000, 'Replacing connection');
    }

    const socket = new WebSocket(signalUrl());
    socketRef.current = socket;
    setStatus(reconnectAttemptRef.current ? 'reconnecting' : 'starting');
    setError('');

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

  const startCall = useCallback(async () => {
    if (status === 'starting' || status === 'reconnecting' || status === 'connected') return;
    setError('');
    setCopied(false);
    stoppingRef.current = false;
    setStatus('starting');

    if (microphoneEnabledRef.current) {
      const microphone = await ensureHostMicrophone();
      if (!microphone) {
        microphoneEnabledRef.current = false;
        setMicrophoneEnabled(false);
      }
    }

    const invite = createPrivateRoom();
    inviteRef.current = invite;
    setShareUrl(inviteUrl(invite, viewerOriginRef.current));
    reconnectAttemptRef.current = 0;
    connectHostSignalRef.current();
  }, [ensureHostMicrophone, status]);

  const startScreenShare = useCallback(async () => {
    if (screenShareState === 'selecting') return;
    setHostScreenMenuOpen(false);
    setError('');
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Use Chrome ou Edge no computador para compartilhar a tela.');
      return;
    }
    if (!inviteRef.current) {
      setError('Inicie a chamada antes de compartilhar uma tela.');
      return;
    }

    const previousStream = streamRef.current;
    let selectedStream: MediaStream | null = null;
    setScreenShareState('selecting');
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
      selectedStream = stream;
      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (!videoTrack) throw new Error('Screen video track unavailable');
      videoTrack.contentHint = selectedProfile.fps >= 45 ? 'motion' : 'detail';
      const screenAudioTracks = stream.getAudioTracks();
      const screenAudioTrack = screenAudioTracks[0] ?? null;
      for (const track of screenAudioTracks) track.enabled = audioEnabledRef.current;

      const outboundStream = screenOutboundStreamRef.current;
      for (const track of outboundStream.getTracks()) outboundStream.removeTrack(track);
      outboundStream.addTrack(videoTrack);
      if (screenAudioTrack) outboundStream.addTrack(screenAudioTrack);

      await Promise.all([...peersRef.current.values()].map(async peer => {
        await peer.screenVideoSender.replaceTrack(videoTrack);
        await peer.screenAudioSender.replaceTrack(screenAudioTrack);
        await configureVideoSender(peer.screenVideoSender, selectedProfile).catch(() => undefined);
      }));

      streamRef.current = stream;
      screenAudioTracksRef.current = screenAudioTracks;
      setLocalStream(stream);
      setSourceLabel(videoTrack.label || 'Tela ou janela selecionada');
      setAudioAvailable(Boolean(screenAudioTrack));
      videoPausedRef.current = false;
      setVideoPaused(false);
      setScreenShareState('sharing');
      videoTrack.addEventListener('ended', () => {
        if (streamRef.current?.getVideoTracks()[0] === videoTrack) stopSharingRef.current();
      }, { once: true });
      if (previousStream && previousStream !== stream) stopStream(previousStream);
      broadcastMediaState({
        screenSharing: true,
        videoPaused: false,
        screenAudioEnabled: Boolean(screenAudioTrack && audioEnabledRef.current)
      });
      publishSystemMessage(previousStream ? 'A tela compartilhada foi trocada.' : 'O compartilhamento de tela começou.');
    } catch (reason) {
      if (selectedStream && selectedStream !== streamRef.current) stopStream(selectedStream);
      const outboundStream = screenOutboundStreamRef.current;
      for (const track of outboundStream.getTracks()) outboundStream.removeTrack(track);
      for (const track of previousStream?.getTracks() ?? []) outboundStream.addTrack(track);
      const previousVideoTrack = previousStream?.getVideoTracks()[0] ?? null;
      const previousAudioTrack = previousStream?.getAudioTracks()[0] ?? null;
      await Promise.all([...peersRef.current.values()].flatMap(peer => [
        peer.screenVideoSender.replaceTrack(previousVideoTrack).catch(() => undefined),
        peer.screenAudioSender.replaceTrack(previousAudioTrack).catch(() => undefined)
      ]));
      setScreenShareState(previousStream ? 'sharing' : 'idle');
      if ((reason as DOMException)?.name !== 'NotAllowedError') {
        setError('Não foi possível compartilhar essa tela. Tente outra fonte ou um perfil menor.');
      }
    }
  }, [broadcastMediaState, publishSystemMessage, screenShareState]);

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
    if (!shareUrl) {
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

        if (streamRef.current && automaticQualityRef.current && !adapting) {
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
  }, [applyVideoProfile, shareUrl]);

  useEffect(() => {
    const recoverSignaling = () => {
      if (!inviteRef.current || stoppingRef.current) return;
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
      execute: () => ({ call: status === 'connected', sharing: Boolean(localStream), viewer: audience })
    });
    safeRegister({
      name: 'stop_screen_share',
      title: 'Stop screen sharing',
      description: 'End the active ScreenLink transmission on this computer.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => {
        if (!localStream) throw new Error('No ScreenLink screen share is active.');
        void stopScreenShare();
        return { sharing: false };
      }
    });
    return () => lifecycle.abort();
  }, [audience, localStream, status, stopScreenShare]);

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
    ? 'Acordando servidor'
    : status === 'reconnecting'
      ? 'Reconectando'
      : status === 'connected'
        ? 'Chamada ativa'
        : status === 'error' ? 'Atenção' : 'Pronto';
  const audienceCopy = connectedViewerCount > 0
    ? `${connectedViewerCount} espectador${connectedViewerCount === 1 ? '' : 'es'} conectado${connectedViewerCount === 1 ? '' : 's'} · limite ${maxViewers}`
    : audience === 'connecting'
      ? `${viewerCount || 1} espectador${viewerCount === 1 ? '' : 'es'} conectando…`
      : `Aguardando espectadores · limite ${maxViewers}`;
  const screenAudioCopy = !localStream
    ? 'Disponível ao compartilhar uma tela'
    : audioAvailable
      ? audioEnabled ? 'Som da tela sendo enviado' : 'Som da tela silenciado'
      : 'Fonte selecionada sem áudio';
  const microphoneCopy = microphoneAvailable === null
    ? microphoneEnabled ? 'Será solicitado ao iniciar a chamada' : 'Desativado'
    : microphoneAvailable
      ? microphoneEnabled ? 'Sua voz está sendo enviada' : 'Microfone silenciado'
      : 'Permissão não concedida — clique para tentar novamente';
  const viewerMixer = viewerIds.map((peerId, index) => {
    const peer = peersRef.current.get(peerId);
    const remoteStream = peer?.remoteAudio?.srcObject instanceof MediaStream ? peer.remoteAudio.srcObject : null;
    return {
      id: peerId,
      label: peer?.displayName || `Espectador ${viewerLabelsRef.current.get(peerId) ?? index + 1}`,
      connected: peer?.pc.connectionState === 'connected',
      hasAudio: Boolean(remoteStream?.getAudioTracks().some(track => track.readyState === 'live' && !track.muted)),
      volume: viewerVolumes[peerId] ?? 100
    };
  });
  const viewerAudioCount = viewerMixer.filter(viewer => viewer.hasAudio).length;
  const callActive = Boolean(shareUrl);
  const canChat = [...peersRef.current.values()].some(peer => peer.chatChannel?.readyState === 'open');

  return (
    <div className="app">
      <Header
        status={hostLabel}
        live={status === 'connected'}
        meta={callActive ? `${sessionDuration} · ${connectedViewerCount}/${maxViewers} na chamada` : 'Sessão privada · P2P'}
      />
      <main className="host-main">
        <section className={`share-stage ${localStream ? 'is-live' : ''} ${videoPaused ? 'is-paused' : ''}`}>
          <video ref={videoRef} autoPlay playsInline muted />
          {!localStream && (
            <div className="stage-empty">
              <ScreenLinkMascot />
              <span className="eyebrow">
                {status === 'starting' ? 'Preparando a sala' : status === 'reconnecting' ? 'Recuperando a conexão' : callActive ? 'Chamada em andamento' : 'Voz, tela e chat P2P'}
              </span>
              <h1>{status === 'starting' ? 'Acordando servidor…' : status === 'reconnecting' ? 'Reconectando chamada…' : callActive ? 'Nenhuma tela compartilhada' : 'Inicie uma chamada'}</h1>
              <p>{callActive
                ? `${connectedViewerCount ? `${connectedViewerCount} pessoa${connectedViewerCount === 1 ? '' : 's'} conectada${connectedViewerCount === 1 ? '' : 's'}` : 'Aguardando alguém entrar'} · a conversa continua sem vídeo.`
                : 'Crie a sala primeiro. Depois, compartilhe, troque ou pare a tela sem derrubar a conversa.'}</p>
              {!callActive && status !== 'starting' && status !== 'reconnecting' && (
                <button className="primary-action" type="button" onClick={startCall}>
                  <Icon name="call" /> Iniciar chamada
                </button>
              )}
              {callActive && status === 'connected' && (
                <button className="primary-action" type="button" onClick={startScreenShare} disabled={screenShareState === 'selecting'}>
                  <Icon name="screen" /> {screenShareState === 'selecting' ? 'Abrindo seletor…' : 'Compartilhar tela'}
                </button>
              )}
              <small className="stage-note"><Icon name="shield" /> A chamada segue ativa quando a tela para.</small>
              {error && <p className="error-message" role="alert">{error}</p>}
            </div>
          )}
          {localStream && (
            <>
              <div className={`live-badge ${videoPaused ? 'paused' : ''}`}>{videoPaused ? 'Transmissão pausada' : `${resolution}p · até ${fps} FPS`}</div>
              <div className="source-live-chip"><Icon name="screen" /><span><strong>{sourceLabel}</strong></span></div>
            </>
          )}
          {callActive && (
            <div className="host-call-dock" ref={hostDockRef} aria-label="Controles da chamada">
              <button className={`dock-connection-indicator ${connectionQuality}`} type="button" aria-label={`Conexão: ${connectionMetrics.rttMs ? `${connectionMetrics.rttMs} milissegundos` : 'calculando latência'}`}>
                <Icon name="signal" />
                <span className="connection-tooltip" role="tooltip">
                  <strong>{connectionMetrics.rttMs ? `${connectionMetrics.rttMs} ms` : 'Calculando ping…'}</strong>
                  <small>{sessionDuration} de chamada</small>
                </span>
              </button>
              <span className="dock-divider" />
              {localStream && (
                <button type="button" onClick={toggleVideoPaused} aria-label={videoPaused ? 'Retomar transmissão' : 'Pausar transmissão'} aria-pressed={videoPaused} data-label={videoPaused ? 'Retomar' : 'Pausar'}>
                  <Icon name={videoPaused ? 'play' : 'pause'} />
                </button>
              )}
              <button className={audioEnabled && audioAvailable ? 'is-on' : ''} type="button" onClick={toggleScreenAudio} aria-label={audioEnabled ? 'Silenciar áudio da tela' : 'Ativar áudio da tela'} aria-pressed={Boolean(localStream && audioEnabled && audioAvailable)} data-label="Som da tela" disabled={!localStream || audioAvailable === false}>
                <Icon name={localStream && audioEnabled && audioAvailable ? 'volume' : 'volumeOff'} />
              </button>
              <div className="dock-split-control">
                <button className={microphoneEnabled && microphoneAvailable ? 'is-on' : ''} type="button" onClick={toggleMicrophone} aria-label={microphoneEnabled ? 'Silenciar microfone' : 'Ativar microfone'} aria-pressed={microphoneEnabled && microphoneAvailable === true} data-label="Microfone">
                  <Icon name={microphoneEnabled && microphoneAvailable ? 'microphone' : 'microphoneOff'} />
                </button>
                <button className={`dock-chevron ${hostAudioMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setHostAudioMenuOpen(current => !current); setHostScreenMenuOpen(false); }} aria-label="Configurações de áudio" aria-expanded={hostAudioMenuOpen} data-label="Ajustes"><Icon name="chevron" /></button>
              </div>
              <div className="dock-split-control screen-split-control">
                <button type="button" onClick={startScreenShare} aria-label={localStream ? 'Trocar tela compartilhada' : 'Compartilhar tela'} data-label={localStream ? 'Trocar tela' : 'Compartilhar'} disabled={status !== 'connected' || screenShareState === 'selecting'}>
                  <Icon name="screen" />
                </button>
                <button className={`dock-chevron ${hostScreenMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setHostScreenMenuOpen(current => !current); setHostAudioMenuOpen(false); }} aria-label="Configurações do compartilhamento" aria-expanded={hostScreenMenuOpen} data-label="Ajustes"><Icon name="chevron" /></button>
              </div>
              {localStream && (
                <button type="button" onClick={() => void stopScreenShare()} aria-label="Parar compartilhamento de tela" data-label="Parar tela"><Icon name="screenOff" /></button>
              )}
              <button className={panelSection === 'chat' ? 'is-on' : ''} type="button" onClick={() => { setPanelSection('chat'); setHostAudioMenuOpen(false); setHostScreenMenuOpen(false); }} aria-label="Abrir chat" data-label="Chat">
                <Icon name="message" />{chatUnread > 0 && <b className="dock-unread">{Math.min(chatUnread, 99)}</b>}
              </button>
              <span className="dock-divider" />
              <button className="hangup" type="button" onClick={endCall} aria-label="Encerrar chamada" data-label="Encerrar"><Icon name="hangup" /></button>
              {hostAudioMenuOpen && (
                <section className="dock-popover audio-popover" aria-label="Configurações rápidas de áudio">
                  <header><strong>Áudio</strong><small>DISPOSITIVOS E VOZ</small></header>
                  <div className="device-picker-stack">
                    <DevicePicker id="host-input-device" label="Dispositivo de entrada" icon="microphone" value={hostInputDeviceId} devices={hostAudioDevices.inputs} onChange={deviceId => void changeHostInputDevice(deviceId)} />
                    <DevicePicker id="host-output-device" label="Dispositivo de saída" icon="volume" value={hostOutputDeviceId} devices={hostAudioDevices.outputs} onChange={changeHostOutputDevice} />
                  </div>
                  <div className="audio-popover-scroll">
                    <section className="audio-menu-section">
                      <header><strong>Envio</strong><small>PARA TODOS</small></header>
                      <ToggleRow icon={localStream && audioEnabled && audioAvailable ? 'volume' : 'volumeOff'} label="Áudio da tela" description={screenAudioCopy} checked={Boolean(localStream && audioEnabled && audioAvailable)} disabled={!localStream || audioAvailable === false} onClick={toggleScreenAudio} />
                      <ToggleRow icon={microphoneEnabled && microphoneAvailable ? 'microphone' : 'microphoneOff'} label="Microfone" description={microphoneCopy} checked={microphoneEnabled && microphoneAvailable === true} onClick={toggleMicrophone} />
                      <VolumeControl id="host-popover-input-volume" label="Volume de entrada" description="Ganho do seu microfone" value={inputVolume} disabled={microphoneAvailable === false} onChange={changeInputVolume} />
                    </section>
                    <section className="audio-menu-section">
                      <header><strong>Tratamento de voz</strong><small>MICROFONE</small></header>
                      <div className="voice-settings">
                        <VoiceSetting label="Isolamento de voz" description="Reduz ruídos ao redor" checked={hostVoiceProcessing.noiseSuppression} onChange={enabled => changeHostVoiceProcessing('noiseSuppression', enabled)} />
                        <VoiceSetting label="Controle de eco" description="Evita retorno nos alto-falantes" checked={hostVoiceProcessing.echoCancellation} onChange={enabled => changeHostVoiceProcessing('echoCancellation', enabled)} />
                        <VoiceSetting label="Ganho automático" description="Equilibra o volume da sua voz" checked={hostVoiceProcessing.autoGainControl} onChange={enabled => changeHostVoiceProcessing('autoGainControl', enabled)} />
                      </div>
                    </section>
                    <section className="audio-menu-section">
                      <header><strong>Retorno dos espectadores</strong><small>{viewerAudioCount} COM ÁUDIO</small></header>
                      <VolumeControl id="host-popover-output-volume" label="Volume de saída" description="Retorno geral neste computador" value={outputVolume} onChange={changeOutputVolume} />
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
                </section>
              )}
              {hostScreenMenuOpen && (
                <section className="dock-popover more-popover screen-popover" aria-label="Configurações do compartilhamento">
                  <header><strong>Compartilhamento</strong><small>TELA E QUALIDADE</small></header>
                  <button type="button" onClick={startScreenShare} disabled={status !== 'connected' || screenShareState === 'selecting'}><Icon name="screen" /><span><strong>{localStream ? 'Trocar tela' : 'Escolher tela'}</strong><small>Tela, janela ou aba do navegador</small></span></button>
                  {localStream && (
                    <>
                      <button type="button" onClick={toggleVideoPaused}><Icon name={videoPaused ? 'play' : 'pause'} /><span><strong>{videoPaused ? 'Retomar transmissão' : 'Pausar transmissão'}</strong><small>A chamada continua normalmente</small></span><i>{videoPaused ? 'Pausada' : ''}</i></button>
                      <button type="button" onClick={toggleScreenAudio} disabled={audioAvailable === false}><Icon name={audioEnabled && audioAvailable ? 'volume' : 'volumeOff'} /><span><strong>Áudio da tela</strong><small>{screenAudioCopy}</small></span><i>{audioEnabled && audioAvailable ? 'Ativo' : ''}</i></button>
                    </>
                  )}
                  <button type="button" onClick={() => { setPanelSection('stream'); setHostScreenMenuOpen(false); }}><Icon name="auto" /><span><strong>Qualidade do vídeo</strong><small>{automaticQuality ? `Automática · ${resolution}p · ${fps} FPS` : `Manual · ${resolution}p · ${fps} FPS`}</small></span></button>
                </section>
              )}
            </div>
          )}
        </section>

        <aside className="control-panel">
          <header className="panel-header">
            <div><h2>Controles</h2></div>
            <span className="audience-count">{connectedViewerCount}/{maxViewers}</span>
          </header>

          <nav className="panel-tabs" role="tablist" aria-label="Seções dos controles" style={{ '--tab-index': panelSection === 'stream' ? 0 : 1, '--tab-count': 2 } as CSSProperties}>
            <button type="button" role="tab" aria-selected={panelSection === 'stream'} aria-controls="stream-panel" className={panelSection === 'stream' ? 'is-active' : ''} onClick={() => { setPanelSection('stream'); setHostAudioMenuOpen(false); setHostScreenMenuOpen(false); }}>Chamada</button>
            <button type="button" role="tab" aria-selected={panelSection === 'chat'} aria-controls="chat-panel" className={panelSection === 'chat' ? 'is-active' : ''} onClick={() => { setPanelSection('chat'); setHostAudioMenuOpen(false); setHostScreenMenuOpen(false); }}>Chat <span>{chatUnread || ''}</span></button>
          </nav>

          <div className="panel-view">
            {panelSection === 'stream' && (
              <div id="stream-panel" role="tabpanel" className="panel-page">
                <section className="panel-section invite-section" aria-labelledby="invite-title">
                  <div className="section-heading"><h3 id="invite-title">Convite da chamada</h3><small>{shareUrl ? audienceCopy : 'APÓS INICIAR'}</small></div>
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
                    </>
                  ) : (
                    <p className="empty-row"><Icon name="link" /> Inicie a chamada para criar o convite.</p>
                  )}
                </section>

                <section className="panel-section quality-section" aria-labelledby="quality-title">
                  <div className="section-heading"><h3 id="quality-title">Qualidade do vídeo</h3><small>{automaticQuality ? 'AUTOMÁTICA' : 'MANUAL'}</small></div>
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
                    <SegmentedControl label="Espectadores" suffix="máximo" options={VIEWER_LIMITS} value={maxViewers} disabled={callActive} onChange={setMaxViewers} />
                  </div>
                  <p className={`profile-summary ${profileStatus}`} aria-live="polite"><i />{profileStatus === 'applying' ? 'Aplicando…' : profileStatus === 'error' ? 'Modo compatível mantido' : 'Bitrate adaptativo ativo'}</p>
                </section>
              </div>
            )}

            {panelSection === 'chat' && (
              <div id="chat-panel" role="tabpanel" className="panel-page chat-page">
                <ChatPanel
                  messages={chatMessages}
                  currentSenderId="host"
                  canSend={canChat}
                  placeholder={canChat ? 'Escrever mensagem…' : 'Aguardando alguém entrar…'}
                  displayName={hostName}
                  displayNamePlaceholder="Apresentador"
                  appearance={hostChatAppearance}
                  onDisplayNameChange={changeHostName}
                  onAppearanceChange={changeHostChatAppearance}
                  onSend={sendHostChat}
                />
              </div>
            )}
          </div>

          <footer className="panel-footer"><Icon name="shield" /><span>Voz, tela e chat P2P · nada é gravado</span></footer>
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
  const viewerDockRef = useRef<HTMLDivElement>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const viewerSocketRef = useRef<WebSocket | null>(null);
  const viewerPeerRef = useRef<RTCPeerConnection | null>(null);
  const viewerPeerIdRef = useRef('');
  const viewerMicrophoneStreamRef = useRef<MediaStream | null>(null);
  const viewerMicrophoneSourceTrackRef = useRef<MediaStreamTrack | null>(null);
  const viewerMicrophoneTrackRef = useRef<MediaStreamTrack | null>(null);
  const viewerMicrophoneAudioContextRef = useRef<AudioContext | null>(null);
  const viewerMicrophoneGainRef = useRef<GainNode | null>(null);
  const viewerMicrophoneSenderRef = useRef<RTCRtpSender | null>(null);
  const ensureViewerMicrophoneRef = useRef<() => Promise<void>>(async () => undefined);
  const viewerMicrophoneEnabledRef = useRef(false);
  const viewerInputDeviceIdRef = useRef('');
  const viewerInputVolumeRef = useRef(100);
  const viewerVoiceProcessingRef = useRef<VoiceProcessing>({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  const viewerChatChannelRef = useRef<RTCDataChannel | null>(null);
  const viewerChatMessagesRef = useRef<ChatMessage[]>([]);
  const viewerChatOpenRef = useRef(false);
  const viewerNameRef = useRef('Espectador');
  const leaveViewerRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [message, setMessage] = useState('Conectando ao computador…');
  const [hasAudio, setHasAudio] = useState(false);
  const [viewerMuted, setViewerMuted] = useState(true);
  const [streamDetails, setStreamDetails] = useState('');
  const [viewerQuality, setViewerQuality] = useState<ConnectionQuality>('waiting');
  const [viewerMetrics, setViewerMetrics] = useState<ConnectionMetrics>({ bitrateKbps: 0, availableKbps: 0, rttMs: 0, packetLoss: 0 });
  const [remotePaused, setRemotePaused] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenAudioActive, setScreenAudioActive] = useState(false);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [viewerMicrophoneEnabled, setViewerMicrophoneEnabled] = useState(false);
  const [viewerMicrophoneAvailable, setViewerMicrophoneAvailable] = useState<boolean | null>(null);
  const [viewerMicrophoneMessage, setViewerMicrophoneMessage] = useState('');
  const [keepAwake, setKeepAwake] = useState(true);
  const [wakeActive, setWakeActive] = useState(false);
  const [viewerStartedAt, setViewerStartedAt] = useState<number | null>(null);
  const [viewerChatMessages, setViewerChatMessages] = useState<ChatMessage[]>([]);
  const [viewerChatUnread, setViewerChatUnread] = useState(0);
  const [viewerChatOpen, setViewerChatOpen] = useState(false);
  const [viewerChatReady, setViewerChatReady] = useState(false);
  const [viewerName, setViewerName] = useState(() => storedDisplayName('screenlink-viewer-name', 'Espectador'));
  const [viewerChatAppearance, setViewerChatAppearance] = useState(() => storedChatAppearance('screenlink-viewer-chat-appearance'));
  const [viewerAudioMenuOpen, setViewerAudioMenuOpen] = useState(false);
  const [viewerMoreMenuOpen, setViewerMoreMenuOpen] = useState(false);
  const [viewerInputDeviceId, setViewerInputDeviceId] = useState('');
  const [viewerOutputDeviceId, setViewerOutputDeviceId] = useState('');
  const [viewerInputVolume, setViewerInputVolume] = useState(100);
  const [viewerOutputVolume, setViewerOutputVolume] = useState(100);
  const [viewerVoiceProcessing, setViewerVoiceProcessing] = useState<VoiceProcessing>({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  const viewerAudioDevices = useAudioDevices(viewerAudioMenuOpen);
  const viewerDuration = useSessionDuration(viewerStartedAt);
  const closeViewerMenus = useCallback(() => {
    setViewerAudioMenuOpen(false);
    setViewerMoreMenuOpen(false);
  }, []);
  useDismissOnOutside(viewerDockRef, viewerAudioMenuOpen || viewerMoreMenuOpen, closeViewerMenus);

  useEffect(() => { viewerChatMessagesRef.current = viewerChatMessages; }, [viewerChatMessages]);
  useEffect(() => { viewerNameRef.current = normalizeDisplayName(viewerName) || 'Espectador'; }, [viewerName]);
  useEffect(() => {
    viewerChatOpenRef.current = viewerChatOpen;
    if (viewerChatOpen) setViewerChatUnread(0);
  }, [viewerChatOpen]);
  useEffect(() => { setHasAudio(screenAudioActive || microphoneActive); }, [microphoneActive, screenAudioActive]);
  useEffect(() => {
    if (status === 'connected') return;
    setViewerAudioMenuOpen(false);
    setViewerMoreMenuOpen(false);
  }, [status]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = viewerOutputVolume / 100;
  }, [viewerOutputVolume]);

  const changeViewerName = useCallback((value: string) => {
    const nextValue = value.slice(0, 24);
    setViewerName(nextValue);
    const normalized = normalizeDisplayName(nextValue);
    viewerNameRef.current = normalized || 'Espectador';
    rememberDisplayName('screenlink-viewer-name', normalized);
    if (normalized) sendChatPayload(viewerChatChannelRef.current, { type: 'chat-profile', name: normalized });
  }, []);

  const changeViewerChatAppearance = useCallback((appearance: ChatAppearance) => {
    setViewerChatAppearance(appearance);
    rememberChatAppearance('screenlink-viewer-chat-appearance', appearance);
  }, []);

  const receiveViewerChat = useCallback((incoming: ChatMessage[], notify: boolean) => {
    const messagesById = new Map(viewerChatMessagesRef.current.map(message => [message.id, message]));
    for (const message of incoming) messagesById.set(message.id, message);
    const nextMessages = [...messagesById.values()].sort((a, b) => a.sentAt - b.sentAt).slice(-CHAT_HISTORY_LIMIT);
    viewerChatMessagesRef.current = nextMessages;
    setViewerChatMessages(nextMessages);
    if (notify && !viewerChatOpenRef.current) {
      const ownId = viewerPeerIdRef.current;
      const unread = incoming.filter(message => message.kind === 'message' && message.senderId !== ownId).length;
      if (unread) setViewerChatUnread(current => current + unread);
    }
  }, []);

  const sendViewerChat = useCallback((text: string) => {
    const normalized = normalizeChatText(text);
    if (!normalized) return;
    sendChatPayload(viewerChatChannelRef.current, { type: 'chat-send', text: normalized });
  }, []);

  useEffect(() => {
    setViewerStartedAt(null);
    setViewerAudioMenuOpen(false);
    setViewerMoreMenuOpen(false);
    setViewerChatOpen(false);
    setViewerChatUnread(0);
    viewerChatMessagesRef.current = [];
    setViewerChatMessages([]);
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
    let queuedCandidates: RTCIceCandidateInit[] = [];
    let previousBytes: { bytes: number; at: number } | null = null;
    let signalChain = Promise.resolve();

    function clearPeerTimers() {
      if (peerTimer !== null) window.clearTimeout(peerTimer);
      if (statsTimer !== null) window.clearInterval(statsTimer);
      peerTimer = null;
      statsTimer = null;
    }

    function destroyViewerPeer() {
      clearPeerTimers();
      const chatChannel = viewerChatChannelRef.current;
      viewerChatChannelRef.current = null;
      if (chatChannel) {
        chatChannel.onopen = null;
        chatChannel.onmessage = null;
        chatChannel.onclose = null;
        chatChannel.close();
      }
      setViewerChatReady(false);
      if (peer) {
        peer.ontrack = null;
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.ondatachannel = null;
        peer.close();
      }
      peer = null;
      viewerPeerRef.current = null;
      viewerMicrophoneSenderRef.current = null;
      remoteStream = null;
      queuedCandidates = [];
      if (videoRef.current) videoRef.current.srcObject = null;
      setHasAudio(false);
      setViewerMuted(true);
      setStreamDetails('');
      setViewerQuality('waiting');
      setViewerMetrics({ bitrateKbps: 0, availableKbps: 0, rttMs: 0, packetLoss: 0 });
      setRemotePaused(false);
      setScreenSharing(false);
      setScreenAudioActive(false);
      setMicrophoneActive(false);
      previousBytes = null;
    }

    async function ensureViewerMicrophone() {
      const track = viewerMicrophoneTrackRef.current;
      const sender = viewerMicrophoneSenderRef.current;
      if (disposed || !sender || !track || !viewerMicrophoneEnabledRef.current) return;
      await sender.replaceTrack(track);
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

    function attachRemoteTrack(currentPeer: RTCPeerConnection, track: MediaStreamTrack) {
      if (remoteStream?.getTrackById(track.id)) return;
      const isFirstTrack = remoteStream === null;
      remoteStream ??= new MediaStream();
      remoteStream.addTrack(track);
      if (videoRef.current) {
        videoRef.current.srcObject = remoteStream;
        if (isFirstTrack) {
          videoRef.current.muted = true;
          setViewerMuted(true);
        }
        void videoRef.current.play().catch(() => undefined);
      }
      if (track.kind === 'video') {
        track.addEventListener('unmute', () => {
          startViewerStats(currentPeer);
        });
      }
    }

    function connect() {
      if (disposed || terminal) return;
      if (activeSocket?.readyState === WebSocket.OPEN || activeSocket?.readyState === WebSocket.CONNECTING) return;
      const socket = new WebSocket(signalUrl());
      activeSocket = socket;
      viewerSocketRef.current = socket;
      if (peer?.connectionState !== 'connected') {
        setStatus('connecting');
        setMessage(attempt ? 'Reconectando ao computador…' : 'Acordando servidor e procurando a chamada…');
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
        signalChain = signalChain
          .then(() => handleMessage(serverMessage, socket))
          .catch(() => {
            destroyViewerPeer();
            socket.close(4002, 'WebRTC failed');
            retry('A chamada não conectou. Tentando novamente…', true);
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
          void ensureViewerMicrophoneRef.current().catch(() => undefined);
          if (currentExistingPeer.connectionState === 'connected') {
            setStatus('connected');
            setMessage('');
          }
          return;
        }
        destroyViewerPeer();
        peerId = serverMessage.peerId;
        viewerPeerIdRef.current = peerId;
        setStatus('connecting');
        setMessage('Entrando na chamada…');
        peer = new RTCPeerConnection({
          iceServers: serverMessage.iceServers as RTCIceServer[],
          bundlePolicy: 'max-bundle',
          iceCandidatePoolSize: 4
        });
        const currentPeer = peer;
        viewerPeerRef.current = currentPeer;
        currentPeer.ondatachannel = event => {
          if (event.channel.label !== 'chat') return;
          const channel = event.channel;
          viewerChatChannelRef.current = channel;
          channel.bufferedAmountLowThreshold = 64_000;
          const markReady = () => {
            setViewerChatReady(true);
            sendChatPayload(channel, { type: 'chat-profile', name: viewerNameRef.current });
          };
          channel.onopen = markReady;
          if (channel.readyState === 'open') markReady();
          channel.onmessage = chatEvent => {
            if (typeof chatEvent.data !== 'string') return;
            const payload = parseChatPayload(chatEvent.data);
            if (payload?.type === 'chat-history') receiveViewerChat(payload.messages, false);
            if (payload?.type === 'chat-message') receiveViewerChat([payload.message], true);
          };
          channel.onclose = () => {
            if (viewerChatChannelRef.current === channel) viewerChatChannelRef.current = null;
            setViewerChatReady(false);
          };
        };
        currentPeer.onicecandidate = event => {
          if (event.candidate) send(socket, { type: 'ice-candidate', peerId, candidate: event.candidate.toJSON() });
        };
        currentPeer.ontrack = event => attachRemoteTrack(currentPeer, event.track);
        currentPeer.onconnectionstatechange = () => {
          if (currentPeer.connectionState === 'connected') {
            if (peerTimer !== null) window.clearTimeout(peerTimer);
            peerTimer = null;
            peerFailures = 0;
            setStatus('connected');
            setMessage('');
            setViewerStartedAt(current => current ?? Date.now());
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
          if (peerFailures >= 3) failPermanently('O computador foi encontrado, mas a rede bloqueou a chamada direta.');
          else {
            destroyViewerPeer();
            socket.close(4002, 'WebRTC timeout');
          }
        }, 18_000);
        return;
      }
      if (serverMessage.type === 'offer') {
        if (!peer || serverMessage.peerId !== peerId) return;
        if (peer.signalingState === 'have-local-offer') await peer.setLocalDescription({ type: 'rollback' });
        await peer.setRemoteDescription(serverMessage.sdp);
        const transceivers = peer.getTransceivers();
        const audioTransceivers = transceivers.filter(transceiver => transceiver.receiver.track.kind === 'audio');
        const callAudioTransceiver = audioTransceivers[0];
        const screenAudioTransceiver = audioTransceivers[1];
        const screenVideoTransceiver = transceivers.find(transceiver => transceiver.receiver.track.kind === 'video');
        if (!callAudioTransceiver || !screenAudioTransceiver || !screenVideoTransceiver) throw new Error('Expected media transceivers were not negotiated');
        callAudioTransceiver.direction = 'sendrecv';
        screenAudioTransceiver.direction = 'recvonly';
        screenVideoTransceiver.direction = 'recvonly';
        viewerMicrophoneSenderRef.current = callAudioTransceiver.sender;
        attachRemoteTrack(peer, callAudioTransceiver.receiver.track);
        attachRemoteTrack(peer, screenVideoTransceiver.receiver.track);
        attachRemoteTrack(peer, screenAudioTransceiver.receiver.track);
        const microphoneTrack = viewerMicrophoneTrackRef.current;
        if (microphoneTrack) {
          microphoneTrack.enabled = viewerMicrophoneEnabledRef.current;
          await callAudioTransceiver.sender.replaceTrack(microphoneTrack);
        }
        for (const candidate of queuedCandidates.splice(0)) await peer.addIceCandidate(candidate).catch(() => undefined);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send(socket, { type: 'answer', peerId, sdp: answer });
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
        setScreenSharing(serverMessage.screenSharing);
        setRemotePaused(serverMessage.videoPaused);
        setScreenAudioActive(serverMessage.screenAudioEnabled);
        setMicrophoneActive(serverMessage.microphoneEnabled);
        if (!serverMessage.screenSharing) setStreamDetails('');
        return;
      }
      if (serverMessage.type === 'host-ended') {
        terminal = true;
        destroyViewerPeer();
        viewerChatMessagesRef.current = [];
        setViewerChatMessages([]);
        setViewerChatUnread(0);
        setViewerChatOpen(false);
        setStatus('ended');
        setMessage('A chamada foi encerrada no computador.');
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

    leaveViewerRef.current = () => {
      if (terminal) return;
      terminal = true;
      send(activeSocket, { type: 'leave-room' });
      activeSocket?.close(1000, 'Viewer left');
      destroyViewerPeer();
      viewerChatMessagesRef.current = [];
      setViewerChatMessages([]);
      setViewerChatUnread(0);
      setViewerChatOpen(false);
      setStatus('ended');
      setMessage('Você saiu da chamada.');
    };

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
      viewerMicrophoneSourceTrackRef.current = null;
      const microphoneTrack = viewerMicrophoneTrackRef.current;
      if (microphoneTrack && microphoneTrack.readyState === 'live') microphoneTrack.stop();
      viewerMicrophoneTrackRef.current = null;
      viewerMicrophoneGainRef.current = null;
      const microphoneContext = viewerMicrophoneAudioContextRef.current;
      viewerMicrophoneAudioContextRef.current = null;
      if (microphoneContext && microphoneContext.state !== 'closed') void microphoneContext.close().catch(() => undefined);
      viewerMicrophoneSenderRef.current = null;
      ensureViewerMicrophoneRef.current = async () => undefined;
      leaveViewerRef.current = () => {};
      sessionStorage.removeItem(`screenlink-peer:${invite.roomId}`);
    };
  }, [invite.roomId, invite.token, receiveViewerChat]);

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
      if (disposed || status !== 'connected' || !keepAwake || document.visibilityState !== 'visible' || !wakeNavigator.wakeLock) return;
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

  const callConnected = status === 'connected';
  const label = callConnected ? 'Chamada ativa' : status === 'ended' ? 'Encerrado' : status === 'error' ? 'Atenção' : 'Conectando';
  const title = status === 'ended'
    ? 'Chamada encerrada'
    : status === 'error'
      ? 'Não foi possível entrar'
      : callConnected
        ? 'Chamada em andamento'
        : 'Entrando na chamada';

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

  async function acquireViewerMicrophone(deviceId = viewerInputDeviceIdRef.current) {
    if (!navigator.mediaDevices?.getUserMedia) {
      setViewerMicrophoneAvailable(false);
      setViewerMicrophoneMessage('Este navegador não oferece acesso ao microfone.');
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: microphoneConstraints(deviceId, viewerVoiceProcessingRef.current)
      });
      const sourceTrack = stream.getAudioTracks()[0] ?? null;
      if (!sourceTrack) throw new Error('Microphone track unavailable');

      let outboundTrack = sourceTrack;
      let nextContext: AudioContext | null = null;
      let nextGain: GainNode | null = null;
      try {
        nextContext = new AudioContext();
        const source = nextContext.createMediaStreamSource(new MediaStream([sourceTrack]));
        nextGain = nextContext.createGain();
        nextGain.gain.value = viewerInputVolumeRef.current / 100;
        const destination = nextContext.createMediaStreamDestination();
        source.connect(nextGain).connect(destination);
        outboundTrack = destination.stream.getAudioTracks()[0] ?? sourceTrack;
        void nextContext.resume().catch(() => undefined);
      } catch {
        if (nextContext && nextContext.state !== 'closed') void nextContext.close().catch(() => undefined);
        nextContext = null;
        nextGain = null;
      }

      const previousStream = viewerMicrophoneStreamRef.current;
      const previousSourceTrack = viewerMicrophoneSourceTrackRef.current;
      const previousOutboundTrack = viewerMicrophoneTrackRef.current;
      const previousContext = viewerMicrophoneAudioContextRef.current;
      viewerMicrophoneStreamRef.current = stream;
      viewerMicrophoneSourceTrackRef.current = sourceTrack;
      viewerMicrophoneTrackRef.current = outboundTrack;
      viewerMicrophoneAudioContextRef.current = nextContext;
      viewerMicrophoneGainRef.current = nextGain;
      outboundTrack.enabled = viewerMicrophoneEnabledRef.current;

      sourceTrack.addEventListener('mute', () => {
        if (viewerMicrophoneSourceTrackRef.current === sourceTrack && viewerMicrophoneEnabledRef.current) {
          setViewerMicrophoneMessage('O sistema suspendeu temporariamente o microfone.');
        }
      });
      sourceTrack.addEventListener('unmute', () => {
        if (viewerMicrophoneSourceTrackRef.current === sourceTrack && viewerMicrophoneEnabledRef.current) {
          setViewerMicrophoneMessage('Seu microfone está ativo.');
        }
      });
      sourceTrack.addEventListener('ended', () => {
        if (viewerMicrophoneSourceTrackRef.current !== sourceTrack) return;
        viewerMicrophoneSourceTrackRef.current = null;
        viewerMicrophoneTrackRef.current = null;
        void viewerMicrophoneSenderRef.current?.replaceTrack(null).catch(() => undefined);
        viewerMicrophoneEnabledRef.current = false;
        setViewerMicrophoneEnabled(false);
        setViewerMicrophoneAvailable(false);
        setViewerMicrophoneMessage('O acesso ao microfone foi encerrado pelo navegador ou pelo sistema.');
      }, { once: true });

      if (viewerMicrophoneEnabledRef.current) {
        await viewerMicrophoneSenderRef.current?.replaceTrack(outboundTrack).catch(() => undefined);
      }
      if (previousOutboundTrack && previousOutboundTrack !== previousSourceTrack && previousOutboundTrack.readyState === 'live') previousOutboundTrack.stop();
      stopStream(previousStream);
      if (previousContext && previousContext.state !== 'closed') void previousContext.close().catch(() => undefined);
      setViewerMicrophoneAvailable(true);
      return outboundTrack;
    } catch {
      setViewerMicrophoneAvailable(false);
      setViewerMicrophoneMessage('Permita o acesso ao microfone para falar com o apresentador.');
      return null;
    }
  }

  async function toggleViewerMicrophone() {
    let track = viewerMicrophoneTrackRef.current;
    if (viewerMicrophoneEnabledRef.current && track) {
      track.enabled = false;
      viewerMicrophoneEnabledRef.current = false;
      setViewerMicrophoneEnabled(false);
      setViewerMicrophoneMessage('Seu microfone está silenciado.');
      return;
    }

    if (!track || track.readyState === 'ended') track = await acquireViewerMicrophone();
    if (!track) return;
    track.enabled = true;
    viewerMicrophoneEnabledRef.current = true;
    setViewerMicrophoneEnabled(true);
    setViewerMicrophoneMessage('Seu microfone está ativo.');
    void ensureViewerMicrophoneRef.current().catch(() => {
      setViewerMicrophoneMessage('Microfone pronto; reconectando o canal de voz…');
    });
  }

  function changeViewerInputVolume(value: number) {
    viewerInputVolumeRef.current = value;
    setViewerInputVolume(value);
    const context = viewerMicrophoneAudioContextRef.current;
    const gain = viewerMicrophoneGainRef.current;
    if (context && gain) gain.gain.setTargetAtTime(value / 100, context.currentTime, .015);
  }

  async function changeViewerInputDevice(deviceId: string) {
    viewerInputDeviceIdRef.current = deviceId;
    setViewerInputDeviceId(deviceId);
    if (viewerMicrophoneAvailable === true) await acquireViewerMicrophone(deviceId);
  }

  async function changeViewerOutputDevice(deviceId: string) {
    setViewerOutputDeviceId(deviceId);
    const video = videoRef.current as SinkableMediaElement | null;
    if (video?.setSinkId) await video.setSinkId(deviceId).catch(() => undefined);
  }

  function changeViewerVoiceProcessing(key: keyof VoiceProcessing, enabled: boolean) {
    const next = { ...viewerVoiceProcessingRef.current, [key]: enabled };
    viewerVoiceProcessingRef.current = next;
    setViewerVoiceProcessing(next);
    const sourceTrack = viewerMicrophoneSourceTrackRef.current;
    if (sourceTrack?.readyState === 'live') {
      void sourceTrack.applyConstraints(microphoneConstraints(viewerInputDeviceIdRef.current, next)).catch(() => {
        setViewerMicrophoneMessage('Este dispositivo não oferece todos os filtros selecionados.');
      });
    }
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

  const pictureInPictureSupported = Boolean((document as PictureInPictureDocument).pictureInPictureEnabled && (videoRef.current as PictureInPictureVideo | null)?.requestPictureInPicture);
  const wakeLockSupported = Boolean((navigator as WakeLockNavigator).wakeLock);

  return (
    <div className="app viewer-mode">
      <Header status={label} live={callConnected} meta={callConnected ? `${viewerDuration} · chamada privada` : undefined} />
      <main className="viewer-main">
        <section ref={stageRef} className={`viewer-stage ${callConnected && screenSharing ? 'has-video' : ''} ${remotePaused && screenSharing ? 'is-paused' : ''} ${viewerChatOpen ? 'chat-is-open' : ''}`} aria-live="polite">
          <video
            ref={videoRef}
            className="viewer-video"
            autoPlay
            playsInline
            muted={viewerMuted}
            onLoadedMetadata={updateStreamDetails}
          />
          {(!callConnected || !screenSharing) && (
            <div className="viewer-empty">
              {status === 'connecting' || callConnected ? (
                <ScreenLinkMascot />
              ) : (
                <div className={`connection-visual ${status}`} aria-hidden="true">
                  <Icon name="screen" />
                  <span className="connection-line"><i /></span>
                  <Icon name="link" />
                </div>
              )}
              <h1>{title}</h1>
              <p>{callConnected ? 'Aguardando o apresentador compartilhar uma tela. A voz e o chat continuam disponíveis.' : message}</p>
              {status === 'error' && <button className="retry-action" type="button" onClick={() => window.location.reload()}>Tentar novamente</button>}
            </div>
          )}
          {callConnected && hasAudio && viewerMuted && (
            <button className="sound-prompt" type="button" onClick={toggleViewerAudio}>
              <Icon name="volume" /> Ouvir áudio
            </button>
          )}
          {callConnected && screenSharing && remotePaused && (
            <div className="paused-overlay"><Icon name="pause" /><strong>Transmissão pausada</strong><span>O apresentador retomará em instantes.</span></div>
          )}
          {viewerChatOpen && (
            <aside className="viewer-chat" aria-label="Chat da chamada">
              <header><span><Icon name="message" /><strong>Chat</strong></span><button type="button" onClick={() => setViewerChatOpen(false)} aria-label="Fechar chat">×</button></header>
              <ChatPanel
                messages={viewerChatMessages}
                currentSenderId={viewerPeerIdRef.current}
                canSend={callConnected && viewerChatReady}
                placeholder={viewerChatReady ? 'Escrever mensagem…' : 'Conectando chat…'}
                displayName={viewerName}
                displayNamePlaceholder="Espectador"
                appearance={viewerChatAppearance}
                onDisplayNameChange={changeViewerName}
                onAppearanceChange={changeViewerChatAppearance}
                onSend={sendViewerChat}
              />
            </aside>
          )}
          <div className="viewer-bar" ref={viewerDockRef} aria-label="Controles do espectador">
            <div className="viewer-actions">
              {callConnected && (
                <>
                  <button className={`dock-connection-indicator ${viewerQuality}`} type="button" aria-label={`Conexão: ${viewerMetrics.rttMs ? `${viewerMetrics.rttMs} milissegundos` : 'calculando latência'}`}>
                    <Icon name="signal" />
                    <span className="connection-tooltip" role="tooltip">
                      <strong>{viewerMetrics.rttMs ? `${viewerMetrics.rttMs} ms` : 'Calculando ping…'}</strong>
                      <small>{viewerDuration} de chamada</small>
                    </span>
                  </button>
                  <span className="viewer-action-divider" />
                </>
              )}
              <button className={!viewerMuted && hasAudio ? 'is-on' : ''} type="button" onClick={toggleViewerAudio} aria-label={viewerMuted ? 'Ouvir áudio' : 'Silenciar áudio'} aria-pressed={!viewerMuted && hasAudio} data-label="Áudio" disabled={!callConnected || !hasAudio}>
                <Icon name={!hasAudio || viewerMuted ? 'volumeOff' : 'volume'} />
              </button>
              <div className="dock-split-control">
                <button className={viewerMicrophoneEnabled ? 'is-on' : ''} type="button" onClick={toggleViewerMicrophone} aria-label={viewerMicrophoneEnabled ? 'Silenciar seu microfone' : 'Ativar seu microfone'} aria-pressed={viewerMicrophoneEnabled} data-label="Falar" disabled={!callConnected} title={viewerMicrophoneMessage || undefined}>
                  <Icon name={viewerMicrophoneEnabled ? 'microphone' : 'microphoneOff'} />
                </button>
                <button className={`dock-chevron ${viewerAudioMenuOpen ? 'is-on' : ''}`} type="button" onClick={() => { setViewerAudioMenuOpen(current => !current); setViewerMoreMenuOpen(false); }} aria-label="Configurações de áudio" aria-expanded={viewerAudioMenuOpen} data-label="Ajustes" disabled={!callConnected}><Icon name="chevron" /></button>
              </div>
              <button className={viewerChatOpen ? 'is-on' : ''} type="button" onClick={() => { setViewerChatOpen(current => !current); setViewerAudioMenuOpen(false); setViewerMoreMenuOpen(false); }} aria-label={viewerChatOpen ? 'Fechar chat' : 'Abrir chat'} aria-pressed={viewerChatOpen} data-label="Chat" disabled={!callConnected}>
                <Icon name="message" />{viewerChatUnread > 0 && <b className="dock-unread">{Math.min(viewerChatUnread, 99)}</b>}
              </button>
              <button className={viewerMoreMenuOpen ? 'is-on' : ''} type="button" onClick={() => { setViewerMoreMenuOpen(current => !current); setViewerAudioMenuOpen(false); }} aria-label="Mais opções" aria-expanded={viewerMoreMenuOpen} data-label="Mais" disabled={!callConnected}><Icon name="more" /></button>
              <span className="viewer-action-divider" />
              <button className="hangup" type="button" onClick={() => leaveViewerRef.current()} aria-label="Sair da chamada" data-label="Sair" disabled={status === 'ended' || status === 'error'}><Icon name="hangup" /></button>
              {viewerAudioMenuOpen && (
                <section className="dock-popover audio-popover viewer-audio-popover" aria-label="Configurações de áudio">
                  <header><strong>Áudio</strong><small>DISPOSITIVOS E VOZ</small></header>
                  <div className="device-picker-stack">
                    <DevicePicker id="viewer-input-device" label="Dispositivo de entrada" icon="microphone" value={viewerInputDeviceId} devices={viewerAudioDevices.inputs} onChange={deviceId => void changeViewerInputDevice(deviceId)} />
                    <DevicePicker id="viewer-output-device" label="Dispositivo de saída" icon="volume" value={viewerOutputDeviceId} devices={viewerAudioDevices.outputs} onChange={deviceId => void changeViewerOutputDevice(deviceId)} />
                  </div>
                  <div className="audio-popover-scroll">
                    <section className="audio-menu-section">
                      <header><strong>Volumes</strong><small>ENTRADA E SAÍDA</small></header>
                      <VolumeControl id="viewer-input-volume" label="Volume de entrada" description="Ganho do seu microfone" value={viewerInputVolume} disabled={viewerMicrophoneAvailable === false} onChange={changeViewerInputVolume} />
                      <VolumeControl id="viewer-output-volume" label="Volume de saída" description="Áudio recebido da chamada" value={viewerOutputVolume} onChange={setViewerOutputVolume} />
                    </section>
                    <section className="audio-menu-section">
                      <header><strong>Tratamento de voz</strong><small>MICROFONE</small></header>
                      <div className="voice-settings">
                        <VoiceSetting label="Isolamento de voz" description="Reduz ruídos ao redor" checked={viewerVoiceProcessing.noiseSuppression} onChange={enabled => changeViewerVoiceProcessing('noiseSuppression', enabled)} />
                        <VoiceSetting label="Controle de eco" description="Evita retorno nos alto-falantes" checked={viewerVoiceProcessing.echoCancellation} onChange={enabled => changeViewerVoiceProcessing('echoCancellation', enabled)} />
                        <VoiceSetting label="Ganho automático" description="Equilibra sua voz" checked={viewerVoiceProcessing.autoGainControl} onChange={enabled => changeViewerVoiceProcessing('autoGainControl', enabled)} />
                      </div>
                    </section>
                  </div>
                </section>
              )}
              {viewerMoreMenuOpen && (
                <section className="dock-popover more-popover" aria-label="Mais opções da chamada">
                  <header><strong>Exibição</strong><small>MAIS OPÇÕES</small></header>
                  <button className={wakeActive ? 'is-selected' : ''} type="button" onClick={() => setKeepAwake(current => !current)} disabled={!wakeLockSupported}><Icon name="wake" /><span><strong>Tela sempre ativa</strong><small>{keepAwake ? 'Não adormecer durante a chamada' : 'Permitir que o aparelho adormeça'}</small></span><i>{keepAwake ? 'Ativa' : ''}</i></button>
                  <button type="button" onClick={() => { void togglePictureInPicture(); setViewerMoreMenuOpen(false); }} disabled={!screenSharing || !pictureInPictureSupported}><Icon name="pip" /><span><strong>Mini player</strong><small>Continuar assistindo em outra janela</small></span><Icon name="chevron" /></button>
                  <button type="button" onClick={() => { void openFullscreen(); setViewerMoreMenuOpen(false); }} disabled={!screenSharing}><Icon name="expand" /><span><strong>Tela cheia</strong><small>Usar toda a área da tela</small></span><Icon name="chevron" /></button>
                </section>
              )}
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
