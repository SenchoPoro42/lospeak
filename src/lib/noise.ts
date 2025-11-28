/**
 * Noise Suppression Module
 * 
 * Uses RNNoise WASM to filter out background noise like keyboard clicks,
 * fans, and ambient sounds in real-time.
 * 
 * Two implementations for cross-browser support:
 * - Chrome/Edge: @shiguredo/noise-suppression (Insertable Streams - fastest)
 * - Firefox: @sapphi-red/web-noise-suppressor (AudioWorklet fallback)
 * 
 * How it works:
 * 1. Takes your raw microphone MediaStreamTrack
 * 2. Passes audio through RNNoise ML model in real-time (~13ms latency)
 * 3. Returns a new "clean" track to send to peers
 */

import { NoiseSuppressionProcessor } from '@shiguredo/noise-suppression';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
// @ts-ignore - Vite URL import for worklet
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
// @ts-ignore - Vite URL import for WASM
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';

// === Browser Detection ===

/**
 * Check if browser supports Insertable Streams (Chrome/Edge).
 * This is the faster method.
 */
function supportsInsertableStreams(): boolean {
  return typeof MediaStreamTrackProcessor !== 'undefined' &&
         typeof MediaStreamTrackGenerator !== 'undefined';
}

/**
 * Check if browser supports AudioWorklet (Firefox, Safari, Chrome).
 * This is the fallback method.
 */
function supportsAudioWorklet(): boolean {
  return typeof AudioWorkletNode !== 'undefined';
}

/**
 * Check if any noise suppression method is supported.
 */
export function isNoiseSuppressionSupported(): boolean {
  return supportsInsertableStreams() || supportsAudioWorklet();
}

// === Insertable Streams Implementation (Chrome/Edge) ===

const SHIGUREDO_ASSETS = 'https://cdn.jsdelivr.net/npm/@shiguredo/noise-suppression@latest/dist';
let shiguredoProcessor: NoiseSuppressionProcessor | null = null;

// === AudioWorklet Implementation (Firefox) ===

let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let rnnoiseNode: RnnoiseWorkletNode | null = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;

// === Shared State ===

let originalTrack: MediaStreamTrack | null = null;
let processedTrack: MediaStreamTrack | null = null;
let activeMethod: 'insertable' | 'worklet' | null = null;

/**
 * Initialize and start noise suppression on an audio track.
 * Automatically selects the best method for the current browser.
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

  // Try Insertable Streams first (Chrome/Edge - fastest)
  if (supportsInsertableStreams()) {
    try {
      console.log('[Noise] Using Insertable Streams (Chrome/Edge)');
      shiguredoProcessor = new NoiseSuppressionProcessor(SHIGUREDO_ASSETS);
      processedTrack = await shiguredoProcessor.startProcessing(track);
      activeMethod = 'insertable';
      console.log('[Noise] Suppression active (Insertable Streams)');
      return processedTrack;
    } catch (error) {
      console.error('[Noise] Insertable Streams failed:', error);
      // Fall through to AudioWorklet
    }
  }

  // Fallback to AudioWorklet (Firefox)
  if (supportsAudioWorklet()) {
    try {
      console.log('[Noise] Using AudioWorklet (Firefox)');
      processedTrack = await startWorkletNoiseSuppression(track);
      activeMethod = 'worklet';
      console.log('[Noise] Suppression active (AudioWorklet)');
      return processedTrack;
    } catch (error) {
      console.error('[Noise] AudioWorklet failed:', error);
    }
  }

  console.warn('[Noise] No suppression method available');
  return track;
}

/**
 * AudioWorklet-based noise suppression for Firefox.
 * Routes audio through: Mic → AudioContext → RNNoise Worklet → Output Track
 */
async function startWorkletNoiseSuppression(
  track: MediaStreamTrack
): Promise<MediaStreamTrack> {
  // Create AudioContext (sample rate should match RNNoise expectation)
  audioContext = new AudioContext({ sampleRate: 48000 });
  
  // Load RNNoise WASM binary
  const wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath });
  
  // Register the worklet processor
  await audioContext.audioWorklet.addModule(rnnoiseWorkletPath);
  
  // Create source from microphone track
  const stream = new MediaStream([track]);
  sourceNode = audioContext.createMediaStreamSource(stream);
  
  // Create RNNoise worklet node
  rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
    wasmBinary,
    maxChannels: 1 // Mono for voice
  });
  
  // Create destination to get output track
  destinationNode = audioContext.createMediaStreamDestination();
  
  // Connect the audio graph: source → rnnoise → destination
  sourceNode.connect(rnnoiseNode);
  rnnoiseNode.connect(destinationNode);
  
  // Return the processed track
  return destinationNode.stream.getAudioTracks()[0];
}

/**
 * Stop noise suppression and clean up all resources.
 */
export async function stopNoiseSuppression(): Promise<MediaStreamTrack | null> {
  const rawTrack = originalTrack;

  // Clean up Insertable Streams processor
  if (shiguredoProcessor) {
    try {
      shiguredoProcessor.stopProcessing();
    } catch (e) {
      console.error('[Noise] Error stopping Shiguredo:', e);
    }
    shiguredoProcessor = null;
  }

  // Clean up AudioWorklet nodes
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
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
 * Get the active method ('insertable' | 'worklet' | null).
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
