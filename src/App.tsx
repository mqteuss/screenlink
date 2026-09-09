import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  createPrivateRoom,
  inviteUrl,
  parseInvite,
  signalUrl,
  type IceServerConfig,
  type Invite,
  type ServerMessage
} from './protocol';

type IconName = 'screen' | 'link' | 'shield' | 'stop' | 'copy' | 'phone' | 'expand' | 'check' | 'signal';
type HostStatus = 'idle' | 'starting' | 'live' | 'error';
type AudienceStatus = 'empty' | 'connecting' | 'connected';
type ViewerStatus = 'connecting' | 'waiting' | 'live' | 'ended' | 'error';
type PeerRecord = { id: string; pc: RTCPeerConnection; queued: RTCIceCandidateInit[] };
type RuntimeConfig = { viewerOrigin?: string; mode?: 'p2p-stun' };
type Resolution = 360 | 480 | 720 | 1080;
type FrameRate = 15 | 30 | 45 | 60;
type VideoProfile = { resolution: Resolution; fps: FrameRate };
type ProfileStatus = 'idle' | 'applying' | 'applied' | 'error';

const RESOLUTIONS: readonly Resolution[] = [360, 480, 720, 1080];
const FRAME_RATES: readonly FrameRate[] = [15, 30, 45, 60];
const VIDEO_SIZES: Record<Resolution, { width: number; height: number; bitrate: number }> = {
  360: { width: 640, height: 360, bitrate: 1_000_000 },
  480: { width: 854, height: 480, bitrate: 1_600_000 },
  720: { width: 1280, height: 720, bitrate: 3_500_000 },
  1080: { width: 1920, height: 1080, bitrate: 6_000_000 }
};

function videoSettings(profile: VideoProfile) {
  const size = VIDEO_SIZES[profile.resolution];
  const frameRateFactor = profile.fps === 15 ? .7 : profile.fps === 30 ? 1 : profile.fps === 45 ? 1.25 : 1.5;
  return { ...size, fps: profile.fps, bitrate: Math.round(size.bitrate * frameRateFactor) };
}

async function configureVideoSender(sender: RTCRtpSender, profile: VideoProfile) {
  const settings = videoSettings(profile);
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  parameters.encodings[0]!.maxBitrate = settings.bitrate;
  parameters.encodings[0]!.maxFramerate = settings.fps;
  parameters.degradationPreference = 'balanced';
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
      <div className="segmented-control" role="radiogroup" aria-label={label} style={{ '--active-index': activeIndex } as CSSProperties}>
        {options.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            disabled={disabled}
            className={option === value ? 'is-active' : ''}
            onClick={() => onChange(option)}
          >
            {option}{suffix === 'resolução' ? 'p' : ''}
          </button>
        ))}
      </div>
    </fieldset>
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
    signal: <><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8 16a6 6 0 0 1 8 0"/><path d="M11 19.5a2 2 0 0 1 2 0"/></>
  };

  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Header({ status, live = false }: { status: string; live?: boolean }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><span /></span><strong>ScreenLink</strong></div>
      <div className={`status-pill ${live ? 'live' : ''}`}><i />{status}</div>
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
  record.pc.close();
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop());
}

function HostApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<PeerRecord | null>(null);
  const inviteRef = useRef<Invite | null>(null);
  const viewerOriginRef = useRef(window.location.origin);
  const iceServersRef = useRef<IceServerConfig[]>([]);
  const videoProfileRef = useRef<VideoProfile>({ resolution: 720, fps: 30 });
  const profileRequestRef = useRef(0);
  const stoppingRef = useRef(false);
  const connectionTimerRef = useRef<number | null>(null);
  const stopSharingRef = useRef<() => void>(() => {});

  const [status, setStatus] = useState<HostStatus>('idle');
  const [audience, setAudience] = useState<AudienceStatus>('empty');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [resolution, setResolution] = useState<Resolution>(720);
  const [fps, setFps] = useState<FrameRate>(30);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('idle');
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

  const destroyPeer = useCallback(() => {
    closePeer(peerRef.current);
    peerRef.current = null;
    setAudience('empty');
  }, []);

  const clearConnectionTimer = useCallback(() => {
    if (connectionTimerRef.current !== null) {
      window.clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = null;
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
      const sender = peerRef.current?.pc.getSenders().find(candidate => candidate.track?.kind === 'video');
      if (sender) await configureVideoSender(sender, profile);
      if (profileRequestRef.current === requestId) setProfileStatus('applied');
    } catch {
      if (profileRequestRef.current === requestId) setProfileStatus('error');
    }
  }, []);

  const failSession = useCallback((message: string) => {
    stoppingRef.current = true;
    clearConnectionTimer();
    destroyPeer();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Session failed');
    stopStream(streamRef.current);
    streamRef.current = null;
    setLocalStream(null);
    inviteRef.current = null;
    setShareUrl('');
    setProfileStatus('idle');
    setError(message);
    setStatus('error');
  }, [clearConnectionTimer, destroyPeer]);

  const stopSharing = useCallback(() => {
    stoppingRef.current = true;
    clearConnectionTimer();
    send(socketRef.current, { type: 'leave-room' });
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Host ended');
    destroyPeer();
    stopStream(streamRef.current);
    streamRef.current = null;
    inviteRef.current = null;
    setLocalStream(null);
    setShareUrl('');
    setCopied(false);
    setProfileStatus('idle');
    setError('');
    setStatus('idle');
  }, [clearConnectionTimer, destroyPeer]);
  stopSharingRef.current = stopSharing;

  const createPeerForViewer = useCallback(async (peerId: string) => {
    const stream = streamRef.current;
    if (!stream) return;

    destroyPeer();
    setAudience('connecting');
    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current as RTCIceServer[],
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 2
    });
    const record: PeerRecord = { id: peerId, pc, queued: [] };
    peerRef.current = record;

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
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setAudience('connected');
      if (pc.connectionState === 'connecting') setAudience('connecting');
      if (pc.connectionState === 'disconnected') setAudience('connecting');
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (peerRef.current?.pc === pc) destroyPeer();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send(socketRef.current, { type: 'offer', peerId, sdp: offer });
  }, [destroyPeer]);

  const handleSignal = useCallback(async (message: ServerMessage) => {
    if (message.type === 'room-created') {
      clearConnectionTimer();
      iceServersRef.current = message.iceServers;
      setStatus('live');
      return;
    }
    if (message.type === 'viewer-joined') {
      await createPeerForViewer(message.peerId);
      return;
    }
    if (message.type === 'viewer-left') {
      if (peerRef.current?.id === message.peerId) destroyPeer();
      return;
    }
    if (message.type === 'answer') {
      const peer = peerRef.current;
      if (!peer || peer.id !== message.peerId) return;
      await peer.pc.setRemoteDescription(message.sdp);
      for (const candidate of peer.queued.splice(0)) {
        await peer.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      return;
    }
    if (message.type === 'ice-candidate') {
      const peer = peerRef.current;
      if (!peer || peer.id !== message.peerId) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate).catch(() => undefined);
      else peer.queued.push(message.candidate);
      return;
    }
    if (message.type === 'error') failSession(message.message);
  }, [clearConnectionTimer, createPeerForViewer, destroyPeer, failSession]);

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
        audio: false
      });
      stream.getVideoTracks()[0]!.contentHint = selectedProfile.fps >= 45 ? 'motion' : 'detail';
      streamRef.current = stream;
      setLocalStream(stream);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopSharingRef.current(), { once: true });

      const invite = createPrivateRoom();
      inviteRef.current = invite;
      setShareUrl(inviteUrl(invite, viewerOriginRef.current));

      const socket = new WebSocket(signalUrl());
      socketRef.current = socket;
      connectionTimerRef.current = window.setTimeout(() => {
        if (socketRef.current === socket && socket.readyState !== WebSocket.OPEN) {
          failSession('O servidor demorou para responder. Tente novamente em alguns segundos.');
        }
      }, 12_000);

      socket.onopen = () => send(socket, { type: 'create-room', ...invite });
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          void handleSignal(message).catch(() => failSession('A conexão com o outro dispositivo falhou. Tente novamente.'));
        } catch {
          failSession('O servidor enviou uma resposta inválida.');
        }
      };
      socket.onerror = () => {
        if (socketRef.current === socket && socket.readyState !== WebSocket.OPEN) {
          failSession('Não foi possível alcançar o servidor do ScreenLink.');
        }
      };
      socket.onclose = event => {
        if (socketRef.current === socket) socketRef.current = null;
        if (!stoppingRef.current && event.code !== 1000) {
          failSession('A conexão com o servidor foi interrompida. Inicie uma nova transmissão.');
        }
      };
    } catch (reason) {
      if ((reason as DOMException)?.name === 'NotAllowedError') {
        setStatus('idle');
      } else {
        failSession('Não foi possível iniciar o compartilhamento. Tente novamente.');
      }
    }
  }, [failSession, handleSignal]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => () => {
    stoppingRef.current = true;
    clearConnectionTimer();
    send(socketRef.current, { type: 'leave-room' });
    socketRef.current?.close(1000, 'Page closed');
    closePeer(peerRef.current);
    stopStream(streamRef.current);
  }, [clearConnectionTimer]);

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

  const hostLabel = status === 'starting' ? 'Preparando' : status === 'live' ? 'Compartilhando' : status === 'error' ? 'Atenção' : 'Pronto';
  const audienceCopy = audience === 'connected'
    ? '1 espectador conectado'
    : audience === 'connecting'
      ? 'Conectando ao espectador…'
      : 'Aguardando o outro dispositivo';

  return (
    <div className="app">
      <Header status={hostLabel} live={status === 'live'} />
      <main className="host-main">
        <section className={`share-stage ${localStream ? 'is-live' : ''}`}>
          <video ref={videoRef} autoPlay playsInline muted />
          {!localStream && (
            <div className="stage-copy">
              <span className="eyebrow"><Icon name="screen" /> Seu computador</span>
              <h1>Compartilhe sua tela.</h1>
              <p>Escolha uma tela ou janela. Depois, envie o link privado para quem vai assistir.</p>
              <button className="primary-action" type="button" onClick={startSharing} disabled={status === 'starting'}>
                <Icon name="screen" /> {status === 'starting' ? 'Preparando…' : 'Compartilhar minha tela'}
              </button>
              {error && <p className="error-message" role="alert">{error}</p>}
            </div>
          )}
          {localStream && <div className="live-badge"><span /> {resolution}p · até {fps} FPS</div>}
        </section>

        <aside className="control-panel">
          <div className="panel-heading">
            <span className="step-number">01</span>
            <div><h2>{localStream ? 'Tela selecionada' : 'Compartilhe'}</h2><p>{localStream ? 'A prévia está ativa neste computador.' : 'Você escolhe exatamente o que será mostrado.'}</p></div>
          </div>
          <section className="profile-controls" aria-label="Qualidade da transmissão">
            <SegmentedControl
              label="Qualidade"
              suffix="resolução"
              options={RESOLUTIONS}
              value={resolution}
              disabled={profileStatus === 'applying'}
              onChange={nextResolution => void applyVideoProfile({ resolution: nextResolution, fps })}
            />
            <SegmentedControl
              label="Fluidez"
              suffix="FPS"
              options={FRAME_RATES}
              value={fps}
              disabled={profileStatus === 'applying'}
              onChange={nextFps => void applyVideoProfile({ resolution, fps: nextFps })}
            />
            <p className={`profile-summary ${profileStatus}`} aria-live="polite">
              <i />
              {profileStatus === 'applying'
                ? 'Aplicando ajuste…'
                : profileStatus === 'error'
                  ? 'O navegador manteve o modo compatível.'
                  : `${resolution}p · até ${fps} FPS · bitrate adaptativo`}
            </p>
          </section>
          <div className="divider" />
          <div className={`panel-heading ${shareUrl ? '' : 'muted-step'}`}>
            <span className="step-number">02</span>
            <div><h2>Envie o link</h2><p>{shareUrl ? audienceCopy : 'O convite privado aparecerá aqui após escolher a tela.'}</p></div>
          </div>

          {shareUrl && (
            <div className="invite-card">
              <label htmlFor="invite-link">Link para assistir</label>
              <div className="invite-row">
                <input id="invite-link" ref={inviteInputRef} readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
                <button type="button" onClick={copyInvite} aria-label="Copiar link privado"><Icon name={copied ? 'check' : 'copy'} /></button>
              </div>
              <span className="copy-feedback" aria-live="polite">{copied ? 'Link copiado' : 'Abra este link no celular ou em outro PC'}</span>
            </div>
          )}

          {shareUrl && (
            <div className="network-note">
              <Icon name="signal" />
              <span><strong>P2P direto + STUN</strong>A qualidade se adapta à conexão. Sem TURN, algumas redes ou operadoras podem bloquear o vídeo.</span>
            </div>
          )}

          <div className="privacy-note"><Icon name="shield" /><span><strong>Conexão privada</strong>O vídeo não é gravado nem armazenado pelo ScreenLink.</span></div>
          {localStream && <button className="stop-action" type="button" onClick={stopSharing}><Icon name="stop" /> Encerrar compartilhamento</button>}
        </aside>
      </main>
    </div>
  );
}

