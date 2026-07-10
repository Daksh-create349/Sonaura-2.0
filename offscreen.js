// offscreen.js - Sonaura 2.0 Audio Processing Core

let sonauraCtx = null;
let mediaStream = null;
let activeCinemaIRBuffer = null;
let syntheticCinemaIRBuffer = null;
let exciterCurveBuffer = null;
let visualizerAnalyser = null;
let nodes = null;

let currentSettings = {
  preset: 'cinema',
  bassBoost: 6, treble: 2,
  surroundEnabled: true, surroundIntensity: -1,
  cinemaHall: true, cinemaHallMix: 0.5,
  masterVolume: 0.9, compressorNightMode: false, bypass: false,
  exciterEnabled: true, exciterMix: 0.2,
  autoCalibratedGains: null, customIR: null
};

// Generate synthetic cinema impulse response
const getSyntheticCinemaIR = (ctx) => {
  const sampleRate = ctx.sampleRate;
  // Increase length slightly to 0.55s for a richer, more spacious cinema theater reverb tail
  const length = Math.floor(sampleRate * 0.55); 
  const buffer = ctx.createBuffer(2, length, sampleRate);
  
  const leftData = buffer.getChannelData(0);
  const rightData = buffer.getChannelData(1);
  
  let lastValueL = 0;
  let lastValueR = 0;
  
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let envelope = 0;
    
    // Smooth attack and realistic exponential decay
    if (t < 0.015) {
      envelope = t / 0.015;
    } else if (t < 0.08) {
      envelope = 1.0;
    } else {
      // Decay factor of 7.5 creates a warm, spacious cinema hall decay (~0.5s)
      envelope = Math.exp(-(t - 0.08) * 7.5);
    }
    
    // Generate separate, decorrelated noise for left and right channels to widen the field
    const noiseL = (Math.random() * 2) - 1;
    const noiseR = (Math.random() * 2) - 1;
    
    const valL = noiseL * envelope;
    const valR = noiseR * envelope;
    
    // Simulate asymmetric acoustic absorption in the cinema hall (different lowpass coefficients)
    leftData[i] = lastValueL + 0.20 * (valL - lastValueL);
    rightData[i] = lastValueR + 0.24 * (valR - lastValueR);
    
    lastValueL = leftData[i];
    lastValueR = rightData[i];
  }
  
  // Add cross-channel early reflection delay (Haas crosstalk simulation)
  // This simulates the physical cross-leakage of sound traveling across the theater room
  const delaySamples = Math.floor(sampleRate * 0.0025); // 2.5ms delay
  for (let i = delaySamples; i < length; i++) {
    leftData[i] += rightData[i - delaySamples] * 0.15;
    rightData[i] += leftData[i - delaySamples] * 0.15;
  }
  
  return buffer;
};

// Generate subharmonic exciter curve
const makeExciterCurve = () => {
  const curve = new Float32Array(2048);
  for (let i = 0; i < 2048; ++i) {
    const x = (i * 2 / 2048) - 1;
    // Asymmetric wave shaping: positive side saturated differently than negative side
    // This generates a beautiful mix of even and odd harmonics for warm, tube-like sub-bass
    if (x < 0) {
      curve[i] = Math.tanh(x * 1.5) * 0.7;
    } else {
      curve[i] = (Math.tanh(x * 2.2) * 0.5) + (0.2 * x * x);
    }
  }
  return curve;
};

// Decode base64 to audio buffer
async function decodeBase64Audio(ctx, dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const arrayBuffer = await res.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (e) {
    console.error("Sonaura: Error decoding custom IR", e);
    return null;
  }
}

