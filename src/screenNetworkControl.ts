export type Resolution = 360 | 480 | 720 | 1080;
export type FrameRate = 15 | 30 | 45 | 60;

export const MIN_BITRATE_MBPS = 0.5;
export const MAX_BITRATE_MBPS = 20;
export const P2P_TOTAL_UPLOAD_BUDGET_MBPS = 18;

export const VIDEO_PRESETS: Record<Resolution, { width: number; height: number; bitrate: number }> = {
  360: { width: 640, height: 360, bitrate: 900_000 },
  480: { width: 854, height: 480, bitrate: 1_600_000 },
  720: { width: 1280, height: 720, bitrate: 3_600_000 },
  1080: { width: 1920, height: 1080, bitrate: 7_000_000 }
};

export const ADAPTIVE_NETWORK_PROFILES = [
  { bitrateFactor: 1, scaleResolutionDownBy: 1, frameRateFactor: 1 },
  { bitrateFactor: 0.72, scaleResolutionDownBy: 1.25, frameRateFactor: 0.85 },
  { bitrateFactor: 0.48, scaleResolutionDownBy: 1.65, frameRateFactor: 0.67 },
  { bitrateFactor: 0.3, scaleResolutionDownBy: 2.25, frameRateFactor: 0.5 }
] as const;

export type LossBaseline = {
  outboundTimestamp: number;
  remoteTimestamp: number | null;
  packetsSent: number;
  packetsLost: number;
};

export type PeerNetworkSnapshot = {
  streamKey: string;
  timestamp: number;
  bytesSent: number | null;
  packetsSent: number | null;
  lossBaseline: LossBaseline | null;
};

export type PeerNetworkMetrics = {
  rttMs: number | null;
  packetLoss: number | null;
  availableOutgoingMbps: number | null;
  outboundMbps: number | null;
  bandwidthLimited: boolean;
};

export type AdaptiveNetworkState = {
  networkLevel: number;
  poorNetworkSamples: number;
  healthyNetworkSamples: number;
};

export type StatsReportLike = {
  forEach: (callback: (stat: Record<string, unknown>) => void) => void;
};

export function recommendedBitrateMbps(resolution: Resolution, fps: FrameRate): number {
  return Math.min(MAX_BITRATE_MBPS, Math.max(MIN_BITRATE_MBPS, VIDEO_PRESETS[resolution].bitrate * (fps / 30) / 1_000_000));
}

