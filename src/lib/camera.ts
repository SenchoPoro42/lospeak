// Camera constraints - 480p default for bandwidth efficiency
export const cameraConstraints: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user'
};

/**
 * Acquire camera stream with optional device selection.
 */
export async function getCameraStream(deviceId?: string): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    video: {
      ...cameraConstraints,
      deviceId: deviceId ? { exact: deviceId } : undefined
    },
    audio: false // Camera is video only; audio is handled separately
  };

  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Stop all tracks in a camera stream.
 */
export function stopCameraStream(stream: MediaStream | null) {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
}

/**
 * Check if camera access is supported in this browser.
 */
export function isCameraSupported(): boolean {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/**
 * Get list of available video input devices.
 */
export async function getVideoDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}