// Set up the full processing graph
function setupAudioGraph(stream) {
  const track = stream.getAudioTracks()[0];
  const settings = track ? track.getSettings() : null;
  const targetSampleRate = settings && settings.sampleRate ? settings.sampleRate : 44100;

  if (sonauraCtx) {
    if (sonauraCtx.sampleRate !== targetSampleRate) {
      console.log(`Sonaura: Closing existing AudioContext (rate ${sonauraCtx.sampleRate}) to match stream rate (${targetSampleRate}).`);
      try {
        sonauraCtx.close();
      } catch (e) {}
      sonauraCtx = null;
      syntheticCinemaIRBuffer = null;
      activeCinemaIRBuffer = null;
      exciterCurveBuffer = null;
    }
  }

  if (!sonauraCtx) {
    sonauraCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'playback',
      sampleRate: targetSampleRate
    });
  }

  // Explicitly configure the Web Audio listener's orientation to guarantee perfect HRTF spatialization
  const now = sonauraCtx.currentTime;
  if (sonauraCtx.listener) {
    if (sonauraCtx.listener.positionX) {
      sonauraCtx.listener.positionX.setValueAtTime(0, now);
      sonauraCtx.listener.positionY.setValueAtTime(0, now);
      sonauraCtx.listener.positionZ.setValueAtTime(0, now);
      sonauraCtx.listener.forwardX.setValueAtTime(0, now);
      sonauraCtx.listener.forwardY.setValueAtTime(0, now);
      sonauraCtx.listener.forwardZ.setValueAtTime(-1, now);
      sonauraCtx.listener.upX.setValueAtTime(0, now);
      sonauraCtx.listener.upY.setValueAtTime(1, now);
      sonauraCtx.listener.upZ.setValueAtTime(0, now);
    } else {
      try {
        sonauraCtx.listener.setPosition(0, 0, 0);
        sonauraCtx.listener.setOrientation(0, 0, -1, 0, 1, 0);
      } catch (e) {}
    }
  }
  
  // Set up buffers only once to preserve memory
  if (!syntheticCinemaIRBuffer) {
    syntheticCinemaIRBuffer = getSyntheticCinemaIR(sonauraCtx);
    activeCinemaIRBuffer = syntheticCinemaIRBuffer;
  }
  if (!exciterCurveBuffer) {
    exciterCurveBuffer = makeExciterCurve();
  }
  
  // Clear old sourceNode if we are recreating
  if (nodes && nodes.sourceNode) {
    try {
      nodes.sourceNode.disconnect();
    } catch (e) {}
  }
  
  // Setup source
  const sourceNode = sonauraCtx.createMediaStreamSource(stream);
  
  // Setup 5.1 virtual surround matrix
  const splitter = sonauraCtx.createChannelSplitter(2);
  
  const gainL = sonauraCtx.createGain(); gainL.gain.value = 1.0;
  const gainR = sonauraCtx.createGain(); gainR.gain.value = 1.0;
  const gainC_L = sonauraCtx.createGain(); gainC_L.gain.value = 0.5;
  const gainC_R = sonauraCtx.createGain(); gainC_R.gain.value = 0.5;
  const gainLS_L = sonauraCtx.createGain(); gainLS_L.gain.value = 0.7;
  const gainLS_R = sonauraCtx.createGain(); gainLS_R.gain.value = -0.3;
  const gainRS_L = sonauraCtx.createGain(); gainRS_L.gain.value = -0.3;
  const gainRS_R = sonauraCtx.createGain(); gainRS_R.gain.value = 0.7;
  const gainLFE_L = sonauraCtx.createGain(); gainLFE_L.gain.value = 0.5;
  const gainLFE_R = sonauraCtx.createGain(); gainLFE_R.gain.value = 0.5;

  const lfeFilter = sonauraCtx.createBiquadFilter();
  lfeFilter.type = "lowpass"; lfeFilter.frequency.value = 120; lfeFilter.Q.value = 0.7;

  // Center Dialogue Enhancement Filters
  const dialogHighpass = sonauraCtx.createBiquadFilter();
  dialogHighpass.type = "highpass"; dialogHighpass.frequency.value = 120;
  
  const dialogFilter = sonauraCtx.createBiquadFilter();
  dialogFilter.type = "peaking"; dialogFilter.frequency.value = 2000; dialogFilter.Q.value = 0.85; dialogFilter.gain.value = 2.5;

  // Surround Delays (Haas Effect) & High Frequency Room Absorption Filters
  const delayLS = sonauraCtx.createDelay(0.1); delayLS.delayTime.value = 0.022; // 22ms LS delay
  const filterLS = sonauraCtx.createBiquadFilter();
  filterLS.type = "lowpass"; filterLS.frequency.value = 7500;

  const delayRS = sonauraCtx.createDelay(0.1); delayRS.delayTime.value = 0.028; // 28ms RS delay (decorrelated)
  const filterRS = sonauraCtx.createBiquadFilter();
  filterRS.type = "lowpass"; filterRS.frequency.value = 7500;

  const panners = {};
  ['L', 'R', 'C', 'LS', 'RS', 'LFE'].forEach(ch => {
    const p = sonauraCtx.createPanner();
    p.panningModel = 'HRTF'; 
    p.distanceModel = 'inverse'; 
    p.refDistance = 1;
    p.maxDistance = 10000;
    p.rolloffFactor = 0; // Disable distance-based volume scaling for constant volume and headroom stability
    panners[ch] = p;
  });

  const surroundBus = sonauraCtx.createGain();
  surroundBus.gain.value = 0.20; // Scale down to prevent matrix and EQ headroom clipping

  // Connect Matrix
  splitter.connect(gainL, 0); splitter.connect(gainR, 1);
  splitter.connect(gainC_L, 0); splitter.connect(gainC_R, 1);
  splitter.connect(gainLS_L, 0); splitter.connect(gainLS_R, 1);
  splitter.connect(gainRS_L, 0); splitter.connect(gainRS_R, 1);
  splitter.connect(gainLFE_L, 0); splitter.connect(gainLFE_R, 1);

  // Fronts L and R
  gainL.connect(panners.L); gainR.connect(panners.R);
  
  // Center (Dialog -> Dialog Filters -> Panner C)
  gainC_L.connect(dialogHighpass); gainC_R.connect(dialogHighpass);
  dialogHighpass.connect(dialogFilter);
  dialogFilter.connect(panners.C);
  
  // Left Surround (LS -> Delay -> Lowpass -> Panner LS)
  gainLS_L.connect(delayLS); gainLS_R.connect(delayLS);
  delayLS.connect(filterLS);
  filterLS.connect(panners.LS);
  
  // Right Surround (RS -> Delay -> Lowpass -> Panner RS)
  gainRS_L.connect(delayRS); gainRS_R.connect(delayRS);
  delayRS.connect(filterRS);
  filterRS.connect(panners.RS);
  
  // LFE (LFE -> Lowpass -> Panner LFE)
  gainLFE_L.connect(lfeFilter); gainLFE_R.connect(lfeFilter); lfeFilter.connect(panners.LFE);

  Object.values(panners).forEach(p => p.connect(surroundBus));
  const surroundNodes = { splitter, panners, surroundBus };

  // Setup 10-band EQ
  const eqFrequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const eqBands = eqFrequencies.map((freq, i) => {
    const filter = sonauraCtx.createBiquadFilter();
    filter.type = (i === 0) ? "lowshelf" : (i === 9) ? "highshelf" : "peaking";
    filter.frequency.value = freq; 
    filter.Q.value = (i === 0 || i === 9) ? 0.7 : 1.41;
    return filter;
  });

  // Setup Compressor
  const compressor = sonauraCtx.createDynamicsCompressor();

  // Setup Subharmonic Exciter
  const exciterLowpass = sonauraCtx.createBiquadFilter();
  exciterLowpass.type = 'lowpass'; exciterLowpass.frequency.value = 150;
  const exciterWaveshaper = sonauraCtx.createWaveShaper();
  exciterWaveshaper.curve = exciterCurveBuffer;
  const exciterPostLowpass = sonauraCtx.createBiquadFilter();
  exciterPostLowpass.type = 'lowpass'; exciterPostLowpass.frequency.value = 110; exciterPostLowpass.Q.value = 0.7;
  const exciterMixGain = sonauraCtx.createGain();
  const exciterSummingGain = sonauraCtx.createGain();
  const exciterNodes = {
    lowpass: exciterLowpass,
    waveshaper: exciterWaveshaper,
    postLowpass: exciterPostLowpass,
    mixGain: exciterMixGain,
    summingGain: exciterSummingGain
  };

  // Setup Reverb Convolver
  const convolver = sonauraCtx.createConvolver();
  convolver.buffer = activeCinemaIRBuffer; 
  convolver.normalize = true;
  const reverbHighpass = sonauraCtx.createBiquadFilter();
  reverbHighpass.type = 'highpass'; reverbHighpass.frequency.value = 150;
  const reverbLowpass = sonauraCtx.createBiquadFilter();
  reverbLowpass.type = 'lowpass'; reverbLowpass.frequency.value = 4500;
  const reverbWetGain = sonauraCtx.createGain();
  const reverbDryGain = sonauraCtx.createGain();
  
  // Setup Visualizer Analyser
  visualizerAnalyser = sonauraCtx.createAnalyser();
  visualizerAnalyser.fftSize = 1024;
  
  // Setup Brickwall Limiter to prevent clipping distortion
  const limiterNode = sonauraCtx.createDynamicsCompressor();
  limiterNode.threshold.value = -1.0; // Limit peaks at -1dB
  limiterNode.knee.value = 10.0; // Soft knee for smoother limiting (less harsh clamping)
  limiterNode.ratio.value = 20.0;
  limiterNode.attack.value = 0.003; // 3ms attack
  limiterNode.release.value = 0.15; // 150ms release for smoother recovery
  
  // Setup Final Gain
  const finalGain = sonauraCtx.createGain();

  nodes = { sourceNode, surroundNodes, eqBands, compressor, exciterNodes, convolver, reverbHighpass, reverbLowpass, reverbWetGain, reverbDryGain, limiterNode, finalGain };
  
  // Initially load custom IR if present in settings
  if (currentSettings.customIR) {
    decodeBase64Audio(sonauraCtx, currentSettings.customIR).then(buffer => {
      if (buffer && convolver) {
        activeCinemaIRBuffer = buffer;
        convolver.buffer = buffer;
      }
    });
  }

  // Ensure AudioContext is running if it was recreated or started in suspended state
  if (sonauraCtx && sonauraCtx.state === 'suspended') {
    sonauraCtx.resume().then(() => {
      console.log("Sonaura: AudioContext successfully resumed in setupAudioGraph.");
    }).catch(err => {
      console.error("Sonaura: Failed to resume AudioContext in setupAudioGraph", err);
    });
  }
}