export function adaptiveTargetBitrateMbps(resolution: Resolution, fps: FrameRate, peerCount: number, networkLevel: number): number {
  const profile = ADAPTIVE_NETWORK_PROFILES[Math.max(0, Math.min(ADAPTIVE_NETWORK_PROFILES.length - 1, networkLevel))];
  const perPeerBudget = Math.max(0.75, P2P_TOTAL_UPLOAD_BUDGET_MBPS / Math.max(1, peerCount));
  return Math.max(MIN_BITRATE_MBPS, Math.min(recommendedBitrateMbps(resolution, fps), perPeerBudget) * profile.bitrateFactor);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function finiteSsrc(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compareOutboundCandidates(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const packetsA = finiteNonNegative(a.packetsSent) ?? -1;
  const packetsB = finiteNonNegative(b.packetsSent) ?? -1;
  if (packetsA !== packetsB) return packetsA - packetsB;

  const bytesA = finiteNonNegative(a.bytesSent) ?? -1;
  const bytesB = finiteNonNegative(b.bytesSent) ?? -1;
  if (bytesA !== bytesB) return bytesA - bytesB;

  const tsA = finiteNonNegative(a.timestamp) ?? -1;
  const tsB = finiteNonNegative(b.timestamp) ?? -1;
  return tsA - tsB;
}

function hasLinkingId(stat: Record<string, unknown>): boolean {
  return Boolean(nonEmptyString(stat.remoteId) || nonEmptyString(stat.localId) || finiteSsrc(stat.ssrc) !== null);
}

function matchRemoteInboundForOutbound(
  outbound: Record<string, unknown>,
  outboundCount: number,
  remoteInbounds: Record<string, unknown>[]
): Record<string, unknown> | null {
  const remoteId = nonEmptyString(outbound.remoteId);
  if (remoteId) {
    const byRemoteId = remoteInbounds.find(remote => nonEmptyString(remote.id) === remoteId);
    if (byRemoteId) return byRemoteId;
  }

  const outboundId = nonEmptyString(outbound.id);
  if (outboundId) {
    const byLocalId = remoteInbounds.find(remote => nonEmptyString(remote.localId) === outboundId);
    if (byLocalId) return byLocalId;
  }

  const outboundSsrc = finiteSsrc(outbound.ssrc);
  if (outboundSsrc !== null) {
    const bySsrc = remoteInbounds.find(remote => finiteSsrc(remote.ssrc) === outboundSsrc);
    if (bySsrc) return bySsrc;
  }

  if (outboundCount === 1 && remoteInbounds.length === 1 && !hasLinkingId(outbound) && !hasLinkingId(remoteInbounds[0]!)) {
    return remoteInbounds[0]!;
  }

  return null;
}

export function extractPeerNetworkMetrics(
  report: StatsReportLike,
  previous: PeerNetworkSnapshot | null,
  nowMs = performance.now()
): { metrics: PeerNetworkMetrics; snapshot: PeerNetworkSnapshot | null } {
  let selectedPairId = '';
  const candidatePairs: Record<string, unknown>[] = [];
  const outboundVideos: Record<string, unknown>[] = [];
  const remoteInboundVideos: Record<string, unknown>[] = [];

  report.forEach(stat => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      selectedPairId = String(stat.selectedCandidatePairId);
    } else if (stat.type === 'candidate-pair') {
      candidatePairs.push(stat);
    } else if (stat.type === 'outbound-rtp' && !stat.isRemote && (stat.kind === 'video' || stat.mediaType === 'video')) {
      outboundVideos.push(stat);
    } else if (stat.type === 'remote-inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
      remoteInboundVideos.push(stat);
    }
  });

  let candidatePairRtt: number | null = null;
  let availableOutgoingMbps: number | null = null;
  for (const stat of candidatePairs) {
    const isSelectedPair = selectedPairId
      ? stat.id === selectedPairId
      : Boolean(stat.selected) || (Boolean(stat.nominated) && stat.state === 'succeeded');
    if (!isSelectedPair) continue;
    const rtt = finiteNonNegative(stat.currentRoundTripTime);
    if (rtt !== null) candidatePairRtt = Math.max(candidatePairRtt ?? 0, rtt * 1_000);
    const available = finiteNonNegative(stat.availableOutgoingBitrate);
    if (available !== null) availableOutgoingMbps = available / 1_000_000;
  }

  const activeOutbounds = outboundVideos.filter(stat => stat.active !== false);
  const outboundCandidates = activeOutbounds.length > 0 ? activeOutbounds : outboundVideos;
  let selectedOutbound: Record<string, unknown> | null = null;
  for (const candidate of outboundCandidates) {
    if (!selectedOutbound || compareOutboundCandidates(candidate, selectedOutbound) > 0) {
      selectedOutbound = candidate;
    }
  }

  if (!selectedOutbound) {
    let remoteInboundRtt: number | null = null;
    for (const remote of remoteInboundVideos) {
      const rtt = finiteNonNegative(remote.roundTripTime);
      if (rtt !== null) remoteInboundRtt = Math.max(remoteInboundRtt ?? 0, rtt * 1_000);
    }
    const rtt = candidatePairRtt ?? remoteInboundRtt;
    return {
      metrics: {
        rttMs: rtt === null ? null : Math.round(rtt),
        packetLoss: null,
        availableOutgoingMbps,
        outboundMbps: null,
        bandwidthLimited: false
      },
      snapshot: null
    };
  }

  const selectedRemoteInbound = matchRemoteInboundForOutbound(selectedOutbound, outboundVideos.length, remoteInboundVideos);
  const remoteInboundRttValue = selectedRemoteInbound ? finiteNonNegative(selectedRemoteInbound.roundTripTime) : null;
  const remoteInboundRtt = remoteInboundRttValue !== null ? remoteInboundRttValue * 1_000 : null;
  const rtt = candidatePairRtt ?? remoteInboundRtt;

  const outboundSsrc = finiteSsrc(selectedOutbound.ssrc);
  const outboundId = nonEmptyString(selectedOutbound.id);
  const streamKey = outboundSsrc !== null
    ? `ssrc:${outboundSsrc}`
    : outboundId
      ? `id:${outboundId}`
      : 'video-outbound';

  const bytesSent = finiteNonNegative(selectedOutbound.bytesSent);
  const packetsSent = finiteNonNegative(selectedOutbound.packetsSent);
  const outboundTimestamp = finitePositive(selectedOutbound.timestamp) ?? nowMs;
  const bandwidthLimited = selectedOutbound.qualityLimitationReason === 'bandwidth';

  const packetsLost = selectedRemoteInbound ? finiteNonNegative(selectedRemoteInbound.packetsLost) : null;
  const remoteTimestamp = selectedRemoteInbound ? finitePositive(selectedRemoteInbound.timestamp) : null;

  const sameStream = previous !== null && previous.streamKey === streamKey;
  const outboundMbps = sameStream
    && bytesSent !== null
    && previous.bytesSent !== null
    && outboundTimestamp > previous.timestamp
    && bytesSent >= previous.bytesSent
    ? ((bytesSent - previous.bytesSent) * 8) / ((outboundTimestamp - previous.timestamp) / 1_000) / 1_000_000
    : null;

  const prevBaseline = sameStream ? previous.lossBaseline : null;
  let packetLoss: number | null = null;
  let nextLossBaseline: LossBaseline | null = null;

  if (packetsSent === null) {
    packetLoss = null;
    nextLossBaseline = null;
  } else if (packetsLost === null) {
    packetLoss = null;
    nextLossBaseline = prevBaseline;
  } else {
    const currentBaseline: LossBaseline = { outboundTimestamp, remoteTimestamp, packetsSent, packetsLost };
    if (prevBaseline === null) {
      packetLoss = null;
      nextLossBaseline = currentBaseline;
    } else if (
      packetsSent < prevBaseline.packetsSent
      || packetsLost < prevBaseline.packetsLost
      || outboundTimestamp < prevBaseline.outboundTimestamp
      || (remoteTimestamp !== null && prevBaseline.remoteTimestamp !== null && remoteTimestamp < prevBaseline.remoteTimestamp)
    ) {
      packetLoss = null;
      nextLossBaseline = currentBaseline;
    } else if (remoteTimestamp !== null && prevBaseline.remoteTimestamp !== null) {
      if (remoteTimestamp === prevBaseline.remoteTimestamp) {
        packetLoss = null;
        nextLossBaseline = packetsLost === prevBaseline.packetsLost ? prevBaseline : currentBaseline;
      } else {
        const outboundElapsed = outboundTimestamp - prevBaseline.outboundTimestamp;
        const remoteElapsed = remoteTimestamp - prevBaseline.remoteTimestamp;
        if (outboundElapsed <= 0) {
          packetLoss = null;
          nextLossBaseline = currentBaseline;
        } else if (remoteElapsed < outboundElapsed * 0.25) {
          packetLoss = null;
          nextLossBaseline = prevBaseline;
        } else if (remoteElapsed > outboundElapsed * 4) {
          packetLoss = null;
          nextLossBaseline = currentBaseline;
        } else {
          nextLossBaseline = currentBaseline;
          const sentDelta = packetsSent - prevBaseline.packetsSent;
          const lostDelta = packetsLost - prevBaseline.packetsLost;
          packetLoss = sentDelta > 0 ? Math.min(1, lostDelta / sentDelta) : null;
        }
      }
    } else {
      nextLossBaseline = currentBaseline;
      const sentDelta = packetsSent - prevBaseline.packetsSent;
      const lostDelta = packetsLost - prevBaseline.packetsLost;
      packetLoss = sentDelta > 0 ? Math.min(1, lostDelta / sentDelta) : null;
    }
  }

  return {
    metrics: {
      rttMs: rtt === null ? null : Math.round(rtt),
      packetLoss,
      availableOutgoingMbps,
      outboundMbps,
      bandwidthLimited
    },
    snapshot: {
      streamKey,
      timestamp: outboundTimestamp,
      bytesSent,
      packetsSent,
      lossBaseline: nextLossBaseline
    }
  };
}

