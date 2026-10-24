/* ScanSafe camera capture. Database verification and assignment belong to the caller. */
(function () {
  'use strict';

  let options = {
    elementId: 'scanSafeQrReader',
    cameraSelectId: 'scannerCameraSelect',
    libraryUrl: 'assets/vendor/html5-qrcode.min.js',
    onDecode: async function () {},
    onStatus: function () {}
  };
  let state = 'idle';
  let generation = 0;
  let desiredRunning = false;
  let scanner = null;
  let startPromise = null;
  let stopPromise = null;
  let libraryPromise = null;
  let handlingDecode = false;
  let preferredDeviceId = '';
  let cameras = [];
  let selectElement = null;
  let previewLayout = null;
  const cleanups = new WeakMap();

  function publish(next, message, error) {
    state = next;
    try {
      options.onStatus({ state: next, message: message || '', error: error || null, cameras: cameras.slice() });
    } catch (callbackError) {
      console.error('Scanner status callback:', callbackError);
    }
  }

  function current(token) {
    return desiredRunning && generation === token;
  }

  function fitPreview() {
    if (!previewLayout) return;
    const reader = previewLayout.reader;
    const frame = previewLayout.frame;
    const width = frame.clientWidth;
    if (!width) return;
    const video = reader.querySelector('video');
    const ratio = video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    reader.style.transform = 'scale(' + (width / 1280) + ')';
    frame.style.height = Math.ceil(width / ratio) + 'px';
  }

  function preparePreview(reader) {
    if (previewLayout && previewLayout.reader === reader) return;
    restorePreview();
    const frame = reader.closest('.scan-frame') || reader.parentElement;
    if (!frame) return;
    const readerKeys = ['width', 'height', 'position', 'left', 'top', 'transform', 'transformOrigin'];
    const frameKeys = ['height', 'position', 'overflow'];
    const previousReader = {};
    const previousFrame = {};
    readerKeys.forEach(function (key) { previousReader[key] = reader.style[key]; });
    frameKeys.forEach(function (key) { previousFrame[key] = frame.style[key]; });
    previewLayout = { reader: reader, frame: frame, previousReader: previousReader, previousFrame: previousFrame, observer: null };
    // The library sizes its decode canvas from video.clientWidth. Keep 1280
    // layout pixels for long CODE128 values; transforms resize only the preview.
    reader.style.width = '1280px';
    reader.style.height = 'auto';
    reader.style.position = 'absolute';
    reader.style.left = '0';
    reader.style.top = '0';
    reader.style.transformOrigin = 'top left';
    frame.style.position = 'relative';
    frame.style.overflow = 'hidden';
    reader.addEventListener('loadedmetadata', fitPreview, true);
    if (typeof window.ResizeObserver === 'function') {
      previewLayout.observer = new window.ResizeObserver(fitPreview);
      previewLayout.observer.observe(frame);
    }
    window.addEventListener('resize', fitPreview);
    fitPreview();
  }

  function restorePreview() {
    if (!previewLayout) return;
    const previous = previewLayout;
    previewLayout = null;
    if (previous.observer) previous.observer.disconnect();
    previous.reader.removeEventListener('loadedmetadata', fitPreview, true);
    window.removeEventListener('resize', fitPreview);
    Object.keys(previous.previousReader).forEach(function (key) { previous.reader.style[key] = previous.previousReader[key]; });
    Object.keys(previous.previousFrame).forEach(function (key) { previous.frame.style[key] = previous.previousFrame[key]; });
  }

  function cameraError(error) {
    const description = String(error && (error.message || error.name) || error || '');
    if (/NotAllowed|PermissionDenied|permission.*denied|Permission dismissed|SecurityError/i.test(description)) {
      return 'Camera access was blocked. Allow camera permission for this site, then try again.';
    }
    if (/NotFound|DevicesNotFound|no camera|Requested device not found/i.test(description)) {
      return 'No camera was found. Connect a camera, choose it, and try again.';
    }
    if (/NotReadable|TrackStartError|Could not start video|in use/i.test(description)) {
      return 'The camera could not open. Close other apps using it, then try again.';
    }
    if (/Overconstrained|ConstraintNotSatisfied/i.test(description)) {
      return 'This camera could not use the requested settings. Choose another camera or try again.';
    }
    return 'The camera could not start. Check camera permission and try again, or enter the barcode manually.';
  }

  function ensureLibrary() {
    if (typeof window.Html5Qrcode === 'function') return Promise.resolve(true);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      const timeout = setTimeout(function () { finish(new Error('Barcode reader could not load. Reload and try again.')); }, 15000);
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else resolve(true);
      }
      script.src = new URL(options.libraryUrl, document.baseURI).href;
      script.async = true;
      script.dataset.scansafeScannerLibrary = '1';
      script.onload = function () {
        finish(typeof window.Html5Qrcode === 'function' ? null : new Error('Barcode reader was not available after loading.'));
      };
      script.onerror = function () { finish(new Error('Barcode reader could not load. Check the connection and try again.')); };
      document.head.appendChild(script);
    }).catch(function (error) {
      libraryPromise = null;
      throw error;
    });
    return libraryPromise;
  }

  function releaseVisibleTracks() {
    const reader = document.getElementById(options.elementId);
    if (!reader) return;
    reader.querySelectorAll('video').forEach(function (video) {
      const stream = video.srcObject;
      if (stream && typeof stream.getTracks === 'function') {
        stream.getTracks().forEach(function (track) { try { track.stop(); } catch (_) {} });
      }
    });
  }

  function dispose(instance) {
    if (!instance) return Promise.resolve();
    if (cleanups.has(instance)) return cleanups.get(instance);
    const cleanup = (async function () {
      try { await instance.stop(); } catch (_) { releaseVisibleTracks(); }
      try { instance.clear(); } catch (_) {}
      if (scanner === instance) scanner = null;
    })();
    cleanups.set(instance, cleanup);
    return cleanup;
  }

  async function refreshCameras(token) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!current(token)) return;
      cameras = devices.filter(function (device) { return device.kind === 'videoinput'; })
        .map(function (device, index) { return { id: device.deviceId, label: device.label || ('Camera ' + (index + 1)) }; });
      if (selectElement) {
        const previousValue = preferredDeviceId;
        selectElement.replaceChildren();
        const automatic = document.createElement('option');
        automatic.value = '';
        automatic.textContent = 'Automatic (prefer rear camera)';
        selectElement.appendChild(automatic);
        cameras.forEach(function (camera) {
          const option = document.createElement('option');
          option.value = camera.id;
          option.textContent = camera.label;
          selectElement.appendChild(option);
        });
        selectElement.value = cameras.some(function (camera) { return camera.id === previousValue; }) ? previousValue : '';
        selectElement.hidden = cameras.length < 2;
      }
      publish(state, state === 'scanning' ? 'Camera ready. Fit the entire barcode in view; capture is automatic.' : '');
    } catch (_) { /* Camera enumeration is optional and does not interrupt scanning. */ }
  }

  async function enableContinuousFocus(instance, token) {
    try {
      const capabilities = instance.getRunningTrackCapabilities();
      if (current(token) && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
        await instance.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (_) { /* Fixed-focus webcams and unsupported browsers remain usable. */ }
  }

  function captured(value, token, instance) {
    const barcode = String(value || '').trim();
    if (!barcode || !current(token) || scanner !== instance || handlingDecode) return;
    handlingDecode = true;
    try { instance.pause(true); } catch (_) {}
    publish('processing', 'Barcode captured. Verifying the record and checking accommodation…');
    // Stop before the async business callback, and suppress repeated video frames.
    const stopped = stopCamera(true);
    const capturedGeneration = generation;
    stopped.then(async function () {
      if (generation !== capturedGeneration || state !== 'processing') {
        handlingDecode = false;
        return;
      }
      try {
        await options.onDecode(barcode);
        handlingDecode = false;
        if (state === 'processing') publish('captured', 'Scan complete. Select Scan Next to scan another barcode.');
      } catch (error) {
        handlingDecode = false;
        publish('error', 'The captured barcode could not be processed. Try scanning it again.', error);
      } finally {
        handlingDecode = false;
      }
    });
  }

  async function runStart(token, selectedDevice) {
    let instance = null;
    try {
      if (stopPromise) await stopPromise;
      if (!current(token)) return false;
      if (window.isSecureContext === false) throw new Error('Camera access requires HTTPS or localhost.');
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('This browser does not provide camera access. Use an updated browser on HTTPS or enter the barcode manually.');
      }
      await ensureLibrary();
      if (!current(token)) return false;
      const reader = document.getElementById(options.elementId);
      if (!reader) throw new Error('The camera preview could not be found. Reload this page.');
      preparePreview(reader);
      const format = window.Html5QrcodeSupportedFormats && window.Html5QrcodeSupportedFormats.CODE_128;
      if (typeof format !== 'number') throw new Error('The barcode reader does not support CODE128. Reload this page.');
      const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
      const targets = selectedDevice
        ? [{ deviceId: { ideal: selectedDevice } }, { facingMode: { ideal: 'environment' } }, { facingMode: { ideal: 'user' } }]
        : [{ facingMode: { ideal: 'environment' } }, { facingMode: { ideal: 'user' } }];
      let lastError = null;
      for (let index = 0; index < targets.length; index += 1) {
        if (!current(token)) return false;
        instance = new window.Html5Qrcode(options.elementId, { formatsToSupport: [format], verbose: false });
        scanner = instance;
        const attempt = instance;
        publish('starting', index ? 'Trying another camera…' : 'Opening camera. Allow access when prompted.');
        try {
          // No qrbox: the full video is decoded, so long issued codes are not cropped.
          // videoConstraints supports ideal values; the library's first argument does not.
          await instance.start(
            { facingMode: 'environment' },
            { fps: 15, disableFlip: false, videoConstraints: Object.assign({}, base, targets[index]) },
            function (decoded) { captured(decoded, token, attempt); },
            function () { /* Frames without a barcode are normal; continue automatically. */ }
          );
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await dispose(instance);
          if (!current(token)) return false;
          if (/NotAllowed|PermissionDenied|denied|SecurityError|NotReadable|in use/i.test(String(error && (error.message || error.name) || error))) throw error;
        }
      }
      if (lastError) throw lastError;
      if (!current(token)) {
        await dispose(instance);
        return false;
      }
      fitPreview();
      publish('scanning', 'Camera ready. Fit the entire barcode in view; capture is automatic.');
      void refreshCameras(token);
      void enableContinuousFocus(instance, token);
      return true;
    } catch (error) {
      if (instance) await dispose(instance);
      if (current(token)) {
        desiredRunning = false;
        const message = error instanceof Error && /HTTPS|browser|barcode reader|Barcode reader|camera preview/i.test(error.message)
          ? error.message : cameraError(error);
        publish('error', message, error);
      }
      return false;
    } finally {
      if (!desiredRunning && !scanner) restorePreview();
    }
  }

  function start(cameraId) {
    if (handlingDecode) return Promise.resolve(false);
    if (desiredRunning && startPromise) return startPromise;
    if (desiredRunning && state === 'scanning') return Promise.resolve(true);
    if (typeof cameraId === 'string') preferredDeviceId = cameraId;
    desiredRunning = true;
    const token = ++generation;
    publish('loading', 'Preparing barcode reader…');
    const pending = runStart(token, preferredDeviceId);
    startPromise = pending;
    pending.finally(function () { if (startPromise === pending) startPromise = null; });
    return pending;
  }

  function stopCamera(keepProcessing) {
    desiredRunning = false;
    generation += 1;
    releaseVisibleTracks();
    if (!keepProcessing) publish('stopping', 'Stopping camera…');
    if (stopPromise) {
      return stopPromise.then(function () {
        if (!desiredRunning && !keepProcessing) publish('idle', 'Camera stopped. Select Start Scanning when ready.');
        return true;
      });
    }
    const pendingStart = startPromise;
    const pending = (async function () {
      if (pendingStart) { try { await pendingStart; } catch (_) {} }
      await dispose(scanner);
      restorePreview();
      if (!desiredRunning && !keepProcessing) publish('idle', 'Camera stopped. Select Start Scanning when ready.');
      return true;
    })();
    stopPromise = pending;
    pending.finally(function () { if (stopPromise === pending) stopPromise = null; });
    return pending;
  }

  function stop() { return stopCamera(false); }
  function toggle() { return desiredRunning ? stop() : start(); }

  async function cameraChanged() {
    preferredDeviceId = selectElement ? selectElement.value : '';
    if (desiredRunning) {
      await stop();
      await start(preferredDeviceId);
    }
  }

  function init(configuration) {
    options = Object.assign({}, options, configuration || {});
    if (selectElement) selectElement.removeEventListener('change', cameraChanged);
    selectElement = document.getElementById(options.cameraSelectId);
    if (selectElement) selectElement.addEventListener('change', cameraChanged);
    return window.ScanSafeScannerCamera;
  }

  window.addEventListener('pagehide', function () { void stop(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) void stop(); });
  window.ScanSafeScannerCamera = {
    init: init,
    start: start,
    stop: stop,
    toggle: toggle,
    ensureLibrary: ensureLibrary,
    inspect: function () { return { state: state, active: desiredRunning, processing: handlingDecode, cameras: cameras.slice(), cameraId: preferredDeviceId }; }
  };
})();
