// popup.js - Sonaura 2.0 Interface Logic

const presets = {
  cinema: { preset: 'cinema', bassBoost: 6, treble: 2, surroundEnabled: true, surroundIntensity: 1.0, cinemaHall: true, cinemaHallMix: 0.5, masterVolume: 0.9, compressorNightMode: false, bypass: false, exciterEnabled: true, exciterMix: 0.2 },
  action: { preset: 'action', bassBoost: 10, treble: 4, surroundEnabled: true, surroundIntensity: 1.5, cinemaHall: true, cinemaHallMix: 0.6, masterVolume: 0.95, compressorNightMode: false, bypass: false, exciterEnabled: true, exciterMix: 0.35 },
  dialogue: { preset: 'dialogue', bassBoost: -2, treble: 6, surroundEnabled: false, surroundIntensity: 1.0, cinemaHall: false, cinemaHallMix: 0.5, masterVolume: 0.85, compressorNightMode: false, bypass: false, exciterEnabled: false, exciterMix: 0 },
  night: { preset: 'night', bassBoost: -4, treble: 2, surroundEnabled: false, surroundIntensity: 1.0, cinemaHall: false, cinemaHallMix: 0.5, masterVolume: 0.7, compressorNightMode: true, bypass: false, exciterEnabled: false, exciterMix: 0 },
  bypass: { preset: 'bypass', bassBoost: 0, treble: 0, surroundEnabled: false, surroundIntensity: 1.0, cinemaHall: false, cinemaHallMix: 0.5, masterVolume: 1, compressorNightMode: false, bypass: true, exciterEnabled: false, exciterMix: 0 }
};

const UI = {
  powerBtn: document.getElementById('power-btn'),
  controlsContainer: document.getElementById('controls-container'),
  statusBanner: document.getElementById('status-banner'),
  preset: document.getElementById('preset-select'),
  savePresetBtn: document.getElementById('save-preset-btn'),
  deletePresetBtn: document.getElementById('delete-preset-btn'),
  calibrateBtn: document.getElementById('calibrate-btn'),
  irUploadInput: document.getElementById('ir-upload'),
  irUploadBtn: document.getElementById('ir-upload-btn'),
  irResetBtn: document.getElementById('ir-reset-btn'),
  surround: document.getElementById('surround-toggle'),
  reverb: document.getElementById('reverb-toggle'),
  exciter: document.getElementById('exciter-toggle'),

  volume: document.getElementById('volume-slider'),
  bass: document.getElementById('bass-slider'),
  treble: document.getElementById('treble-slider'),
  intensity: document.getElementById('surround-intensity-slider'),
  exciterMix: document.getElementById('exciter-mix-slider'),
  volumeVal: document.getElementById('volume-val'),
  bassVal: document.getElementById('bass-val'),
  trebleVal: document.getElementById('treble-val'),
  intensityVal: document.getElementById('surround-intensity-val'),
  exciterMixVal: document.getElementById('exciter-mix-val'),
  canvas: document.getElementById('visualizer'),
  themeToggle: document.getElementById('theme-toggle')
};

let isEnabled = false;
let currentTabId = null;
let customPresets = {};
let currentCustomIR = null;
let currentAutoCalibratedGains = null;
let currentCinemaHallMix = 0.5;

let visualizerPort = null;
let canvasCtx = UI.canvas.getContext('2d');
const barCount = 48;
let idleTime = 0;
let visualizerConnected = false;
let idleAnimationId = null;

// Synchronize preset options
function refreshPresetDropdown() {
  UI.preset.innerHTML = `
    <option value="cinema">Cinema Default</option>
    <option value="action">Action Boost</option>
    <option value="dialogue">Dialogue Clarity</option>
    <option value="night">Night Mode</option>
    <option value="bypass">Bypass</option>
    <option value="custom_unsaved" hidden>Custom...</option>
  `;
  for (const [id, data] of Object.entries(customPresets)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.innerText = data.name;
    UI.preset.appendChild(opt);
  }
}