function ViewerApp({ invite }: { invite: Invite }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [message, setMessage] = useState('Conectando ao computador…');

  useEffect(() => {
    let disposed = false;
    let terminal = false;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let activeSocket: WebSocket | null = null;
    let peer: RTCPeerConnection | null = null;
    let peerId = '';
    let queuedCandidates: RTCIceCandidateInit[] = [];

    function destroyViewerPeer() {
      if (peer) {
        peer.ontrack = null;
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }
      peer = null;
      peerId = '';
      queuedCandidates = [];
      if (videoRef.current) videoRef.current.srcObject = null;
    }

    function retry(copy: string) {
      if (disposed || terminal || reconnectTimer !== null) return;
      destroyViewerPeer();
      setStatus('connecting');
      setMessage(copy);
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

    function connect() {
      if (disposed || terminal) return;
      const socket = new WebSocket(signalUrl());
      activeSocket = socket;
      setStatus('connecting');
      setMessage(attempt ? 'Reconectando ao computador…' : 'Conectando ao computador…');

      socket.onopen = () => send(socket, { type: 'join-room', ...invite });
      socket.onerror = () => setMessage('O servidor está demorando para responder…');
      socket.onclose = event => {
        if (activeSocket === socket) activeSocket = null;
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
          socket.close(4002, 'WebRTC failed');
          retry('O vídeo não conectou. Tentando novamente…');
        });
      };
    }

    async function handleMessage(serverMessage: ServerMessage, socket: WebSocket) {
      if (serverMessage.type === 'joined') {
        attempt = 0;
        destroyViewerPeer();
        peerId = serverMessage.peerId;
        setStatus('waiting');
        setMessage('Conectado. Aguardando o vídeo…');
        peer = new RTCPeerConnection({
          iceServers: serverMessage.iceServers as RTCIceServer[],
          bundlePolicy: 'max-bundle',
          iceCandidatePoolSize: 2
        });
        const currentPeer = peer;
        currentPeer.onicecandidate = event => {
          if (event.candidate) send(socket, { type: 'ice-candidate', peerId, candidate: event.candidate.toJSON() });
        };
        currentPeer.ontrack = event => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            void videoRef.current.play().catch(() => undefined);
          }
          setStatus('live');
          setMessage('');
        };
        currentPeer.onconnectionstatechange = () => {
          if (currentPeer.connectionState === 'failed') socket.close(4002, 'WebRTC failed');
          if (currentPeer.connectionState === 'disconnected') {
            setStatus('connecting');
            setMessage('Recuperando a conexão…');
          }
        };
        return;
      }
      if (serverMessage.type === 'offer') {
        if (!peer || serverMessage.peerId !== peerId) return;
        await peer.setRemoteDescription(serverMessage.sdp);
        for (const candidate of queuedCandidates.splice(0)) await peer.addIceCandidate(candidate).catch(() => undefined);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send(socket, { type: 'answer', peerId, sdp: answer });
        return;
      }
      if (serverMessage.type === 'ice-candidate') {
        if (!peer || serverMessage.peerId !== peerId) return;
        if (peer.remoteDescription) await peer.addIceCandidate(serverMessage.candidate).catch(() => undefined);
        else queuedCandidates.push(serverMessage.candidate);
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
          retry('O computador ainda não está disponível. Tentando novamente…');
        } else if (serverMessage.code === 'ROOM_FULL') {
          failPermanently('Este link já está sendo usado em outro dispositivo.');
        } else {
          failPermanently(serverMessage.message);
        }
      }
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      send(activeSocket, { type: 'leave-room' });
      activeSocket?.close(1000, 'Viewer left');
      destroyViewerPeer();
    };
  }, [invite.roomId, invite.token]);

  const label = status === 'live' ? 'Ao vivo' : status === 'ended' ? 'Encerrado' : status === 'error' ? 'Atenção' : 'Conectando';
  const title = status === 'ended' ? 'Transmissão encerrada' : status === 'error' ? 'Não foi possível assistir' : 'Preparando a transmissão';

  async function openFullscreen() {
    await stageRef.current?.requestFullscreen?.();
  }

  return (
    <div className="app viewer-mode">
      <Header status={label} live={status === 'live'} />
      <main className="viewer-main">
        <section ref={stageRef} className={`viewer-stage ${status === 'live' ? 'has-video' : ''}`} aria-live="polite">
          <video ref={videoRef} autoPlay playsInline muted />
          {status !== 'live' && (
            <div className="viewer-empty">
              <div className={`connection-visual ${status}`} aria-hidden="true">
                <Icon name="screen" />
                <span className="connection-line"><i /></span>
                <Icon name={status === 'error' || status === 'ended' ? 'link' : 'phone'} />
              </div>
              <h1>{title}</h1>
              <p>{message}</p>
              {status === 'error' && <button className="retry-action" type="button" onClick={() => window.location.reload()}>Tentar novamente</button>}
            </div>
          )}
        </section>
        <div className="viewer-bar">
          <div><strong>{status === 'live' ? 'Tela compartilhada' : 'Link privado'}</strong><span>{status === 'live' ? 'Transmissão direta do computador' : 'Somente este dispositivo pode usar o convite agora'}</span></div>
          <button type="button" onClick={openFullscreen} aria-label="Abrir em tela cheia" disabled={status !== 'live'}><Icon name="expand" /></button>
        </div>
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
