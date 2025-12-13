/**
 * VAD-Gated Noise Suppression
 * 
 * Uses @jitsi/rnnoise-wasm to filter background noise AND gate non-voice sounds.
 * The key difference from standard RNNoise: we use the VAD (Voice Activity Detection)
 * score to completely silence audio when no voice is detected.
 * 
 * This effectively filters keyboard clicks, mouse clicks, and other impulsive sounds
 * that RNNoise alone would only reduce (not eliminate).
 * 
 * Architecture:
 * - Uses ScriptProcessorNode (deprecated but reliable) for main-thread processing
 * - RNNoise WASM loaded via @jitsi/rnnoise-wasm's proper loader
 * - VAD gating applied based on returned probability score
 */

// Configuration
let vadThreshold = 0.85; // Voice probability threshold (0-1). Higher = more aggressive gating
const HOLD_FRAMES = 10;     // Hold voice state for N frames after VAD drops (prevents choppy speech)
const RNNOISE_SAMPLE_LENGTH = 480; // RNNoise frame size
const SHIFT_16_BIT = 32768;

// Live VAD score for UI display (smoothed)
let currentVadScore = 0;
let smoothedVadScore = 0;
const VAD_SMOOTHING = 0.3; // Lower = smoother

// WASM Module interface
interface RnnoiseModule {
  _rnnoise_create: () => number;
  _rnnoise_destroy: (ctx: number) => void;
  _rnnoise_process_frame: (ctx: number, input: number, output: number) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
}

// State
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;
let originalTrack: MediaStreamTrack | null = null;
let processedTrack: MediaStreamTrack | null = null;
let isActive = false;

// RNNoise state
let rnnoiseModule: RnnoiseModule | null = null;
let rnnoiseContext: number = 0;
let wasmPcmPtr: number = 0;
let wasmPcmF32Index: number = 0;

// Processing state - buffers need to be large enough for ScriptProcessor block size (4096) + RNNoise frame (480)
let inputBuffer: Float32Array = new Float32Array(RNNOISE_SAMPLE_LENGTH * 16); // ~7680 samples
let outputBuffer: Float32Array = new Float32Array(RNNOISE_SAMPLE_LENGTH * 16);
let inputWriteIdx = 0;
let inputReadIdx = 0;
let outputWriteIdx = 0;
let outputReadIdx = 0;
let voiceHoldCounter = 0;
let isVoiceActive = false;

// Debug
let lastLogTime = 0;
let vadScoreSum = 0;
let vadScoreCount = 0;
let silencedFrames = 0;
let passedFrames = 0;

/**
 * Load the RNNoise WASM module using Jitsi's loader.
 */
async function loadRnnoiseModule(): Promise<RnnoiseModule> {
  if (rnnoiseModule) return rnnoiseModule;
  
  // Use the async loader from @jitsi/rnnoise-wasm and force WASM URL resolution.
  // Without locateFile, nested routes like /r/<room> can fetch rnnoise.wasm from the wrong path
  // (e.g., returning index.html with text/html), causing the "magic number" validation error.
  const { createRNNWasmModule } = await import('@jitsi/rnnoise-wasm');
  const wasmUrl = typeof window !== 'undefined'
    ? new URL('/rnnoise.wasm', window.location.origin).toString()
    : 'rnnoise.wasm';
  const createModuleAny = createRNNWasmModule as unknown as (opts: any) => Promise<RnnoiseModule>;
  rnnoiseModule = await createModuleAny({
    locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path)
  });
  return rnnoiseModule;
}

/**
 * Initialize RNNoise context and buffers.
 */
function initRnnoiseContext(module: RnnoiseModule): void {
  // Allocate buffer in WASM heap
  wasmPcmPtr = module._malloc(RNNOISE_SAMPLE_LENGTH * 4); // Float32 = 4 bytes
  wasmPcmF32Index = wasmPcmPtr >> 2; // Divide by 4 for Float32 index
  
  // Create RNNoise context
  rnnoiseContext = module._rnnoise_create();
  
  console.log('[VAD] RNNoise context created:', rnnoiseContext, 'buffer:', wasmPcmPtr);
}

/**
 * Process a single RNNoise frame and return VAD score.
 */
