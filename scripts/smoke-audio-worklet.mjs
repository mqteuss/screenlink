import { strict as assert } from 'node:assert';
import { createServer as createNetServer } from 'node:net';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

app.whenReady().then(async () => {
  let window = null;
  let exitCode = 0;
  try {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    await import('../server.mjs');

    const assetNames = await readdir(path.resolve('dist/assets'));
    const neuralWorklet = assetNames.find(name => /^workletProcessor-.*\.js$/.test(name));
    const neuralWasm = assetNames.find(name => /^gtcrn-.*\.wasm$/.test(name));
    assert.ok(neuralWorklet, 'O build não gerou o AudioWorklet neural.');
    assert.ok(neuralWasm, 'O build não gerou o modelo GTCRN em WASM.');
    const neuralWorkletUrl = `/assets/${neuralWorklet}`;
    const neuralWasmUrl = `/assets/${neuralWasm}`;

    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await window.loadURL(origin);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch('/audio-noise-suppressor.worklet.js');
      const context = new AudioContext({ sampleRate: 48000 });
      await context.audioWorklet.addModule('/audio-noise-suppressor.worklet.js');
      const suppressor = new AudioWorkletNode(context, 'screenlink-adaptive-noise-suppressor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit'
      });
      const oscillator = context.createOscillator();
      const analyser = context.createAnalyser();
      const mute = context.createGain();
      mute.gain.value = 0;
      oscillator.connect(suppressor).connect(analyser).connect(mute).connect(context.destination);
      oscillator.start();
      await context.resume();
      await new Promise(resolve => setTimeout(resolve, 180));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
      suppressor.parameters.get('enabled')?.setValueAtTime(0, context.currentTime);
      oscillator.stop();
      await context.close();
      return { status: response.status, contentType: response.headers.get('content-type'), peak };
    })()`);
    assert.equal(result.status, 200);
    assert.match(result.contentType ?? '', /javascript/);
    assert.ok(result.peak > 0.01, `O AudioWorklet não processou áudio: pico ${result.peak}`);

    const neuralResult = await window.webContents.executeJavaScript(`(async () => {
      const workletUrl = ${JSON.stringify(neuralWorkletUrl)};
      const wasmUrl = ${JSON.stringify(neuralWasmUrl)};
      const [workletResponse, wasmResponse] = await Promise.all([fetch(workletUrl), fetch(wasmUrl)]);
      const wasmBinary = await wasmResponse.arrayBuffer();
      const context = new AudioContext({ sampleRate: 48000 });
      await context.audioWorklet.addModule(workletUrl);
      const suppressor = new AudioWorkletNode(context, '@sapphi-red/web-noise-suppressor/gtcrn', {
        processorOptions: { maxChannels: 1, wasmBinary },
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit'
      });
      let processorError = false;
      suppressor.addEventListener('processorerror', () => { processorError = true; });
      const oscillator = context.createOscillator();
      const mute = context.createGain();
      mute.gain.value = 0;
      oscillator.connect(suppressor).connect(mute).connect(context.destination);
      oscillator.start();
      await context.resume();
      await new Promise(resolve => setTimeout(resolve, 350));
      oscillator.stop();
      await context.close();
      return {
        workletStatus: workletResponse.status,
        wasmStatus: wasmResponse.status,
        wasmContentType: wasmResponse.headers.get('content-type'),
        processorError
      };
    })()`);
    assert.equal(neuralResult.workletStatus, 200);
    assert.equal(neuralResult.wasmStatus, 200);
    assert.match(neuralResult.wasmContentType ?? '', /application\/wasm/);
    assert.equal(neuralResult.processorError, false, 'O processador neural falhou no AudioWorklet.');
    console.log('PASS AudioWorklet runtime', JSON.stringify({ adaptive: result, neural: neuralResult }));
  } catch (error) {
    exitCode = 1;
    console.error('FAIL AudioWorklet runtime', error);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
});
