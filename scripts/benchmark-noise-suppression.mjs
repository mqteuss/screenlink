import { strict as assert } from 'node:assert';
import { AdaptiveNoiseSuppressorCore } from '../public/audio-noise-suppressor.worklet.js';

const sampleRate = 48_000;
const blockSize = 128;
const seconds = 4;
const sampleCount = sampleRate * seconds;
const input = new Float32Array(sampleCount);
const cleanVoice = new Float32Array(sampleCount);
let randomState = 0x51f15e;

function noise() {
  randomState = (1664525 * randomState + 1013904223) >>> 0;
  return (randomState / 0xffffffff) * 2 - 1;
}

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const voiceActive = time >= 1.25 && time < 2.75;
  const voice = voiceActive
    ? 0.105 * Math.sin(2 * Math.PI * 155 * time)
      + 0.052 * Math.sin(2 * Math.PI * 310 * time)
      + 0.026 * Math.sin(2 * Math.PI * 620 * time)
    : 0;
  const background = noise() * 0.018
    + 0.008 * Math.sin(2 * Math.PI * 60 * time)
    + 0.004 * Math.sin(2 * Math.PI * 8_200 * time);
  cleanVoice[index] = voice;
  input[index] = voice + background;
}

const output = new Float32Array(sampleCount);
const core = new AdaptiveNoiseSuppressorCore(sampleRate);
for (let offset = 0; offset < sampleCount; offset += blockSize) {
  core.processBlock(input.subarray(offset, offset + blockSize), output.subarray(offset, offset + blockSize), 1);
}

function rms(values, startSeconds, endSeconds) {
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.floor(endSeconds * sampleRate);
  let energy = 0;
  for (let index = start; index < end; index += 1) energy += values[index] ** 2;
  return Math.sqrt(energy / Math.max(1, end - start));
}

const noiseBefore = (rms(input, 0.65, 1.1) + rms(input, 3.15, 3.7)) / 2;
const noiseAfter = (rms(output, 0.65, 1.1) + rms(output, 3.15, 3.7)) / 2;
const voiceBefore = rms(input, 1.55, 2.45);
const voiceAfter = rms(output, 1.55, 2.45);
const noiseReductionDb = 20 * Math.log10(noiseBefore / noiseAfter);
const voiceRetention = voiceAfter / voiceBefore;

assert.ok(noiseReductionDb >= 14, `Redução insuficiente: ${noiseReductionDb.toFixed(1)} dB`);
assert.ok(voiceRetention >= 0.82, `Voz excessivamente reduzida: ${(voiceRetention * 100).toFixed(1)}%`);
console.log('PASS adaptive noise suppression', JSON.stringify({
  noiseReductionDb: Number(noiseReductionDb.toFixed(1)),
  voiceRetentionPercent: Number((voiceRetention * 100).toFixed(1))
}));
