export type InterfaceSoundName =
  | 'callConnected'
  | 'callDisconnected'
  | 'microphoneMuted'
  | 'microphoneEnabled'
  | 'outputMuted'
  | 'outputEnabled'
  | 'participantJoined'
  | 'participantLeft'
  | 'screenStarted'
  | 'screenStopped';

type SoundGraph = {
  context: AudioContext;
  output: GainNode;
};

type SinkableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type ToneOptions = {
  at: number;
  frequency: number;
  duration: number;
  gain: number;
  attack?: number;
  detune?: number;
  pan?: number;
  wave?: OscillatorType;
  cutoff?: number;
  endFrequency?: number;
};

type NoiseOptions = {
  at: number;
  duration: number;
  gain: number;
  frequency: number;
  pan?: number;
  type?: BiquadFilterType;
};

let graph: SoundGraph | null = null;
let noiseBuffer: AudioBuffer | null = null;
let outputDeviceId = '';
const lastPlayed = new Map<InterfaceSoundName, number>();
const SOUND_GAIN = 1.55;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function ensureGraph(): SoundGraph | null {
  if (graph?.context.state !== 'closed') return graph;
  const AudioContextClass = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;

  let context: AudioContext;
  try {
    context = new AudioContextClass({ latencyHint: 'interactive' });
  } catch {
    // Alguns WebViews/Safaris antigos expõem AudioContext, mas rejeitam opções no construtor.
    context = new AudioContextClass();
  }
  const output = context.createGain();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -22;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.16;
  output.connect(compressor);
  compressor.connect(context.destination);
  graph = { context, output };
  noiseBuffer = null;
  void applyOutputDevice(context);
  return graph;
}

async function applyOutputDevice(context: AudioContext) {
  const sinkable = context as SinkableAudioContext;
  if (typeof sinkable.setSinkId !== 'function') return;
  await sinkable.setSinkId(outputDeviceId).catch(() => undefined);
}

function primeContext(soundGraph: SoundGraph) {
  // Um buffer silencioso iniciado dentro do gesto destrava Web Audio no Safari/iOS.
  const source = soundGraph.context.createBufferSource();
  source.buffer = soundGraph.context.createBuffer(1, 1, soundGraph.context.sampleRate);
  source.connect(soundGraph.output);
  source.start();
}

async function startContext(soundGraph: SoundGraph) {
  const { context } = soundGraph;
  if (context.state === 'closed') return false;
  if (context.state !== 'running') {
    await context.resume().catch(() => undefined);
  }
  if (context.state !== 'running') return false;
  primeContext(soundGraph);
  return true;
}

function connectWithPan(context: AudioContext, source: AudioNode, destination: AudioNode, pan = 0) {
  if (!context.createStereoPanner) {
    source.connect(destination);
    return;
  }
  const panner = context.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  source.connect(panner);
  panner.connect(destination);
}

function tone(soundGraph: SoundGraph, options: ToneOptions) {
  const { context, output } = soundGraph;
  const oscillator = context.createOscillator();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  const attack = Math.min(options.attack ?? 0.012, options.duration * 0.35);
  const releaseAt = options.at + Math.max(attack + 0.01, options.duration * 0.42);

  oscillator.type = options.wave ?? 'sine';
  oscillator.detune.value = options.detune ?? 0;
  oscillator.frequency.setValueAtTime(options.frequency, options.at);
  if (options.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, options.at + options.duration);
  }

  filter.type = 'lowpass';
  filter.frequency.value = options.cutoff ?? Math.min(8_500, options.frequency * 7);
  filter.Q.value = 0.72;

  envelope.gain.setValueAtTime(0.0001, options.at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, options.gain * SOUND_GAIN), options.at + attack);
  envelope.gain.setValueAtTime(Math.max(0.0001, options.gain * SOUND_GAIN * 0.82), releaseAt);
  envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration);

  oscillator.connect(filter);
  filter.connect(envelope);
  connectWithPan(context, envelope, output, options.pan);
  oscillator.start(options.at);
  oscillator.stop(options.at + options.duration + 0.025);
}

function getNoiseBuffer(context: AudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === context.sampleRate) return noiseBuffer;
  const length = Math.ceil(context.sampleRate * 0.22);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x51_43_4c;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    data[index] = (seed / 0xffff_ffff) * 2 - 1;
  }
  noiseBuffer = buffer;
  return buffer;
}

function noise(soundGraph: SoundGraph, options: NoiseOptions) {
  const { context, output } = soundGraph;
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  source.buffer = getNoiseBuffer(context);
  filter.type = options.type ?? 'bandpass';
  filter.frequency.value = options.frequency;
  filter.Q.value = 1.4;
  envelope.gain.setValueAtTime(0.0001, options.at);
  envelope.gain.exponentialRampToValueAtTime(options.gain * SOUND_GAIN, options.at + 0.006);
  envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration);
  source.connect(filter);
  filter.connect(envelope);
  connectWithPan(context, envelope, output, options.pan);
  source.start(options.at);
  source.stop(options.at + options.duration + 0.01);
}

