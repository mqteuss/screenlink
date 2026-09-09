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
  | { type: 'room-created'; roomId: string; iceServers: IceServerConfig[] }
  | { type: 'joined'; roomId: string; peerId: string; iceServers: IceServerConfig[] }
  | { type: 'viewer-joined'; peerId: string }
  | { type: 'viewer-left'; peerId: string }
  | { type: 'offer'; peerId: string; sdp: SessionDescription }
  | { type: 'answer'; peerId: string; sdp: SessionDescription }
  | { type: 'ice-candidate'; peerId: string; candidate: RTCIceCandidateInit }
  | { type: 'host-ended' }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; at: number };

export type Invite = { roomId: string; token: string };

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
