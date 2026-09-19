import { GtcrnWorkletNode, loadGtcrn } from '@sapphi-red/web-noise-suppressor';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';

export type NoiseSuppressorPipeline = {
  input: GainNode;
  output: GainNode;
  mode: 'neural' | 'adaptive';
  setEnabled: (enabled: boolean, at?: number) => void;
  destroy: () => void;
};

const neuralRegistrations = new WeakMap<AudioContext, Promise<void>>();
const adaptiveRegistrations = new WeakMap<AudioContext, Promise<void>>();
let gtcrnBinaryPromise: Promise<ArrayBuffer> | null = null;

function adaptiveWorkletUrl() {
  return new URL('audio-noise-suppressor.worklet.js', document.baseURI).href;
}

function holdAt(parameter: AudioParam, at: number) {
  if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(at);
  else {
    parameter.cancelScheduledValues(at);
    parameter.setValueAtTime(parameter.value, at);
  }
}

async function createNeuralProcessor(context: AudioContext) {
  let registration = neuralRegistrations.get(context);
  if (!registration) {
    registration = context.audioWorklet.addModule(gtcrnWorkletUrl);
    neuralRegistrations.set(context, registration);
  }
  gtcrnBinaryPromise ??= loadGtcrn({ url: gtcrnWasmUrl });
  const [, wasmBinary] = await Promise.all([registration, gtcrnBinaryPromise]);
  return new GtcrnWorkletNode(context, { maxChannels: 1, wasmBinary });
}

async function createAdaptiveProcessor(context: AudioContext) {
  let registration = adaptiveRegistrations.get(context);
  if (!registration) {
    registration = context.audioWorklet.addModule(adaptiveWorkletUrl());
    adaptiveRegistrations.set(context, registration);
  }
  await registration;
  return new AudioWorkletNode(context, 'screenlink-adaptive-noise-suppressor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });
}

export async function createNoiseSuppressorPipeline(context: AudioContext, enabled: boolean): Promise<NoiseSuppressorPipeline | null> {
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;

  let processor: AudioWorkletNode;
  let mode: NoiseSuppressorPipeline['mode'];
  try {
    if (context.sampleRate !== 48_000) throw new Error('GTCRN requer áudio a 48 kHz.');
    processor = await createNeuralProcessor(context);
    mode = 'neural';
  } catch {
    processor = await createAdaptiveProcessor(context);
    mode = 'adaptive';
  }

  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  input.connect(dry).connect(output);
  input.connect(processor).connect(wet).connect(output);

  const setEnabled = (nextEnabled: boolean, at = context.currentTime) => {
    holdAt(dry.gain, at);
    holdAt(wet.gain, at);
    dry.gain.linearRampToValueAtTime(nextEnabled ? 0 : 1, at + 0.025);
    wet.gain.linearRampToValueAtTime(nextEnabled ? 1 : 0, at + 0.025);
  };
  dry.gain.value = enabled ? 0 : 1;
  wet.gain.value = enabled ? 1 : 0;

  return {
    input,
    output,
    mode,
    setEnabled,
    destroy: () => {
      if (processor instanceof GtcrnWorkletNode) processor.destroy();
      input.disconnect();
      processor.disconnect();
      dry.disconnect();
      wet.disconnect();
      output.disconnect();
    }
  };
}

export function setNoiseSuppression(pipeline: NoiseSuppressorPipeline | null, enabled: boolean, at: number) {
  pipeline?.setEnabled(enabled, at);
}
