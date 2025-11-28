/**
 * VAD-Gated Noise Suppression
 * 
 * Uses RNNoise WASM to filter background noise AND gate non-voice sounds.
 * The key difference from standard RNNoise: we use the VAD (Voice Activity Detection)
 * score to completely silence audio when no voice is detected.
 * 
 * This effectively filters keyboard clicks, mouse clicks, and other impulsive sounds
 * that RNNoise alone would only reduce (not eliminate).
 * 
 * How it works:
 * 1. RNNoise processes each 480-sample frame (~10ms at 48kHz)
 * 2. It returns both denoised audio AND a VAD probability (0.0 - 1.0)
 * 3. If VAD < threshold (e.g., 0.85), we output silence instead of denoised audio
 * 4. If VAD >= threshold, we output the denoised audio
 * 
 * Architecture:
 * - Main thread: loads WASM binary, sends to worklet
 * - Worklet: compiles WASM, runs RNNoise processing with VAD gating
 */

// Configuration
const VAD_THRESHOLD = 0.85; // Voice probability threshold (0-1). Higher = more aggressive gating
const HOLD_FRAMES = 10;     // Hold voice state for N frames after VAD drops (prevents choppy speech)

// State
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;
let originalTrack: MediaStreamTrack | null = null;
let processedTrack: MediaStreamTrack | null = null;
let isActive = false;

/**
 * AudioWorklet processor code as a string.
 * This gets converted to a blob URL for loading.
 * 
 * The processor handles:
 * - Compiling WASM from binary received via message
 * - Buffering input samples (AudioWorklet uses 128-sample blocks, RNNoise needs 480)
 * - Calling RNNoise to denoise and get VAD score
 * - Gating output based on VAD threshold
 * - Smooth hold/release to prevent choppy speech
 */
