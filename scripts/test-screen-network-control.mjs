import assert from 'node:assert/strict';
import {
  ADAPTIVE_NETWORK_PROFILES,
  adaptiveTargetBitrateMbps,
  extractPeerNetworkMetrics,
  updateAdaptiveNetworkLevel
} from '../src/screenNetworkControl.ts';

function makeStatsReport(entries) {
  return {
    forEach(callback) {
      for (const entry of entries) callback(entry);
    }
  };
}

function makeVideoStats({
  timestamp,
  bytesSent,
  packetsSent,
  packetsLost,
  remoteTimestamp = timestamp,
  availableOutgoingBitrate = 5_000_000,
  rttSeconds = 0.01,
  qualityLimitationReason = 'none',
  ssrc = 123456,
  outboundId = 'OTV01',
  remoteId = 'RIV01',
  active = true
}) {
  const stats = [
    {
      id: 'T01',
      type: 'transport',
      selectedCandidatePairId: 'CP01'
    },
    {
      id: 'CP01',
      type: 'candidate-pair',
      selected: true,
      nominated: true,
      state: 'succeeded',
      currentRoundTripTime: rttSeconds,
      availableOutgoingBitrate
    },
    {
      id: outboundId,
      type: 'outbound-rtp',
      isRemote: false,
      kind: 'video',
      mediaType: 'video',
      active,
      ssrc,
      remoteId,
      timestamp,
      bytesSent,
      packetsSent,
      qualityLimitationReason
    }
  ];

  if (packetsLost !== null && packetsLost !== undefined) {
    stats.push({
      id: remoteId,
      type: 'remote-inbound-rtp',
      kind: 'video',
      mediaType: 'video',
      ssrc,
      localId: outboundId,
      timestamp: remoteTimestamp,
      packetsLost,
      roundTripTime: rttSeconds
    });
  }

  return makeStatsReport(stats);
}

// 1. Packet loss math (Validation #4)
{
  const state = { networkLevel: 0, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
  let snapshot = null;

  // Baseline sample: no deltas yet
  const s0 = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 1_000, bytesSent: 100_000, packetsSent: 500, packetsLost: 10 }),
    snapshot
  );
  assert.equal(s0.metrics.packetLoss, null);
  assert.equal(s0.metrics.outboundMbps, null);
  snapshot = s0.snapshot;

  // Sample 1: 100 sent, 6 lost -> exact 6% (0.06), first poor sample does not degrade yet
  const s1 = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 3_000, bytesSent: 350_000, packetsSent: 600, packetsLost: 16 }),
    snapshot
  );
  assert.equal(s1.metrics.packetLoss, 0.06);
  snapshot = s1.snapshot;
  const target = adaptiveTargetBitrateMbps(720, 30, 1, state.networkLevel);
  assert.equal(updateAdaptiveNetworkLevel(state, s1.metrics, target), false);
  assert.equal(state.networkLevel, 0);
  assert.equal(state.poorNetworkSamples, 1);

  // Sample 2: another 100 sent, 6 lost -> exact 6% (0.06), second poor sample triggers level reduction
  const s2 = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 5_000, bytesSent: 600_000, packetsSent: 700, packetsLost: 22 }),
    snapshot
  );
  assert.equal(s2.metrics.packetLoss, 0.06);
  snapshot = s2.snapshot;
  assert.equal(updateAdaptiveNetworkLevel(state, s2.metrics, target), true);
  assert.equal(state.networkLevel, 1);

  // Zero-packet interval (ΔpacketsSent = 0) with 0 lost and with delayed ΔpacketsLost = 2 -> null, no degradation
  const sZero0 = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 7_000, bytesSent: 600_000, packetsSent: 700, packetsLost: 22 }),
    snapshot
  );
  assert.equal(sZero0.metrics.packetLoss, null);
  assert.equal(updateAdaptiveNetworkLevel(state, sZero0.metrics, target), false);
  assert.equal(state.networkLevel, 1);

  const sZeroDelayed = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 9_000, bytesSent: 600_000, packetsSent: 700, packetsLost: 24 }),
    sZero0.snapshot
  );
  assert.equal(sZeroDelayed.metrics.packetLoss, null);
  assert.equal(updateAdaptiveNetworkLevel(state, sZeroDelayed.metrics, target), false);
  assert.equal(state.networkLevel, 1);
}

