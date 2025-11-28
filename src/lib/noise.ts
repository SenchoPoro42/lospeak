/**
 * Noise Suppression Module
 * 
 * Uses RNNoise WASM with VAD (Voice Activity Detection) gating to filter
 * keyboard clicks, mouse clicks, fans, and other background sounds.
 * 
 * The key innovation: we use RNNoise's VAD score to GATE audio:
 * - If VAD score < 85% (not voice), output SILENCE
 * - If VAD score >= 85% (voice detected), output denoised audio
 * 
 * This completely eliminates keyboard clicks when not speaking,
 * rather than just reducing their volume.
 * 
 * Fallback chain:
 * 1. VAD-gated RNNoise (primary - best for keyboard filtering)
 * 2. Insertable Streams (Chrome/Edge - if VAD fails)
 * 3. AudioWorklet (Firefox - if VAD fails)
 */

import {
  startVadNoiseSuppression,
  stopVadNoiseSuppression,
  isVadNoiseSuppressionActive,
  getVadProcessedTrack,
  getVadOriginalTrack,
  getVadScore,
  getRawVadScore,
  getVadThreshold,
  setVadThreshold
} from './vad-noise';

// Re-export VAD controls for UI
export { getVadScore, getRawVadScore, getVadThreshold, setVadThreshold };

// Dynamic imports to avoid SSR issues - these only load on client
let NoiseSuppressionProcessor: any = null;
let RnnoiseWorkletNode: any = null;
let NoiseGateWorkletNode: any = null;
let loadRnnoise: any = null;
let rnnoiseWorkletPath: string = '';
let rnnoiseWasmPath: string = '';
let noiseGateWorkletPath: string = '';

// Load fallback modules dynamically (client-side only)
async function ensureFallbackModulesLoaded(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  
  if (!NoiseSuppressionProcessor) {
    try {
      const shiguredo = await import('@shiguredo/noise-suppression');
      NoiseSuppressionProcessor = shiguredo.NoiseSuppressionProcessor;
    } catch (e) {
      console.warn('[Noise] Could not load @shiguredo/noise-suppression');
    }
  }
  
  if (!RnnoiseWorkletNode) {
    try {
      const suppressor = await import('@sapphi-red/web-noise-suppressor');
      RnnoiseWorkletNode = suppressor.RnnoiseWorkletNode;
      NoiseGateWorkletNode = suppressor.NoiseGateWorkletNode;
      loadRnnoise = suppressor.loadRnnoise;
      
      // Dynamic URL imports for Vite
      const workletModule = await import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url');
      const wasmModule = await import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url');
      const gateModule = await import('@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url');
      rnnoiseWorkletPath = workletModule.default;
      rnnoiseWasmPath = wasmModule.default;
      noiseGateWorkletPath = gateModule.default;
    } catch (e) {
      console.warn('[Noise] Could not load @sapphi-red/web-noise-suppressor');
    }
  }
  
  return true;
}

// === Browser Detection ===

/**
 * Check if browser supports Insertable Streams (Chrome/Edge).
 * These are Chrome-specific APIs not in standard TypeScript lib.
 */
function supportsInsertableStreams(): boolean {
  return 'MediaStreamTrackProcessor' in globalThis &&
         'MediaStreamTrackGenerator' in globalThis;
}

/**
 * Check if browser supports AudioWorklet.
 */
function supportsAudioWorklet(): boolean {
  return typeof AudioWorkletNode !== 'undefined';
}

/**
 * Check if any noise suppression method is supported.
 */
export function isNoiseSuppressionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return supportsAudioWorklet(); // VAD approach uses AudioWorklet
}

// === Fallback Implementation State ===

const SHIGUREDO_ASSETS = 'https://cdn.jsdelivr.net/npm/@shiguredo/noise-suppression@latest/dist';
let shiguredoProcessor: any = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let noiseGateNode: any = null;
let rnnoiseNode: any = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;

// === Shared State ===

let originalTrack: MediaStreamTrack | null = null;
let processedTrack: MediaStreamTrack | null = null;
let activeMethod: 'vad' | 'insertable' | 'worklet' | null = null;

/**
 * Initialize and start noise suppression on an audio track.
 * Uses VAD-gated RNNoise for best keyboard filtering, with fallbacks.
 * 
 * @param track - The raw microphone MediaStreamTrack
 * @returns The noise-suppressed track (or original if unsupported)
 */