function getWorkletCode(): string {
  return `
// RNNoise constants
const RNNOISE_SAMPLE_LENGTH = 480;
const RNNOISE_BUFFER_SIZE = RNNOISE_SAMPLE_LENGTH * 4; // Float32 = 4 bytes
const SHIFT_16_BIT_NR = 32768;

// Minimal Emscripten-like environment for RNNoise WASM
function createRnnoiseEnv(memory) {
  const HEAP8 = new Int8Array(memory.buffer);
  const HEAPU8 = new Uint8Array(memory.buffer);
  const HEAP16 = new Int16Array(memory.buffer);
  const HEAP32 = new Int32Array(memory.buffer);
  const HEAPF32 = new Float32Array(memory.buffer);
  const HEAPF64 = new Float64Array(memory.buffer);
  
  return {
    memory,
    HEAP8, HEAPU8, HEAP16, HEAP32, HEAPF32, HEAPF64,
    
    // Memory management (simple bump allocator)
    _heapPtr: 65536, // Start after reserved space
    
    malloc(size) {
      const ptr = this._heapPtr;
      this._heapPtr += size + (8 - (size % 8)); // Align to 8 bytes
      return ptr;
    },
    
    free(ptr) {
      // Simple allocator doesn't free
    }
  };
}

class VadNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // Configuration from options
    this.vadThreshold = options.processorOptions?.vadThreshold ?? 0.85;
    this.holdFrames = options.processorOptions?.holdFrames ?? 10;
    
    // RNNoise state (initialized via message)
    this.wasmInstance = null;
    this.wasmEnv = null;
    this.rnnoiseContext = 0;
    this.wasmPcmInput = 0;
    this.wasmPcmInputF32Index = 0;
    this.initialized = false;
    
    // Circular buffer for sample rate conversion (128 -> 480)
    // Use larger buffer to handle timing variations
    this.inputBuffer = new Float32Array(RNNOISE_SAMPLE_LENGTH * 4);
    this.outputBuffer = new Float32Array(RNNOISE_SAMPLE_LENGTH * 4);
    this.inputWriteIdx = 0;
    this.inputReadIdx = 0;
    this.outputWriteIdx = 0;
    this.outputReadIdx = 0;
    
    // VAD state
    this.voiceHoldCounter = 0;
    this.isVoiceActive = false;
    
    // Handle initialization message from main thread
    this.port.onmessage = async (event) => {
      if (event.data.type === 'init') {
        await this.initRnnoise(event.data.wasmBinary);
      }
    };
  }
  
  async initRnnoise(wasmBinary) {
    try {
      // Create memory (16MB should be plenty for RNNoise)
      const memory = new WebAssembly.Memory({ initial: 256, maximum: 256 }); // 16MB
      
      // Create environment
      this.wasmEnv = createRnnoiseEnv(memory);
      
      // Compile and instantiate WASM
      const importObject = {
        env: {
          memory: memory,
          // RNNoise doesn't need many imports, but add stubs for safety
          emscripten_memcpy_js: (dest, src, num) => {
            this.wasmEnv.HEAPU8.copyWithin(dest, src, src + num);
          },
          __assert_fail: () => { throw new Error('Assertion failed'); },
          abort: () => { throw new Error('Abort'); },
        },
        wasi_snapshot_preview1: {
          fd_close: () => 0,
          fd_seek: () => 0,
          fd_write: () => 0,
        }
      };
      
      const result = await WebAssembly.instantiate(wasmBinary, importObject);
      this.wasmInstance = result.instance;
      
      // Get exports
      const exports = this.wasmInstance.exports;
      
      // If the WASM has its own memory, use that instead
      if (exports.memory) {
        this.wasmEnv = createRnnoiseEnv(exports.memory);
      }
      
      // Allocate buffers
      if (exports._malloc) {
        this.wasmPcmInput = exports._malloc(RNNOISE_BUFFER_SIZE);
      } else {
        this.wasmPcmInput = this.wasmEnv.malloc(RNNOISE_BUFFER_SIZE);
      }
      this.wasmPcmInputF32Index = this.wasmPcmInput >> 2;
      
      // Create RNNoise context
      if (exports._rnnoise_create) {
        this.rnnoiseContext = exports._rnnoise_create();
      } else if (exports.rnnoise_create) {
        this.rnnoiseContext = exports.rnnoise_create();
      }
      
      this.initialized = true;
      this.port.postMessage({ type: 'initialized' });
      
    } catch (error) {
      this.port.postMessage({ type: 'error', error: error.message });
    }
  }
  
  processRnnoiseFrame(frame) {
    if (!this.initialized || !this.wasmInstance) return 0;
    
    const exports = this.wasmInstance.exports;
    const HEAPF32 = this.wasmEnv.HEAPF32;
    
    // Copy input to WASM heap, converting to 16-bit range
    for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
      HEAPF32[this.wasmPcmInputF32Index + i] = frame[i] * SHIFT_16_BIT_NR;
    }
    
    // Process frame - returns VAD score (0-1), denoises in place
    let vadScore = 0;
    if (exports._rnnoise_process_frame) {
      vadScore = exports._rnnoise_process_frame(
        this.rnnoiseContext,
        this.wasmPcmInput,
        this.wasmPcmInput
      );
    } else if (exports.rnnoise_process_frame) {
      vadScore = exports.rnnoise_process_frame(
        this.rnnoiseContext,
        this.wasmPcmInput,
        this.wasmPcmInput
      );
    }
    
    // Copy denoised output back, converting from 16-bit range
    for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
      frame[i] = HEAPF32[this.wasmPcmInputF32Index + i] / SHIFT_16_BIT_NR;
    }
    
    return vadScore;
  }
  
  getAvailableInput() {
    if (this.inputWriteIdx >= this.inputReadIdx) {
      return this.inputWriteIdx - this.inputReadIdx;
    }
    return this.inputBuffer.length - this.inputReadIdx + this.inputWriteIdx;
  }
  
  getAvailableOutput() {
    if (this.outputWriteIdx >= this.outputReadIdx) {
      return this.outputWriteIdx - this.outputReadIdx;
    }
    return this.outputBuffer.length - this.outputReadIdx + this.outputWriteIdx;
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    
    if (!input || !output) {
      return true;
    }
    
    // Pass through if not initialized
    if (!this.initialized) {
      output.set(input);
      return true;
    }
    
    // Write input samples to circular buffer
    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputWriteIdx] = input[i];
      this.inputWriteIdx = (this.inputWriteIdx + 1) % this.inputBuffer.length;
    }
    
    // Process complete frames when we have enough input
    while (this.getAvailableInput() >= RNNOISE_SAMPLE_LENGTH) {
      // Extract frame from circular buffer
      const frame = new Float32Array(RNNOISE_SAMPLE_LENGTH);
      for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
        frame[i] = this.inputBuffer[(this.inputReadIdx + i) % this.inputBuffer.length];
      }
      this.inputReadIdx = (this.inputReadIdx + RNNOISE_SAMPLE_LENGTH) % this.inputBuffer.length;
      
      // Process with RNNoise and get VAD score
      const vadScore = this.processRnnoiseFrame(frame);
      
      // VAD gating with hold
      if (vadScore >= this.vadThreshold) {
        this.isVoiceActive = true;
        this.voiceHoldCounter = this.holdFrames;
      } else if (this.voiceHoldCounter > 0) {
        this.voiceHoldCounter--;
      } else {
        this.isVoiceActive = false;
      }
      
      // Write to output buffer (silence if not voice)
      for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
        this.outputBuffer[this.outputWriteIdx] = this.isVoiceActive ? frame[i] : 0;
        this.outputWriteIdx = (this.outputWriteIdx + 1) % this.outputBuffer.length;
      }
    }
    
    // Read from output buffer
    const available = this.getAvailableOutput();
    if (available >= output.length) {
      for (let i = 0; i < output.length; i++) {
        output[i] = this.outputBuffer[this.outputReadIdx];
        this.outputReadIdx = (this.outputReadIdx + 1) % this.outputBuffer.length;
      }
    } else {
      // Not enough processed data, output silence to avoid glitches
      output.fill(0);
    }
    
    return true;
  }
}

registerProcessor('vad-noise-processor', VadNoiseProcessor);
`;
}