// Update Power Button & UI Enabled State
function updatePowerButtonState(active) {
  if (active) {
    UI.powerBtn.classList.remove('offline');
    UI.powerBtn.classList.add('online');
    UI.controlsContainer.classList.remove('controls-disabled');
    UI.statusBanner.innerText = "CINEMA AUDIO ACTIVE!";
    UI.statusBanner.classList.add('active');
    UI.statusBanner.style.removeProperty('background');
    UI.statusBanner.style.removeProperty('color');
  } else {
    UI.powerBtn.classList.remove('online');
    UI.powerBtn.classList.add('offline');
    UI.controlsContainer.classList.add('controls-disabled');
    UI.statusBanner.innerText = "Click Power Button to Boost Tab Audio";
    UI.statusBanner.classList.remove('active');
    UI.statusBanner.style.removeProperty('background');
    UI.statusBanner.style.removeProperty('color');
  }
}

// Format parameter labels
function updateLabels() {
  UI.volumeVal.innerText = parseFloat(UI.volume.value).toFixed(2);
  
  const bassVal = parseFloat(UI.bass.value);
  UI.bassVal.innerText = (bassVal > 0 ? '+' : '') + bassVal.toFixed(1) + ' dB';
  
  const trebleVal = parseFloat(UI.treble.value);
  UI.trebleVal.innerText = (trebleVal > 0 ? '+' : '') + trebleVal.toFixed(1) + ' dB';
  
  UI.intensityVal.innerText = parseFloat(UI.intensity.value).toFixed(1);
  UI.exciterMixVal.innerText = parseFloat(UI.exciterMix.value).toFixed(2);
}

// Apply settings state to DOM elements
function applySettingsToUI(settings, isUserAction = false) {
  if (!isUserAction && settings.preset) UI.preset.value = settings.preset;
  UI.surround.checked = settings.surroundEnabled ?? true;
  UI.reverb.checked = settings.cinemaHall ?? true;
  if (settings.cinemaHallMix !== undefined) currentCinemaHallMix = settings.cinemaHallMix;
  UI.exciter.checked = settings.exciterEnabled ?? true;
  UI.volume.value = settings.masterVolume ?? 0.9;
  UI.bass.value = settings.bassBoost ?? 6;
  UI.treble.value = settings.treble ?? 2;
  UI.intensity.value = settings.surroundIntensity ?? 1.0;
  UI.exciterMix.value = settings.exciterMix ?? 0.2;
  updateLabels();
}

// Theme Toggle Helper
function initTheme() {
  chrome.storage.local.get(['theme'], (result) => {
    let currentTheme = result.theme;
    if (!currentTheme) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      currentTheme = prefersDark ? 'dark' : 'light';
    }
    setTheme(currentTheme);
  });
  
  UI.themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextTheme = isDark ? 'light' : 'dark';
    setTheme(nextTheme);
    chrome.storage.local.set({ theme: nextTheme });
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    UI.themeToggle.innerText = "Light Mode";
  } else {
    UI.themeToggle.innerText = "Dark Mode";
  }
}

// Helper to convert rgb(r, g, b) styles to rgba
function getAlphaColor(cssVar, alpha) {
  const val = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  if (val.startsWith('rgba')) {
    return val;
  }
  if (val.startsWith('rgb')) {
    return val.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
  }
  return val;
}

// Read settings state from DOM elements
function getSettingsFromUI() {
  const presetKey = UI.preset.value;
  const matchedPreset = presets[presetKey] || (customPresets[presetKey] ? customPresets[presetKey].settings : null);
  
  return {
    preset: presetKey,
    surroundEnabled: UI.surround.checked,
    cinemaHall: UI.reverb.checked,
    cinemaHallMix: matchedPreset ? matchedPreset.cinemaHallMix : currentCinemaHallMix,
    exciterEnabled: UI.exciter.checked,
    adaptiveThemeEnabled: false,
    masterVolume: parseFloat(UI.volume.value),
    bassBoost: parseFloat(UI.bass.value),
    treble: parseFloat(UI.treble.value),
    surroundIntensity: parseFloat(UI.intensity.value),
    exciterMix: parseFloat(UI.exciterMix.value),
    compressorNightMode: presetKey === 'night',
    bypass: !isEnabled || presetKey === 'bypass',
    customIR: currentCustomIR,
    autoCalibratedGains: currentAutoCalibratedGains
  };
}

