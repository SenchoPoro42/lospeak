/**
 * Noise Suppression Module
 * 
 * Uses @shiguredo/noise-suppression (RNNoise WASM) to filter out
 * background noise like keyboard clicks, fans, and ambient sounds.
 * 
 * How it works:
 * 1. Takes your raw microphone MediaStreamTrack
 * 2. Passes audio through RNNoise ML model in real-time
 * 3. Returns a new "clean" track to send to peers
 * 
 * Note: Uses MediaStreamTrack Insertable Streams (Breakout Box),
 * so only works on Chromium-based browsers (Chrome, Edge).
 */

import { NoiseSuppressionProcessor } from '@shiguredo/noise-suppression';

// CDN path for WASM files - loaded on-demand
const ASSETS_PATH = 'https://cdn.jsdelivr.net/npm/@shiguredo/noise-suppression@latest/dist';

// Singleton processor instance
let processor: NoiseSuppressionProcessor | null = null;

// Track the original (raw) and processed tracks
let originalTrack: MediaStreamTrack | null = null;
let processedTrack: MediaStreamTrack | null = null;

/**
 * Check if noise suppression is supported in this browser.
 * Requires MediaStreamTrack Insertable Streams (Chromium 94+).
 */
export function isNoiseSuppressionSupported(): boolean {
  // Check for Insertable Streams support
  return typeof MediaStreamTrackProcessor !== 'undefined' &&
         typeof MediaStreamTrackGenerator !== 'undefined';
}

/**
 * Initialize and start noise suppression on an audio track.
 * 
 * @param track - The raw microphone MediaStreamTrack
 * @returns The noise-suppressed track (or original if unsupported)
 */
export async function startNoiseSuppression(
  track: MediaStreamTrack
): Promise<MediaStreamTrack> {
  // If not supported, return original track
  if (!isNoiseSuppressionSupported()) {
    console.warn('[Noise] Suppression not supported in this browser');
    return track;
  }

  try {
    // Stop any existing processing
    await stopNoiseSuppression();

    // Create new processor
    processor = new NoiseSuppressionProcessor(ASSETS_PATH);
    originalTrack = track;

    // Start processing - returns a new "clean" track
    console.log('[Noise] Starting suppression...');
    processedTrack = await processor.startProcessing(track);
    console.log('[Noise] Suppression active');

    return processedTrack;
  } catch (error) {
    console.error('[Noise] Failed to start suppression:', error);
    // Fall back to original track
    return track;
  }
}

/**
 * Stop noise suppression and clean up resources.
 * Returns the original (raw) track if available.
 */
export async function stopNoiseSuppression(): Promise<MediaStreamTrack | null> {
  if (processor) {
    try {
      console.log('[Noise] Stopping suppression...');
      processor.stopProcessing();
    } catch (error) {
      console.error('[Noise] Error stopping:', error);
    }
    processor = null;
  }

  const rawTrack = originalTrack;
  processedTrack = null;
  originalTrack = null;

  return rawTrack;
}

/**
 * Check if noise suppression is currently active.
 */
export function isNoiseSuppressionActive(): boolean {
  return processor !== null && processedTrack !== null;
}

/**
 * Get the current track (processed if active, or null).
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