// 2. Counter resets (packetsSent decrease, packetsLost decrease, SSRC change)
{
  const base = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 1_000, bytesSent: 200_000, packetsSent: 1_000, packetsLost: 20 }),
    null
  ).snapshot;

  const sentReset = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 3_000, bytesSent: 50_000, packetsSent: 100, packetsLost: 22 }),
    base
  );
  assert.equal(sentReset.metrics.packetLoss, null);
  assert.equal(sentReset.metrics.outboundMbps, null);

  const afterSentReset = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 5_000, bytesSent: 150_000, packetsSent: 200, packetsLost: 25 }),
    sentReset.snapshot
  );
  assert.equal(afterSentReset.metrics.packetLoss, 3 / 100);

  const lostReset = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 7_000, bytesSent: 250_000, packetsSent: 300, packetsLost: 2 }),
    afterSentReset.snapshot
  );
  assert.equal(lostReset.metrics.packetLoss, null);

  const afterLostReset = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 9_000, bytesSent: 350_000, packetsSent: 400, packetsLost: 6 }),
    lostReset.snapshot
  );
  assert.equal(afterLostReset.metrics.packetLoss, 4 / 100);

  const ssrcChanged = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 11_000, bytesSent: 500_000, packetsSent: 500, packetsLost: 10, ssrc: 999999 }),
    afterLostReset.snapshot
  );
  assert.equal(ssrcChanged.metrics.packetLoss, null);
  assert.equal(ssrcChanged.metrics.outboundMbps, null);

  const afterSsrcChange = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 13_000, bytesSent: 700_000, packetsSent: 700, packetsLost: 14, ssrc: 999999 }),
    ssrcChanged.snapshot
  );
  assert.equal(afterSsrcChange.metrics.packetLoss, 4 / 200);
}