function glassNote(soundGraph: SoundGraph, at: number, frequency: number, gain: number, pan = 0, duration = 0.34) {
  tone(soundGraph, { at, frequency, duration, gain, pan, wave: 'sine', cutoff: 8_000 });
  tone(soundGraph, { at: at + 0.004, frequency: frequency * 2.01, duration: duration * 0.62, gain: gain * 0.2, pan: -pan, wave: 'triangle', cutoff: 7_200 });
}

function scheduleSound(name: InterfaceSoundName, soundGraph: SoundGraph) {
  const at = soundGraph.context.currentTime + 0.014;
  switch (name) {
    case 'callConnected':
      glassNote(soundGraph, at, 392, 0.052, -0.18, 0.42);
      glassNote(soundGraph, at + 0.065, 587.33, 0.06, 0.12, 0.46);
      glassNote(soundGraph, at + 0.135, 880, 0.052, 0.22, 0.52);
      noise(soundGraph, { at: at + 0.12, duration: 0.18, gain: 0.012, frequency: 4_600, pan: 0.16 });
      break;
    case 'callDisconnected':
      glassNote(soundGraph, at, 659.25, 0.05, 0.16, 0.3);
      glassNote(soundGraph, at + 0.07, 493.88, 0.052, -0.08, 0.32);
      glassNote(soundGraph, at + 0.145, 329.63, 0.045, -0.2, 0.36);
      tone(soundGraph, { at: at + 0.13, frequency: 116, endFrequency: 62, duration: 0.24, gain: 0.026, wave: 'sine', cutoff: 520 });
      break;
    case 'microphoneMuted':
      tone(soundGraph, { at, frequency: 620, endFrequency: 360, duration: 0.15, gain: 0.055, wave: 'triangle', cutoff: 2_400 });
      noise(soundGraph, { at: at + 0.012, duration: 0.055, gain: 0.012, frequency: 1_900, type: 'highpass' });
      break;
    case 'microphoneEnabled':
      tone(soundGraph, { at, frequency: 390, endFrequency: 620, duration: 0.16, gain: 0.052, wave: 'triangle', cutoff: 3_300 });
      glassNote(soundGraph, at + 0.075, 780, 0.027, 0.1, 0.24);
      break;
    case 'outputMuted':
      glassNote(soundGraph, at, 349.23, 0.044, 0.08, 0.22);
      glassNote(soundGraph, at + 0.055, 220, 0.044, -0.12, 0.28);
      break;
    case 'outputEnabled':
      glassNote(soundGraph, at, 293.66, 0.04, -0.12, 0.25);
      glassNote(soundGraph, at + 0.055, 440, 0.046, 0.08, 0.3);
      glassNote(soundGraph, at + 0.105, 659.25, 0.035, 0.16, 0.34);
      break;
    case 'participantJoined':
      glassNote(soundGraph, at, 523.25, 0.037, -0.16, 0.28);
      glassNote(soundGraph, at + 0.07, 783.99, 0.043, 0.18, 0.36);
      break;
    case 'participantLeft':
      glassNote(soundGraph, at, 698.46, 0.035, 0.14, 0.25);
      glassNote(soundGraph, at + 0.07, 440, 0.038, -0.14, 0.3);
      break;
    case 'screenStarted':
      glassNote(soundGraph, at, 440, 0.035, -0.24, 0.32);
      glassNote(soundGraph, at + 0.05, 659.25, 0.043, 0, 0.4);
      glassNote(soundGraph, at + 0.1, 987.77, 0.036, 0.24, 0.46);
      noise(soundGraph, { at: at + 0.075, duration: 0.16, gain: 0.009, frequency: 5_200, pan: 0.2 });
      break;
    case 'screenStopped':
      glassNote(soundGraph, at, 739.99, 0.037, 0.2, 0.25);
      glassNote(soundGraph, at + 0.055, 554.37, 0.039, 0, 0.28);
      glassNote(soundGraph, at + 0.11, 369.99, 0.034, -0.2, 0.32);
      break;
  }
}

export async function unlockInterfaceSounds() {
  const soundGraph = ensureGraph();
  if (!soundGraph) return false;
  return startContext(soundGraph);
}

export async function setInterfaceSoundOutputDevice(deviceId: string) {
  outputDeviceId = deviceId;
  const soundGraph = ensureGraph();
  if (!soundGraph) return;
  await applyOutputDevice(soundGraph.context);
}

export async function playInterfaceSound(name: InterfaceSoundName, volume = 1) {
  const soundGraph = ensureGraph();
  if (!soundGraph) return false;
  if (!await startContext(soundGraph)) return false;

  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? 0) < 90) return true;
  lastPlayed.set(name, now);
  soundGraph.output.gain.setTargetAtTime(clamp(volume, 0, 1) * 0.82, soundGraph.context.currentTime, 0.012);
  scheduleSound(name, soundGraph);
  return true;
}
