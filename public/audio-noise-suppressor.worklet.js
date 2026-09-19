const WorkletProcessorBase = globalThis.AudioWorkletProcessor ?? class {};

export class AdaptiveNoiseSuppressorCore {
  constructor(processorSampleRate = 48_000) {
    this.sampleRate = processorSampleRate;
    this.noiseFloor = 0.006;
    this.gain = 1;
    this.enabledMix = 0;
    this.hangoverSamples = 0;
    this.previousInput = 0;
    this.previousHighPass = 0;
    this.previousLowPass = 0;
    const timeStep = 1 / this.sampleRate;
    this.highPassAlpha = (1 / (2 * Math.PI * 75)) / ((1 / (2 * Math.PI * 75)) + timeStep);
    this.lowPassAlpha = timeStep / ((1 / (2 * Math.PI * 13_500)) + timeStep);
  }

  processBlock(input, output, enabled = 1) {
    if (!input?.length || !output?.length) return;

    let energy = 0;
    let peak = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index];
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }

    const rms = Math.sqrt(energy / input.length);
    const threshold = Math.min(0.032, Math.max(0.0045, this.noiseFloor * 2.65));
    const speechDetected = rms > threshold || peak > threshold * 2.15;

    if (speechDetected) {
      this.hangoverSamples = Math.round(this.sampleRate * 0.14);
      this.noiseFloor = Math.max(0.00035, this.noiseFloor * 0.9995);
    } else {
      this.hangoverSamples = Math.max(0, this.hangoverSamples - input.length);
      const floorRate = rms < this.noiseFloor ? 0.075 : 0.012;
      this.noiseFloor += (Math.min(0.028, Math.max(0.00035, rms)) - this.noiseFloor) * floorRate;
    }

    const ratio = Math.min(1, rms / Math.max(threshold, 0.00001));
    const expandedGain = 0.045 + 0.955 * ratio ** 3.2;
    const targetGain = speechDetected || this.hangoverSamples > 0 ? 1 : expandedGain;
    const gainRate = targetGain > this.gain ? 0.52 : 0.045;
    const nextGain = this.gain + (targetGain - this.gain) * gainRate;
    const targetMix = enabled >= 0.5 ? 1 : 0;
    const mixRate = targetMix > this.enabledMix ? 0.22 : 0.3;
    const nextMix = this.enabledMix + (targetMix - this.enabledMix) * mixRate;

    for (let index = 0; index < input.length; index += 1) {
      const progress = (index + 1) / input.length;
      const gateGain = this.gain + (nextGain - this.gain) * progress;
      const wetMix = this.enabledMix + (nextMix - this.enabledMix) * progress;
      const sample = input[index];
      const highPassed = this.highPassAlpha * (this.previousHighPass + sample - this.previousInput);
      this.previousInput = sample;
      this.previousHighPass = highPassed;
      this.previousLowPass += this.lowPassAlpha * (highPassed - this.previousLowPass);
      const processed = this.previousLowPass * gateGain;
      output[index] = sample + (processed - sample) * wetMix;
    }

    this.gain = nextGain;
    this.enabledMix = nextMix;
  }
}

export class ScreenLinkNoiseSuppressorProcessor extends WorkletProcessorBase {
  static get parameterDescriptors() {
    return [{ name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.cores = [];
  }

  process(inputs, outputs, parameters) {
    const inputChannels = inputs[0] ?? [];
    const outputChannels = outputs[0] ?? [];
    const enabled = parameters.enabled?.[0] ?? 1;
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const input = inputChannels[channel] ?? inputChannels[0];
      const output = outputChannels[channel];
      if (!input) {
        output.fill(0);
        continue;
      }
      const core = this.cores[channel] ??= new AdaptiveNoiseSuppressorCore(globalThis.sampleRate ?? 48_000);
      core.processBlock(input, output, enabled);
    }
    return true;
  }
}

if (typeof globalThis.registerProcessor === 'function') {
  globalThis.registerProcessor('screenlink-adaptive-noise-suppressor', ScreenLinkNoiseSuppressorProcessor);
}