export function updateAdaptiveNetworkLevel(
  record: AdaptiveNetworkState,
  metrics: PeerNetworkMetrics,
  targetMbps: number,
  recoveryTargetMbps = targetMbps
): boolean {
  const lowLoss = metrics.packetLoss === null || metrics.packetLoss <= 0.015;
  const lowRtt = metrics.rttMs === null || metrics.rttMs <= 160;
  const recoveryTarget = Math.max(targetMbps * 1.35, recoveryTargetMbps);
  const bandwidthHeadroomCoversTarget = metrics.availableOutgoingMbps !== null
    && metrics.availableOutgoingMbps >= targetMbps
    && lowLoss
    && lowRtt;
  const bandwidthHeadroomForRecovery = metrics.availableOutgoingMbps !== null
    && metrics.availableOutgoingMbps >= recoveryTarget
    && lowLoss
    && lowRtt;
  const effectiveBandwidthLimited = metrics.bandwidthLimited && !bandwidthHeadroomCoversTarget;

  const poor = effectiveBandwidthLimited
    || (metrics.packetLoss !== null && metrics.packetLoss >= 0.06)
    || (metrics.rttMs !== null && metrics.rttMs >= 450)
    || (metrics.availableOutgoingMbps !== null && metrics.availableOutgoingMbps < targetMbps * 0.85);

  const healthy = lowLoss
    && lowRtt
    && (metrics.bandwidthLimited
      ? bandwidthHeadroomForRecovery
      : (metrics.availableOutgoingMbps === null || metrics.availableOutgoingMbps >= recoveryTarget));

  if (poor) {
    record.poorNetworkSamples += 1;
    record.healthyNetworkSamples = 0;
    if (record.poorNetworkSamples >= 2 && record.networkLevel < ADAPTIVE_NETWORK_PROFILES.length - 1) {
      record.networkLevel += 1;
      record.poorNetworkSamples = 0;
      return true;
    }
    return false;
  }

  if (healthy) {
    record.healthyNetworkSamples += 1;
    record.poorNetworkSamples = 0;
    if (record.healthyNetworkSamples >= 5 && record.networkLevel > 0) {
      record.networkLevel -= 1;
      record.healthyNetworkSamples = 0;
      return true;
    }
    return false;
  }

  record.poorNetworkSamples = 0;
  record.healthyNetworkSamples = 0;
  return false;
}