// Save settings to Chrome storage and sync with running offscreen process
function saveAndNotifySettings() {
  updateLabels();
  const settings = getSettingsFromUI();
  chrome.storage.local.set({ sonauraSettings: settings }, () => {
    // Send message directly to offscreen document
    chrome.runtime.sendMessage({
      type: 'sonauraUpdate',
      target: 'offscreen',
      settings
    }).catch(() => {});
  });
}

function onSettingModified() {
  UI.preset.value = 'custom_unsaved';
  UI.savePresetBtn.classList.remove('hide');
  UI.deletePresetBtn.classList.add('hide');
  saveAndNotifySettings();
}

// Visualizer Rendering Loops
function drawIdle() {
  if (visualizerConnected) return;
  canvasCtx.clearRect(0, 0, UI.canvas.width, UI.canvas.height);
  const w = UI.canvas.width / barCount;
  
  canvasCtx.lineWidth = 1.5;
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  canvasCtx.strokeStyle = isDarkMode ? '#ffffff' : '#000000';
  canvasCtx.lineCap = 'round';
  
  for (let i = 0; i < barCount; i++) {
    let h = 4 + Math.sin(idleTime + i * 0.15) * 3;
    if (!isEnabled) h = 1.5; // Flat line if extension powered down
    
    const x = i * w + w / 2;
    const yTop = UI.canvas.height - h;
    const yBot = UI.canvas.height - 2;
    
    canvasCtx.beginPath();
    // Add minor pencil jitter
    canvasCtx.moveTo(x + (Math.random() - 0.5) * 1, yBot);
    canvasCtx.lineTo(x + (Math.random() - 0.5) * 1, yTop);
    canvasCtx.stroke();
  }
  idleTime += 0.04;
  idleAnimationId = requestAnimationFrame(drawIdle);
}

function drawVisualizer(data) {
  if (idleAnimationId) {
    cancelAnimationFrame(idleAnimationId);
    idleAnimationId = null;
  }
  canvasCtx.clearRect(0, 0, UI.canvas.width, UI.canvas.height);
  const w = UI.canvas.width / barCount;
  
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  canvasCtx.strokeStyle = isDarkMode ? '#ffffff' : '#000000';
  canvasCtx.lineCap = 'round';
  
  for (let i = 0; i < barCount; i++) {
    let val = data[i] || 0;
    let h = (val / 255) * UI.canvas.height * 0.95;
    if (h < 4) h = 4;
    
    const x = i * w + w / 2;
    const yTop = UI.canvas.height - h;
    const yBot = UI.canvas.height - 2;
    
    // Draw the main vertical outline
    canvasCtx.lineWidth = 2.5;
    canvasCtx.beginPath();
    canvasCtx.moveTo(x + (Math.random() - 0.5) * 1.5, yBot);
    canvasCtx.lineTo(x + (Math.random() - 0.5) * 1.5, yTop);
    canvasCtx.stroke();
    
    // Draw diagonal hatch marks across the bar (matching felt-tip sketch style)
    if (h > 15) {
      canvasCtx.lineWidth = 1.2;
      canvasCtx.beginPath();
      for (let y = yBot - 4; y > yTop; y -= 6) {
        canvasCtx.moveTo(x - 2.5, y + 2);
        canvasCtx.lineTo(x + 2.5, y - 2);
      }
      canvasCtx.stroke();
    }
  }
}

// Connect visualizer data port
function connectVisualizer() {
  disconnectVisualizer();
  
  visualizerPort = chrome.runtime.connect({ name: 'sonaura-visualizer' });
  visualizerPort.onMessage.addListener((msg) => {
    if (msg.frequencyData) {
      visualizerConnected = true;
      drawVisualizer(msg.frequencyData);
    }
  });
  
  visualizerPort.onDisconnect.addListener(() => {
    visualizerConnected = false;
    drawIdle();
  });
}

function disconnectVisualizer() {
  if (visualizerPort) {
    try {
      visualizerPort.disconnect();
    } catch(e) {}
    visualizerPort = null;
  }
  visualizerConnected = false;
}