// Reconnect/disconnect the graph dynamically based on bypass/enabled flags
function sonauraUpdateGraph(settings) {
  if (!nodes || !sonauraCtx) return;
  const {
    sourceNode,
    surroundNodes,
    eqBands,
    compressor,
    exciterNodes,
    convolver,
    reverbHighpass,
    reverbLowpass,
    reverbWetGain,
    reverbDryGain,
    limiterNode,
    finalGain
  } = nodes;
  const { cinemaHall, surroundEnabled, surroundIntensity, bypass, exciterEnabled } = settings;

  // Disconnect everything first to start clean
  try {
    sourceNode.disconnect();
    surroundNodes.surroundBus.disconnect();
    for (let i = 0; i < 10; i++) eqBands[i].disconnect();
    compressor.disconnect();
    exciterNodes.summingGain.disconnect();
    exciterNodes.lowpass.disconnect();
    exciterNodes.waveshaper.disconnect();
    if (exciterNodes.postLowpass) exciterNodes.postLowpass.disconnect();
    exciterNodes.mixGain.disconnect();
    convolver.disconnect();
    if (reverbHighpass) reverbHighpass.disconnect();
    if (reverbLowpass) reverbLowpass.disconnect();
    reverbWetGain.disconnect();
    reverbDryGain.disconnect();
    limiterNode.disconnect();
    visualizerAnalyser.disconnect();
    finalGain.disconnect();
  } catch(e) {
    // Ignore initial disconnect errors
  }

  // Bypass Mode: Connect directly source to destination
  if (bypass) {
    sourceNode.connect(visualizerAnalyser);
    visualizerAnalyser.connect(sonauraCtx.destination);
    return;
  }

  // 1. Position Surround Panners on a unit-circle of radius 1 (to prevent distance attenuation)
  const basePositions = {
    L: [-0.5, 0, -0.866],
    R: [0.5, 0, -0.866],
    C: [0, 0, -1.0],
    LS: [-0.94, 0, 0.34],
    RS: [0.94, 0, 0.34],
    LFE: [0, 0, -1.0]
  };
  const scale = Math.abs(Math.max(0.1, Math.min(2.5, surroundIntensity)));

  for (const [ch, panner] of Object.entries(surroundNodes.panners)) {
    panner.panningModel = surroundEnabled ? 'HRTF' : 'equalpower';
    if (surroundEnabled) {
      const x = basePositions[ch][0] * scale;
      const y = 0;
      const z = basePositions[ch][2] * scale;
      if (panner.positionZ) {
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
      } else {
        panner.setPosition(x, y, z);
      }
    } else {
      // Pure stereo fallback positioning
      let x = 0;
      if (ch === 'L' || ch === 'LS') x = -1.0;
      else if (ch === 'R' || ch === 'RS') x = 1.0;
      
      if (panner.positionZ) {
        panner.positionX.value = x;
        panner.positionY.value = 0;
        panner.positionZ.value = 0;
      } else {
        panner.setPosition(x, 0, 0);
      }
    }
  }

  // 2. Route Surround Bus
  sourceNode.connect(surroundNodes.splitter);
  surroundNodes.surroundBus.connect(eqBands[0]);
  for (let i = 0; i < 9; i++) {
    eqBands[i].connect(eqBands[i+1]);
  }
  eqBands[9].connect(compressor);

  // 3. Route Exciter in Parallel
  compressor.connect(exciterNodes.summingGain);
  if (exciterEnabled) {
    compressor.connect(exciterNodes.lowpass);
    exciterNodes.lowpass.connect(exciterNodes.waveshaper);
    exciterNodes.waveshaper.connect(exciterNodes.postLowpass);
    exciterNodes.postLowpass.connect(exciterNodes.mixGain);
    exciterNodes.mixGain.connect(exciterNodes.summingGain);
  }

  let currentNode = exciterNodes.summingGain;

  // 4. Route Reverb and Limiter
  if (cinemaHall) {
    currentNode.connect(convolver);
    convolver.connect(reverbHighpass);
    reverbHighpass.connect(reverbLowpass);
    reverbLowpass.connect(reverbWetGain);
    
    currentNode.connect(reverbDryGain);

    const mix = settings.cinemaHallMix !== undefined ? settings.cinemaHallMix : 0.5;
    reverbWetGain.gain.value = mix * 0.35; // Blend in parallel wet tail
    reverbDryGain.gain.value = 1.0; // Keep full dry signal level

    reverbWetGain.connect(limiterNode);
    reverbDryGain.connect(limiterNode);
  } else {
    currentNode.connect(limiterNode);
  }

  // Limiter -> Visualizer -> Final Gain -> Output
  limiterNode.connect(visualizerAnalyser);
  visualizerAnalyser.connect(finalGain);
  finalGain.connect(sonauraCtx.destination);
}

