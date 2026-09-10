export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type SessionDescription = {
  type: RTCSdpType;
  sdp?: string;
};

export type ServerMessage =
  | { type: 'room-created'; roomId: string; iceServers: IceServerConfig[]; maxViewers: number; viewerIds: string[] }
  | { type: 'joined'; roomId: string; peerId: string; iceServers: IceServerConfig[]; resumed?: boolean }
  | { type: 'viewer-joined'; peerId: string; resumed?: boolean }
  | { type: 'viewer-left'; peerId: string }
  | { type: 'offer'; peerId: string; sdp: SessionDescription }
  | { type: 'answer'; peerId: string; sdp: SessionDescription }
  | { type: 'ice-candidate'; peerId: string; candidate: RTCIceCandidateInit }
  | { type: 'media-state'; peerId: string; screenSharing: boolean; videoPaused: boolean; screenAudioEnabled: boolean; microphoneEnabled: boolean }
  | { type: 'host-ended' }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; at: number };

export type Invite = { roomId: string; token: string };

export type RoomProfile = {
  name: string;
  avatar: string;
  device: 'desktop' | 'mobile';
};

export type RoomParticipant = RoomProfile & {
  id: string;
  joinedAt: number;
  sharing: boolean;
  microphoneEnabled: boolean;
  connected: boolean;
};

export type RoomServerMessage =
  | {
      type: 'room-ready';
      roomId: string;
      selfId: string;
      leaderId: string;
      maxParticipants: number;
      isOwner: boolean;
      resumed: boolean;
      iceServers: IceServerConfig[];
      participants: RoomParticipant[];
    }
  | { type: 'participant-joined'; participant: RoomParticipant }
  | { type: 'participant-left'; peerId: string }
  | { type: 'participant-state'; participant: RoomParticipant }
  | { type: 'leader-changed'; leaderId: string; reclaimed: boolean }
  | { type: 'peer-signal'; fromId: string; signal: 'offer' | 'answer' | 'ice-candidate'; sdp?: SessionDescription; candidate?: RTCIceCandidateInit }
  | { type: 'room-closed' }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; at: number };

export type OwnedRoom = Invite & { ownerKey: string };

export function parseInvite(hash = window.location.hash): Invite | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const roomId = params.get('room')?.trim();
  const token = params.get('key')?.trim();
  return roomId && token ? { roomId, token } : null;
}

export function createPrivateRoom(): Invite {
  return {
    roomId: randomBase64Url(12),
    token: randomBase64Url(32)
  };
}

export function createOwnedRoom(): OwnedRoom {
  return {
    ...createPrivateRoom(),
    ownerKey: randomBase64Url(32)
  };
}

export function inviteCode(invite: Invite): string {
  return `${invite.roomId}.${invite.token}`;
}

export function parseInviteCode(value: string): Invite | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    if (/^https?:\/\//i.test(normalized)) {
      const url = new URL(normalized);
      return parseInvite(url.hash);
    }
  } catch {
    return null;
  }
  const [roomId, token, ...rest] = normalized.replace(/^#/, '').split('.');
  if (rest.length || !roomId || !token) return null;
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(roomId) || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  return { roomId, token };
}

export function inviteUrl(invite: Invite, origin = window.location.origin): string {
  const url = new URL(origin);
  url.hash = new URLSearchParams({ room: invite.roomId, key: invite.token }).toString();
  return url.toString();
}

export function signalUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