// Load initialization data
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  // Query active tab ID
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    currentTabId = tabs[0].id;
    
    // Check if Sonaura is currently capturing this tab
    chrome.runtime.sendMessage({ type: 'check-active-capture', tabId: currentTabId }, (captureRes) => {
      const isThisTabCaptured = captureRes && captureRes.activeTabId === currentTabId;
      isEnabled = isThisTabCaptured;
      updatePowerButtonState(isEnabled);
      
      // Load saved settings & custom profiles
      chrome.storage.local.get(['sonauraSettings', 'sonauraCustomPresets'], (storageRes) => {
        if (storageRes.sonauraCustomPresets) {
          customPresets = storageRes.sonauraCustomPresets;
        }
        refreshPresetDropdown();
        
        const settings = storageRes.sonauraSettings || presets.cinema;
        if (settings.customIR) currentCustomIR = settings.customIR;
        if (settings.autoCalibratedGains) currentAutoCalibratedGains = settings.autoCalibratedGains;
        
        applySettingsToUI(settings);
        
        if (settings.preset && customPresets[settings.preset]) {
          UI.deletePresetBtn.classList.remove('hide');
        } else if (settings.preset === 'custom_unsaved') {
          UI.savePresetBtn.classList.remove('hide');
        }
        
        if (isEnabled) {
          connectVisualizer();
        } else {
          drawIdle();
        }
      });
    });
  });
});

// Power Button Event Listener
// Power Button Event Listener
UI.powerBtn.addEventListener('click', () => {
  if (!currentTabId || UI.powerBtn.classList.contains('processing')) return;
  
  UI.powerBtn.classList.add('processing');
  UI.powerBtn.style.opacity = "0.5";
  
  if (!isEnabled) {
    UI.statusBanner.innerText = "STARTING CAPTURE...";
    
    const startCaptureWithRetry = (retriesLeft = 5) => {
      // Request tab capture stream token (requires user gesture)
      chrome.tabCapture.getMediaStreamId({ targetTabId: currentTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          const errorMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "No stream ID returned.";
          
          // If tab is closing a previous stream, retry automatically after 300ms
          if (errorMsg.includes("active stream") && retriesLeft > 0) {
            console.warn(`Sonaura: Capture failed due to active stream. Retrying... (${retriesLeft} left)`);
            setTimeout(() => {
              startCaptureWithRetry(retriesLeft - 1);
            }, 300);
            return;
          }
          
          console.error("Sonaura: Capture failed:", errorMsg);
          alert("Tab capture failed: " + errorMsg + "\n\nNote: Chrome extensions cannot capture chrome://, chrome-extension://, or Chrome Web Store tabs. Please test on a standard website (e.g. YouTube or Netflix).");
          UI.powerBtn.classList.remove('processing');
          UI.powerBtn.style.opacity = "1";
          updatePowerButtonState(isEnabled);
          return;
        }
        
        // Forward streamId to background thread to fire offscreen node
        chrome.runtime.sendMessage({
          type: 'init-capture',
          streamId,
          tabId: currentTabId
        }, (response) => {
          // Keep button disabled for a brief stabilization delay (500ms total cooldown)
          setTimeout(() => {
            UI.powerBtn.classList.remove('processing');
            UI.powerBtn.style.opacity = "1";
          }, 350);

          if (response && response.success) {
            isEnabled = true;
            updatePowerButtonState(isEnabled);
            saveAndNotifySettings();
            connectVisualizer();
          } else {
            alert("Error opening Sonaura: " + (response ? response.error : "Unknown background error."));
            updatePowerButtonState(isEnabled);
          }
        });
      });
    };
    
    startCaptureWithRetry();
  } else {
    UI.statusBanner.innerText = "STOPPING CAPTURE...";
    // Disable capture
    chrome.runtime.sendMessage({ type: 'stop-capture' }, (response) => {
      // Force a 500ms cooldown delay to let Chrome release native streams before accepting a new ON click
      setTimeout(() => {
        UI.powerBtn.classList.remove('processing');
        UI.powerBtn.style.opacity = "1";
      }, 500);

      if (response && response.success) {
        isEnabled = false;
        updatePowerButtonState(isEnabled);
        saveAndNotifySettings();
        disconnectVisualizer();
        drawIdle();
      } else {
        updatePowerButtonState(isEnabled);
      }
    });
  }
});