// Ramp audio parameters smoothly to avoid glitches
function applySettingsToNodes(settings) {
  if (!nodes || !sonauraCtx) return;
  const { eqBands, compressor, exciterNodes, finalGain } = nodes;
  const now = sonauraCtx.currentTime;

  const rampParam = (param, value, time = 0.05) => {
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(value, now + time);
    } catch (e) { 
      param.value = value; 
    }
  };

  // EQ configuration
  if (settings.autoCalibratedGains && settings.autoCalibratedGains.length === 10) {
    settings.autoCalibratedGains.forEach((g, i) => rampParam(eqBands[i].gain, g, 0.5));
  } else {
    rampParam(eqBands[0].gain, settings.bassBoost);
    rampParam(eqBands[1].gain, settings.bassBoost * 0.8);
    rampParam(eqBands[2].gain, settings.bassBoost * 0.4);
    for (let i = 3; i <= 6; i++) rampParam(eqBands[i].gain, 0);
    rampParam(eqBands[7].gain, settings.treble * 0.4);
    rampParam(eqBands[8].gain, settings.treble * 0.8);
    rampParam(eqBands[9].gain, settings.treble);
  }

  // Exciter configuration
  if (settings.exciterMix !== undefined) {
    rampParam(exciterNodes.mixGain.gain, settings.exciterMix);
  }
  
  // Master Volume
  rampParam(finalGain.gain, settings.masterVolume);
  
  // Compressor settings (relaxed in normal mode to prevent volume drops)
  rampParam(compressor.ratio, settings.compressorNightMode ? 8 : 2);
  rampParam(compressor.threshold, settings.compressorNightMode ? -32 : -16);

  sonauraUpdateGraph(settings);
}