function processRnnoiseFrame(frame: Float32Array): number {
  if (!rnnoiseModule || !rnnoiseContext) return 0;
  
  // Copy to WASM heap, scaling to 16-bit range
  for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
    rnnoiseModule.HEAPF32[wasmPcmF32Index + i] = frame[i] * SHIFT_16_BIT;
  }
  
  // Process and get VAD score
  const vadScore = rnnoiseModule._rnnoise_process_frame(
    rnnoiseContext,
    wasmPcmPtr,
    wasmPcmPtr
  );
  
  // Copy back denoised audio
  for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
    frame[i] = rnnoiseModule.HEAPF32[wasmPcmF32Index + i] / SHIFT_16_BIT;
  }
  
  return vadScore;
}

/**
 * Get available samples in circular buffer.
 */
function getAvailable(writeIdx: number, readIdx: number, bufferLen: number): number {
  if (writeIdx >= readIdx) {
    return writeIdx - readIdx;
  }
  return bufferLen - readIdx + writeIdx;
}

/**
 * Audio processing callback.
 */
function processAudio(event: AudioProcessingEvent): void {
  const input = event.inputBuffer.getChannelData(0);
  const output = event.outputBuffer.getChannelData(0);
  
  // Write all input samples to buffer
  for (let i = 0; i < input.length; i++) {
    inputBuffer[inputWriteIdx] = input[i];
    inputWriteIdx = (inputWriteIdx + 1) % inputBuffer.length;
  }
  
  // Process ALL complete 480-sample frames
  while (getAvailable(inputWriteIdx, inputReadIdx, inputBuffer.length) >= RNNOISE_SAMPLE_LENGTH) {
    // Extract frame
    const frame = new Float32Array(RNNOISE_SAMPLE_LENGTH);
    for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
      frame[i] = inputBuffer[(inputReadIdx + i) % inputBuffer.length];
    }
    inputReadIdx = (inputReadIdx + RNNOISE_SAMPLE_LENGTH) % inputBuffer.length;
    
    // Process with RNNoise
    const vadScore = processRnnoiseFrame(frame);
    
    // Update live VAD score (smoothed for UI)
    currentVadScore = vadScore;
    smoothedVadScore = smoothedVadScore * (1 - VAD_SMOOTHING) + vadScore * VAD_SMOOTHING;
    
    // VAD gating
    if (vadScore >= vadThreshold) {
      isVoiceActive = true;
      voiceHoldCounter = HOLD_FRAMES;
      passedFrames++;
    } else if (voiceHoldCounter > 0) {
      voiceHoldCounter--;
      passedFrames++;
    } else {
      isVoiceActive = false;
      silencedFrames++;
    }
    
    // Track VAD scores for debug
    vadScoreSum += vadScore;
    vadScoreCount++;
    
    // Write to output buffer (denoised audio if voice, silence otherwise)
    for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
      outputBuffer[outputWriteIdx] = isVoiceActive ? frame[i] : 0;
      outputWriteIdx = (outputWriteIdx + 1) % outputBuffer.length;
    }
  }
  
  // Read from output buffer to fill output
  const outAvailable = getAvailable(outputWriteIdx, outputReadIdx, outputBuffer.length);
  
  if (outAvailable >= output.length) {
    for (let i = 0; i < output.length; i++) {
      output[i] = outputBuffer[outputReadIdx];
      outputReadIdx = (outputReadIdx + 1) % outputBuffer.length;
    }
  } else {
    // Not enough data - output silence (shouldn't happen in steady state)
    output.fill(0);
  }
  
  // Debug log every second
  const now = performance.now() / 1000;
  if (now - lastLogTime >= 1.0) {
    const avgVad = vadScoreCount > 0 ? (vadScoreSum / vadScoreCount).toFixed(3) : 'N/A';
    console.log('[VAD Debug] avgVAD:', avgVad, 
      '| silenced:', silencedFrames, 
      '| passed:', passedFrames,
      '| threshold:', vadThreshold,
      '| outBuffer:', outAvailable);
    vadScoreSum = 0;
    vadScoreCount = 0;
    silencedFrames = 0;
    passedFrames = 0;
    lastLogTime = now;
  }
}