export async function startNoiseSuppression(
  track: MediaStreamTrack
): Promise<MediaStreamTrack> {
  // Stop any existing processing first
  await stopNoiseSuppression();
  originalTrack = track;

  // Try VAD-gated RNNoise first (best for keyboard filtering)
  if (supportsAudioWorklet()) {
    try {
      console.log('[Noise] Using VAD-gated RNNoise...');
      processedTrack = await startVadNoiseSuppression(track);
      activeMethod = 'vad';
      console.log('[Noise] VAD noise suppression active');
      return processedTrack;
    } catch (error) {
      console.error('[Noise] VAD approach failed:', error);
      // Fall through to legacy methods
    }
  }

  // Load fallback modules
  await ensureFallbackModulesLoaded();

  // Fallback: Insertable Streams (Chrome/Edge)
  if (supportsInsertableStreams() && NoiseSuppressionProcessor) {
    try {
      console.log('[Noise] Falling back to Insertable Streams (Chrome/Edge)');
      shiguredoProcessor = new NoiseSuppressionProcessor(SHIGUREDO_ASSETS);
      processedTrack = await shiguredoProcessor.startProcessing(track);
      activeMethod = 'insertable';
      console.log('[Noise] Suppression active (Insertable Streams)');
      return processedTrack!;
    } catch (error) {
      console.error('[Noise] Insertable Streams failed:', error);
    }
  }

  // Fallback: AudioWorklet (Firefox)
  if (supportsAudioWorklet() && RnnoiseWorkletNode && loadRnnoise) {
    try {
      console.log('[Noise] Falling back to AudioWorklet');
      processedTrack = await startFallbackWorkletSuppression(track);
      activeMethod = 'worklet';
      console.log('[Noise] Suppression active (AudioWorklet fallback)');
      return processedTrack;
    } catch (error) {
      console.error('[Noise] AudioWorklet failed:', error);
    }
  }

  console.warn('[Noise] No suppression method available');
  return track;
}

/**
 * Fallback AudioWorklet-based noise suppression.
 * Routes audio through: Mic → NoiseGate → RNNoise → Output Track
 */
async function startFallbackWorkletSuppression(
  track: MediaStreamTrack
): Promise<MediaStreamTrack> {
  audioContext = new AudioContext({ sampleRate: 48000 });
  
  const wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath });
  
  await audioContext.audioWorklet.addModule(noiseGateWorkletPath);
  await audioContext.audioWorklet.addModule(rnnoiseWorkletPath);
  
  const stream = new MediaStream([track]);
  sourceNode = audioContext.createMediaStreamSource(stream);
  
  noiseGateNode = new NoiseGateWorkletNode(audioContext, {
    openThreshold: -30,
    closeThreshold: -35,
    holdMs: 100,
    maxChannels: 1
  });
  
  rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
    wasmBinary,
    maxChannels: 1
  });
  
  destinationNode = audioContext.createMediaStreamDestination();
  
  sourceNode.connect(noiseGateNode);
  noiseGateNode.connect(rnnoiseNode);
  rnnoiseNode.connect(destinationNode);
  
  return destinationNode.stream.getAudioTracks()[0];
}

/**
 * Stop noise suppression and clean up all resources.
 */
export async function stopNoiseSuppression(): Promise<MediaStreamTrack | null> {
  const rawTrack = originalTrack;

  // Clean up VAD noise suppression
  if (activeMethod === 'vad') {
    await stopVadNoiseSuppression();
  }

  // Clean up Insertable Streams processor
  if (shiguredoProcessor) {
    try {
      shiguredoProcessor.stopProcessing();
    } catch (e) {
      console.error('[Noise] Error stopping Shiguredo:', e);
    }
    shiguredoProcessor = null;
  }

  // Clean up fallback AudioWorklet nodes
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (noiseGateNode) {
    noiseGateNode.disconnect();
    noiseGateNode = null;
  }
  if (rnnoiseNode) {
    rnnoiseNode.disconnect();
    rnnoiseNode = null;
  }
  if (destinationNode) {
    destinationNode.disconnect();
    destinationNode = null;
  }
  if (audioContext) {
    try {
      await audioContext.close();
    } catch (e) {
      console.error('[Noise] Error closing AudioContext:', e);
    }
    audioContext = null;
  }

  // Reset state
  originalTrack = null;
  processedTrack = null;
  activeMethod = null;

  return rawTrack;
}

/**
 * Check if noise suppression is currently active.
 */
export function isNoiseSuppressionActive(): boolean {
  return activeMethod !== null && processedTrack !== null;
}

/**
 * Get the active method ('vad' | 'insertable' | 'worklet' | null).
 */
export function getActiveMethod(): string | null {
  return activeMethod;
}

/**
 * Get the processed track (or null if not active).
 */
export function getProcessedTrack(): MediaStreamTrack | null {
  return processedTrack;
}

/**
 * Get the original (raw) track.
 */
export function getOriginalTrack(): MediaStreamTrack | null {
  return originalTrack;
}