// 3. Same-stream matching & inactive stream filtering
{
  const mismatchedReport = makeStatsReport([
    { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP01' },
    { id: 'CP01', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.01, availableOutgoingBitrate: 5_000_000 },
    { id: 'OV1', type: 'outbound-rtp', isRemote: false, kind: 'video', active: true, ssrc: 111, timestamp: 1_000, bytesSent: 100_000, packetsSent: 500 },
    { id: 'RI2', type: 'remote-inbound-rtp', kind: 'video', ssrc: 222, timestamp: 1_000, packetsLost: 50, roundTripTime: 0.02 }
  ]);
  const r0 = extractPeerNetworkMetrics(mismatchedReport, null);
  assert.equal(r0.metrics.packetLoss, null);

  const mismatchedReport2 = makeStatsReport([
    { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP01' },
    { id: 'CP01', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.01, availableOutgoingBitrate: 5_000_000 },
    { id: 'OV1', type: 'outbound-rtp', isRemote: false, kind: 'video', active: true, ssrc: 111, timestamp: 3_000, bytesSent: 200_000, packetsSent: 600 },
    { id: 'RI2', type: 'remote-inbound-rtp', kind: 'video', ssrc: 222, timestamp: 3_000, packetsLost: 60, roundTripTime: 0.02 }
  ]);
  const r1 = extractPeerNetworkMetrics(mismatchedReport2, r0.snapshot);
  assert.equal(r1.metrics.packetLoss, null);

  // Inactive old SSRC with higher packetsSent should be ignored in favor of active SSRC
  const multiSsrc1 = makeStatsReport([
    { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP01' },
    { id: 'CP01', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.01, availableOutgoingBitrate: 5_000_000 },
    { id: 'OV_OLD', type: 'outbound-rtp', isRemote: false, kind: 'video', active: false, ssrc: 111, remoteId: 'RI_OLD', timestamp: 1_000, bytesSent: 9_000_000, packetsSent: 9_000 },
    { id: 'RI_OLD', type: 'remote-inbound-rtp', kind: 'video', ssrc: 111, localId: 'OV_OLD', timestamp: 1_000, packetsLost: 900, roundTripTime: 0.01 },
    { id: 'OV_NEW', type: 'outbound-rtp', isRemote: false, kind: 'video', active: true, ssrc: 222, remoteId: 'RI_NEW', timestamp: 1_000, bytesSent: 100_000, packetsSent: 100 },
    { id: 'RI_NEW', type: 'remote-inbound-rtp', kind: 'video', ssrc: 222, localId: 'OV_NEW', timestamp: 1_000, packetsLost: 1, roundTripTime: 0.01 }
  ]);
  const m0 = extractPeerNetworkMetrics(multiSsrc1, null);
  assert.equal(m0.snapshot?.streamKey, 'ssrc:222');

  const multiSsrc2 = makeStatsReport([
    { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP01' },
    { id: 'CP01', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.01, availableOutgoingBitrate: 5_000_000 },
    { id: 'OV_OLD', type: 'outbound-rtp', isRemote: false, kind: 'video', active: false, ssrc: 111, remoteId: 'RI_OLD', timestamp: 3_000, bytesSent: 9_000_000, packetsSent: 9_000 },
    { id: 'RI_OLD', type: 'remote-inbound-rtp', kind: 'video', ssrc: 111, localId: 'OV_OLD', timestamp: 3_000, packetsLost: 900, roundTripTime: 0.01 },
    { id: 'OV_NEW', type: 'outbound-rtp', isRemote: false, kind: 'video', active: true, ssrc: 222, remoteId: 'RI_NEW', timestamp: 3_000, bytesSent: 200_000, packetsSent: 200 },
    { id: 'RI_NEW', type: 'remote-inbound-rtp', kind: 'video', ssrc: 222, localId: 'OV_NEW', timestamp: 3_000, packetsLost: 4, roundTripTime: 0.01 }
  ]);
  const m1 = extractPeerNetworkMetrics(multiSsrc2, m0.snapshot);
  assert.equal(m1.metrics.packetLoss, 3 / 100);
}

// 4. Stale RTCP report preserves baseline and aligns next interval
{
  const s0 = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 1_000, remoteTimestamp: 1_000, bytesSent: 100_000, packetsSent: 100, packetsLost: 1 }),
    null
  );
  // Stale RTCP RR (remoteTimestamp unchanged at 1_000, packetsLost unchanged at 1), while outbound advanced to 200
  const sStale = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 3_000, remoteTimestamp: 1_000, bytesSent: 200_000, packetsSent: 200, packetsLost: 1 }),
    s0.snapshot
  );
  assert.equal(sStale.metrics.packetLoss, null);

  // Next RTCP RR arrives at 5_000 with 5 total lost -> delta is (5 - 1) / (300 - 100) = 4 / 200 = 0.02
  const sFresh = extractPeerNetworkMetrics(
    makeVideoStats({ timestamp: 5_000, remoteTimestamp: 5_000, bytesSent: 300_000, packetsSent: 300, packetsLost: 5 }),
    sStale.snapshot
  );
  assert.equal(sFresh.metrics.packetLoss, 4 / 200);
}