// Bind slider adjustments
[UI.volume, UI.bass, UI.treble, UI.intensity, UI.exciterMix].forEach(slider => {
  slider.addEventListener('input', () => {
    if (slider === UI.bass || slider === UI.treble) {
      currentAutoCalibratedGains = null;
    }
    onSettingModified();
  });
});

// Bind toggle switches
[UI.surround, UI.reverb, UI.exciter].forEach(toggle => {
  toggle.addEventListener('change', onSettingModified);
});



// Bind preset selections
UI.preset.addEventListener('change', (e) => {
  const presetKey = e.target.value;
  UI.savePresetBtn.classList.add('hide');
  
  if (customPresets[presetKey]) {
    UI.deletePresetBtn.classList.remove('hide');
    applySettingsToUI(customPresets[presetKey].settings);
  } else if (presets[presetKey]) {
    UI.deletePresetBtn.classList.add('hide');
    applySettingsToUI(presets[presetKey]);
  }
  saveAndNotifySettings();
});

// Create custom preset profile
UI.savePresetBtn.addEventListener('click', () => {
  const name = prompt("Enter a name for your custom profile:");
  if (!name) return;
  
  const id = 'custom_' + Date.now();
  const newPresetSettings = getSettingsFromUI();
  newPresetSettings.preset = id;
  
  customPresets[id] = { name: name, settings: newPresetSettings };
  chrome.storage.local.set({ sonauraCustomPresets: customPresets }, () => {
    refreshPresetDropdown();
    UI.preset.value = id;
    UI.savePresetBtn.classList.add('hide');
    UI.deletePresetBtn.classList.remove('hide');
    saveAndNotifySettings();
  });
});

// Delete custom preset profile
UI.deletePresetBtn.addEventListener('click', () => {
  if (confirm("Delete this custom preset?")) {
    const id = UI.preset.value;
    delete customPresets[id];
    chrome.storage.local.set({ sonauraCustomPresets: customPresets }, () => {
      refreshPresetDropdown();
      UI.preset.value = 'cinema';
      applySettingsToUI(presets.cinema);
      saveAndNotifySettings();
      UI.deletePresetBtn.classList.add('hide');
      UI.savePresetBtn.classList.add('hide');
    });
  }
});

// Room EQ Calibration trigger
UI.calibrateBtn.addEventListener('click', () => {
  const btn = UI.calibrateBtn;
  const originalText = btn.innerText;
  
  btn.innerText = "LISTENING... (5s)";
  btn.disabled = true;
  btn.style.opacity = "0.5";
  
  chrome.runtime.sendMessage({
    type: 'sonauraAutoCalibrate',
    target: 'offscreen'
  }, (response) => {
    btn.disabled = false;
    btn.style.opacity = "1";
    
    if (chrome.runtime.lastError || !response) {
      btn.innerText = "ERROR (OFFLINE)";
      setTimeout(() => btn.innerText = originalText, 2500);
      return;
    }
    
    if (response.error) {
      btn.innerText = "RETRY";
      alert("Calibration Error: " + response.error);
      setTimeout(() => btn.innerText = originalText, 2500);
    } else if (response.success) {
      btn.innerText = "SUCCESS!";
      currentAutoCalibratedGains = response.gains;
      saveAndNotifySettings();
      setTimeout(() => btn.innerText = originalText, 2500);
    }
  });
});

// Custom Reverb WAV Upload trigger
UI.irUploadBtn.addEventListener('click', () => UI.irUploadInput.click());

UI.irUploadInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (evt) => {
    currentCustomIR = evt.target.result;
    saveAndNotifySettings();
    UI.irUploadBtn.innerText = "Uploaded!";
    setTimeout(() => UI.irUploadBtn.innerText = "Upload .WAV", 2000);
  };
  reader.readAsDataURL(file);
});

// Custom Reverb WAV Reset trigger
UI.irResetBtn.addEventListener('click', () => {
  currentCustomIR = null;
  saveAndNotifySettings();
  UI.irResetBtn.innerText = "Restored!";
  setTimeout(() => UI.irResetBtn.innerText = "Reset Default", 2000);
});

// Listen to dynamic theme color updates from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'sonaura-theme-update' && message.colors) {
    if (UI.adaptiveTheme && UI.adaptiveTheme.checked) {
      applyDynamicTheme(message.colors.primary, message.colors.secondary);
    }
  }
});