// Update the Sonaura Settings & Audio Graph
async function applySonauraSettings(settings) {
  if (settings.customIR !== currentSettings.customIR) {
    if (settings.customIR) {
      const buffer = await decodeBase64Audio(sonauraCtx, settings.customIR);
      if (buffer && nodes) {
        activeCinemaIRBuffer = buffer;
        nodes.convolver.buffer = buffer;
      }
    } else {
      activeCinemaIRBuffer = syntheticCinemaIRBuffer;
      if (nodes) nodes.convolver.buffer = syntheticCinemaIRBuffer;
    }
  }

  Object.assign(currentSettings, settings);
  applySettingsToNodes(currentSettings);
}

// Room Auto-Calibration Algorithm
function autoCalibrate(sendResponse) {
  if (!nodes || !sonauraCtx) {
    return sendResponse({ error: "Audio context not initialized." });
  }

  const analyser = sonauraCtx.createAnalyser();
  analyser.fftSize = 2048; 
  
  // Hook the analyser up to the output of surround bus to measure the incoming level
  nodes.surroundNodes.surroundBus.connect(analyser);
  
  const bufferLength = analyser.frequencyBinCount; 
  const dataArray = new Uint8Array(bufferLength);
  const sumArray = new Float32Array(bufferLength);
  let frames = 0;
  
  const startTime = performance.now();
  const loop = () => {
    if (performance.now() - startTime >= 5000) {
      finishCalibration(); 
      return;
    }
    analyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < bufferLength; i++) {
      sumArray[i] += dataArray[i];
    }
    frames++;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  
  function finishCalibration() {
    try {
      nodes.surroundNodes.surroundBus.disconnect(analyser);
    } catch(e) {}

    if (frames === 0) {
      return sendResponse({ error: "Calibration failed (no frames recorded)." });
    }
    
    const avgArray = new Float32Array(bufferLength);
    let maxAvg = 0;
    for (let i = 0; i < bufferLength; i++) {
      avgArray[i] = sumArray[i] / frames;
      if (avgArray[i] > maxAvg) maxAvg = avgArray[i];
    }
    
    // If audio is completely silent or muted, warn user
    if (maxAvg < 5) {
      return sendResponse({ error: "Audio level too low. Play media with sound on first." });
    }
    
    const nyquist = sonauraCtx.sampleRate / 2;
    const binSize = nyquist / bufferLength;
    const targetArray = new Float32Array(bufferLength);
    
    // Target cinema curve: flat up to 2kHz, then roll off -3dB/octave
    for (let i = 0; i < bufferLength; i++) {
      const freq = i * binSize;
      let targetDB = freq > 2000 ? -3 * Math.log2(freq / 2000) : 0;
      targetArray[i] = 128 + (targetDB * (255 / 70)); // Map dB to 0-255 scale
    }
    
    const eqFrequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const computedGains = [];
    
    for (let b = 0; b < eqFrequencies.length; b++) {
      const binIndex = Math.floor(eqFrequencies[b] / binSize);
      const window = Math.max(1, Math.floor(binIndex * 0.2)); 
      
      let start = Math.max(0, binIndex - window);
      let end = Math.min(bufferLength - 1, binIndex + window);
      let currentAvg = 0, targetAvg = 0, count = 0;
      for (let i = start; i <= end; i++) {
        currentAvg += avgArray[i]; 
        targetAvg += targetArray[i]; 
        count++;
      }
      currentAvg /= count; 
      targetAvg /= count;
      
      let correctionDB = (targetAvg - currentAvg) * (70 / 255);
      // Clamp between -12dB and +12dB to prevent extreme clipping
      computedGains.push(Math.max(-12, Math.min(12, correctionDB)));
    }
    
    currentSettings.autoCalibratedGains = computedGains;
    applySettingsToNodes(currentSettings);
    sendResponse({ success: true, gains: computedGains });
  }
}