/**
 * Start VAD-gated noise suppression on an audio track.
 */
export async function startVadNoiseSuppression(
  track: MediaStreamTrack
): Promise<MediaStreamTrack> {
  await stopVadNoiseSuppression();
  originalTrack = track;
  
  try {
    // Load RNNoise
    console.log('[VAD] Loading RNNoise WASM...');
    const module = await loadRnnoiseModule();
    initRnnoiseContext(module);
    console.log('[VAD] RNNoise ready');
    
    // Create AudioContext
    audioContext = new AudioContext();
    console.log('[VAD] AudioContext sample rate:', audioContext.sampleRate);
    
    // Create nodes
    const stream = new MediaStream([track]);
    sourceNode = audioContext.createMediaStreamSource(stream);
    
    // Use ScriptProcessorNode (deprecated but works everywhere)
    // Buffer size 1024 (~21ms at 48kHz) for low latency voice chat
    scriptNode = audioContext.createScriptProcessor(1024, 1, 1);
    scriptNode.onaudioprocess = processAudio;
    
    destinationNode = audioContext.createMediaStreamDestination();
    
    // Connect: source -> script -> destination
    sourceNode.connect(scriptNode);
    scriptNode.connect(destinationNode);
    
    // Reset buffers
    inputBuffer.fill(0);
    outputBuffer.fill(0);
    inputWriteIdx = 0;
    inputReadIdx = 0;
    outputWriteIdx = 0;
    outputReadIdx = 0;
    voiceHoldCounter = 0;
    isVoiceActive = false;
    lastLogTime = performance.now() / 1000;
    
    processedTrack = destinationNode.stream.getAudioTracks()[0];
    isActive = true;
    
    console.log('[VAD] Noise suppression active with VAD gating');
    return processedTrack;
    
  } catch (error) {
    console.error('[VAD] Failed to start:', error);
    await stopVadNoiseSuppression();
    return track;
  }
}

/**
 * Stop VAD noise suppression and clean up resources.
 */
export async function stopVadNoiseSuppression(): Promise<MediaStreamTrack | null> {
  const rawTrack = originalTrack;
  
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  
  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode.onaudioprocess = null;
    scriptNode = null;
  }
  
  if (destinationNode) {
    destinationNode.disconnect();
    destinationNode = null;
  }
  
  if (audioContext) {
    try {
      await audioContext.close();
    } catch (e) {
      console.error('[VAD] Error closing AudioContext:', e);
    }
    audioContext = null;
  }
  
  // Clean up RNNoise
  if (rnnoiseModule && rnnoiseContext) {
    try {
      rnnoiseModule._rnnoise_destroy(rnnoiseContext);
      if (wasmPcmPtr) {
        rnnoiseModule._free(wasmPcmPtr);
      }
    } catch (e) {
      console.error('[VAD] Error cleaning up RNNoise:', e);
    }
    rnnoiseContext = 0;
    wasmPcmPtr = 0;
  }
  
  originalTrack = null;
  processedTrack = null;
  isActive = false;
  
  return rawTrack;
}

/**
 * Check if VAD noise suppression is currently active.
 */
export function isVadNoiseSuppressionActive(): boolean {
  return isActive;
}

/**
 * Get the processed track.
 */
export function getVadProcessedTrack(): MediaStreamTrack | null {
  return processedTrack;
}

/**
 * Get the original (raw) track.
 */
export function getVadOriginalTrack(): MediaStreamTrack | null {
  return originalTrack;
}

/**
 * Get the current (smoothed) VAD score for UI display.
 * Returns 0-1 where higher = more likely voice.
 */
export function getVadScore(): number {
  return smoothedVadScore;
}

/**
 * Get the raw (unsmoothed) VAD score.
 */
export function getRawVadScore(): number {
  return currentVadScore;
}

/**
 * Get the current VAD threshold.
 */
export function getVadThreshold(): number {
  return vadThreshold;
}

/**
 * Set the VAD threshold (0-1).
 * Higher = more aggressive filtering (requires clearer voice to pass).
 */
export function setVadThreshold(threshold: number): void {
  vadThreshold = Math.max(0, Math.min(1, threshold));
  console.log('[VAD] Threshold set to:', vadThreshold);
}