// WASM URL loaded dynamically to support Vite bundling
let wasmUrlCache: string | null = null;

/**
 * Get the WASM URL using Vite's ?url import.
 */
async function getWasmUrl(): Promise<string> {
  if (wasmUrlCache) return wasmUrlCache;
  
  // Use dynamic import with ?url for Vite compatibility
  const wasmModule = await import('@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url');
  wasmUrlCache = wasmModule.default;
  return wasmUrlCache;
}

/**
 * Fetch the RNNoise WASM binary.
 */
async function fetchWasmBinary(): Promise<ArrayBuffer> {
  const wasmUrl = await getWasmUrl();
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM: ${response.status}`);
  }
  return response.arrayBuffer();
}

/**
 * Start VAD-gated noise suppression on an audio track.
 * 
 * @param track - Raw microphone track
 * @returns Processed track with noise suppression and VAD gating
 */
export async function startVadNoiseSuppression(
  track: MediaStreamTrack
): Promise<MediaStreamTrack> {
  // Clean up any existing session
  await stopVadNoiseSuppression();
  
  originalTrack = track;
  
  try {
    // Load RNNoise WASM binary
    console.log('[VAD] Loading RNNoise WASM binary...');
    const wasmBinary = await fetchWasmBinary();
    console.log('[VAD] WASM binary loaded:', wasmBinary.byteLength, 'bytes');
    
    // Create AudioContext at 48kHz (RNNoise optimal sample rate)
    audioContext = new AudioContext({ sampleRate: 48000 });
    
    // Create worklet from blob URL
    const workletCode = getWorkletCode();
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    
    await audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    console.log('[VAD] Worklet registered');
    
    // Create audio nodes
    const stream = new MediaStream([track]);
    sourceNode = audioContext.createMediaStreamSource(stream);
    
    workletNode = new AudioWorkletNode(audioContext, 'vad-noise-processor', {
      processorOptions: {
        vadThreshold: VAD_THRESHOLD,
        holdFrames: HOLD_FRAMES
      }
    });
    
    destinationNode = audioContext.createMediaStreamDestination();
    
    // Wait for worklet initialization
    const initPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worklet init timeout')), 10000);
      
      workletNode!.port.onmessage = (event) => {
        if (event.data.type === 'initialized') {
          clearTimeout(timeout);
          console.log('[VAD] Worklet initialized');
          resolve();
        } else if (event.data.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(event.data.error));
        }
      };
    });
    
    // Send WASM binary to worklet (transferable)
    workletNode.port.postMessage(
      { type: 'init', wasmBinary },
      [wasmBinary] // Transfer ownership for efficiency
    );
    
    await initPromise;
    
    // Connect audio graph: source -> worklet -> destination
    sourceNode.connect(workletNode);
    workletNode.connect(destinationNode);
    
    processedTrack = destinationNode.stream.getAudioTracks()[0];
    isActive = true;
    
    console.log('[VAD] Noise suppression active with VAD gating');
    return processedTrack;
    
  } catch (error) {
    console.error('[VAD] Failed to start:', error);
    await stopVadNoiseSuppression();
    return track; // Return original on failure
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
  
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
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