// 5. Adaptive control: bandwidthLimited with headroom stays at level 0 and recovers from level 3
{
  // 3 viewers at 720p/30 -> target = 3.6 Mb/s
  const target3 = adaptiveTargetBitrateMbps(720, 30, 3, 0);
  assert.equal(target3, 3.6);

  const peer2 = { networkLevel: 0, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
  const peer3 = { networkLevel: 0, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
  for (let i = 0; i < 6; i += 1) {
    assert.equal(
      updateAdaptiveNetworkLevel(
        peer2,
        { rttMs: 1, packetLoss: 0, availableOutgoingMbps: 5.14, outboundMbps: 3.4, bandwidthLimited: true },
        target3
      ),
      false
    );
    assert.equal(
      updateAdaptiveNetworkLevel(
        peer3,
        { rttMs: 1, packetLoss: 0, availableOutgoingMbps: 4.67, outboundMbps: 3.4, bandwidthLimited: true },
        target3
      ),
      false
    );
  }
  assert.equal(peer2.networkLevel, 0);
  assert.equal(peer3.networkLevel, 0);

  // Recovery from level 3 -> 2 -> 1 -> 0 even while bandwidthLimited === true when headroom is sustained
  const recovering = { networkLevel: 3, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
  for (let step = 0; step < 15; step += 1) {
    const currentTarget = adaptiveTargetBitrateMbps(720, 30, 3, recovering.networkLevel);
    const recoveryTarget = adaptiveTargetBitrateMbps(720, 30, 3, Math.max(0, recovering.networkLevel - 1));
    updateAdaptiveNetworkLevel(
      recovering,
      { rttMs: 1, packetLoss: 0, availableOutgoingMbps: 5.0, outboundMbps: 3.5, bandwidthLimited: true },
      currentTarget,
      recoveryTarget
    );
  }
  assert.equal(recovering.networkLevel, 0);
}

// 6. Dynamic targets across peer counts and resolutions
{
  const target6Peers = adaptiveTargetBitrateMbps(720, 30, 6, 0); // 18 / 6 = 3.0 Mb/s
  assert.equal(target6Peers, 3.0);
  const state6 = { networkLevel: 0, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
  for (let i = 0; i < 4; i += 1) {
    assert.equal(
      updateAdaptiveNetworkLevel(
        state6,
        { rttMs: 20, packetLoss: 0, availableOutgoingMbps: 3.2, outboundMbps: 2.9, bandwidthLimited: true },
        target6Peers
      ),
      false
    );
  }
  assert.equal(state6.networkLevel, 0);

  const target480 = adaptiveTargetBitrateMbps(480, 30, 1, 0); // 1.6 Mb/s
  assert.equal(target480, 1.6);
  const target1080_60 = adaptiveTargetBitrateMbps(1080, 60, 2, 0); // min(14.0, 9.0) = 9.0 Mb/s
  assert.equal(target1080_60, 9.0);
}

// 7. Genuine congestion drops and recovers; missing/degraded metrics still trigger poor
{
  const congested = { networkLevel: 0, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
  // Available 1.2 Mb/s on 3.6 Mb/s target -> drops all the way to level 3 without oscillation
  for (let i = 0; i < 10; i += 1) {
    const currentTarget = adaptiveTargetBitrateMbps(720, 30, 1, congested.networkLevel);
    const recoveryTarget = adaptiveTargetBitrateMbps(720, 30, 1, Math.max(0, congested.networkLevel - 1));
    updateAdaptiveNetworkLevel(
      congested,
      { rttMs: 40, packetLoss: 0.01, availableOutgoingMbps: 1.2, outboundMbps: 1.0, bandwidthLimited: true },
      currentTarget,
      recoveryTarget
    );
  }
  assert.equal(congested.networkLevel, ADAPTIVE_NETWORK_PROFILES.length - 1);

  // Restriction lifted (5.0 Mb/s) -> recovers back to 0
  for (let i = 0; i < 15; i += 1) {
    const currentTarget = adaptiveTargetBitrateMbps(720, 30, 1, congested.networkLevel);
    const recoveryTarget = adaptiveTargetBitrateMbps(720, 30, 1, Math.max(0, congested.networkLevel - 1));
    updateAdaptiveNetworkLevel(
      congested,
      { rttMs: 12, packetLoss: 0, availableOutgoingMbps: 5.0, outboundMbps: 3.5, bandwidthLimited: false },
      currentTarget,
      recoveryTarget
    );
  }
  assert.equal(congested.networkLevel, 0);

  // bandwidthLimited with null availableOutgoingMbps, elevated RTT (250 ms), or 3% loss still counts as poor
  for (const badMetrics of [
    { rttMs: 10, packetLoss: 0, availableOutgoingMbps: null, outboundMbps: 1.5, bandwidthLimited: true },
    { rttMs: 250, packetLoss: 0, availableOutgoingMbps: 5.0, outboundMbps: 2.0, bandwidthLimited: true },
    { rttMs: 10, packetLoss: 0.03, availableOutgoingMbps: 5.0, outboundMbps: 2.0, bandwidthLimited: true }
  ]) {
    const peer = { networkLevel: 0, poorNetworkSamples: 0, healthyNetworkSamples: 0 };
    assert.equal(updateAdaptiveNetworkLevel(peer, badMetrics, 3.6), false);
    assert.equal(updateAdaptiveNetworkLevel(peer, badMetrics, 3.6), true);
    assert.equal(peer.networkLevel, 1);
  }
}

console.log('ALL screenNetworkControl tests passed.');