// Helper to initialize and resume the AudioContext synchronously
function initAudioContext() {
  if (!sonauraCtx) {
    sonauraCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  }
  if (sonauraCtx.state === 'suspended') {
    sonauraCtx.resume().then(() => {
      console.log("Sonaura: AudioContext successfully resumed in offscreen.");
    }).catch(err => {
      console.error("Sonaura: Failed to resume AudioContext", err);
    });
  }
}

// Receive messages from background script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'start-audio-process') {
    const { streamId } = message;
    
    // Resume or create AudioContext synchronously in user-gesture callstack
    initAudioContext();
    
    // Stop any existing stream
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
    }

    // Get UserMedia tab capture stream
    navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      }
    }).then(async (stream) => {
      mediaStream = stream;
      
      // Notify background when the stream ends naturally (tab closed, navigated, reloaded)
      stream.getAudioTracks().forEach(track => {
        track.onended = () => {
          console.log("Sonaura: Capture stream track ended naturally.");
          chrome.runtime.sendMessage({ type: 'stream-ended-naturally' });
        };
      });
      
      // Use settings passed from background service worker
      if (message.settings) {
        Object.assign(currentSettings, message.settings);
      }
      
      // Set up the graph and nodes
      setupAudioGraph(stream);
      applySettingsToNodes(currentSettings);
      
      console.log("Sonaura: Capture successfully running in offscreen document.");
      sendResponse({ success: true });
    }).catch(err => {
      console.error("Sonaura Offscreen getUserMedia error:", err);
      sendResponse({ success: false, error: err.message });
    });
    
    return true; // async
  } else if (message.type === 'stop-audio-process') {
    const cleanup = async () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      }
      if (sonauraCtx) {
        try {
          await sonauraCtx.close();
        } catch (e) {}
        sonauraCtx = null;
      }
      nodes = null;
      visualizerAnalyser = null;
      console.log("Sonaura: Capture stopped and cleaned up.");
    };
    cleanup().then(() => {
      sendResponse({ success: true });
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'sonauraUpdate' && message.settings) {
    applySonauraSettings(message.settings);
    sendResponse({ success: true });
  } else if (message.type === 'sonauraAutoCalibrate') {
    autoCalibrate(sendResponse);
    return true; // async response
  }
});

// Setup visualizer port connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sonaura-visualizer') {
    const interval = setInterval(() => {
      if (visualizerAnalyser) {
        const dataArray = new Uint8Array(visualizerAnalyser.frequencyBinCount);
        visualizerAnalyser.getByteFrequencyData(dataArray);
        
        // Downsample to 48 frequency bars inside offscreen document to minimize IPC overhead
        const barCount = 48;
        const step = Math.floor(dataArray.length / barCount);
        const downsampled = new Uint8Array(barCount);
        for (let i = 0; i < barCount; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) {
            sum += dataArray[i * step + j];
          }
          downsampled[i] = Math.round(sum / step);
        }
        
        port.postMessage({ frequencyData: Array.from(downsampled) });
      }
    }, 40); // ~25 FPS visualizer streaming
    
    port.onDisconnect.addListener(() => {
      clearInterval(interval);
    });
  }
});
