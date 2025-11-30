import type { PeerState } from './types';

// Audio constraints optimized for voice chat
// Browser's built-in processing provides first-pass filtering,
// then RNNoise provides ML-based deep noise removal
export const audioConstraints: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,   // Reduce echo/feedback
    noiseSuppression: true,   // Browser's basic noise filter (first pass)
    autoGainControl: true,    // Normalize volume levels
    sampleRate: 48000         // High quality for RNNoise
  },
  video: false
};

// RTC configuration - no STUN/TURN needed for LAN
const rtcConfig: RTCConfiguration = {
  iceServers: [
    // Include public STUN server as fallback for non-LAN scenarios
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

export class PeerConnection {
  pc: RTCPeerConnection;
  peerId: string;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onAudioTrack: (stream: MediaStream) => void;
  onVideoTrack: (stream: MediaStream) => void;
  onNegotiationNeeded: () => void;
  private videoSender: RTCRtpSender | null = null;

  constructor(
    peerId: string,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
    onAudioTrack: (stream: MediaStream) => void,
    onVideoTrack?: (stream: MediaStream) => void,
    onNegotiationNeeded?: () => void
  ) {
    this.peerId = peerId;
    this.onIceCandidate = onIceCandidate;
    this.onAudioTrack = onAudioTrack;
    this.onVideoTrack = onVideoTrack || (() => {});
    this.onNegotiationNeeded = onNegotiationNeeded || (() => {});
    this.pc = new RTCPeerConnection(rtcConfig);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate.toJSON());
      }
    };

    // Differentiate incoming tracks by kind
    this.pc.ontrack = (event) => {
      if (!event.streams[0]) return;
      
      if (event.track.kind === 'audio') {
        this.onAudioTrack(event.streams[0]);
      } else if (event.track.kind === 'video') {
        this.onVideoTrack(event.streams[0]);
      }
    };

    // Handle renegotiation needed (e.g., when adding/removing video track)
    this.pc.onnegotiationneeded = () => {
      console.log(`[RTC] Negotiation needed for ${peerId}`);
      this.onNegotiationNeeded();
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[RTC] Connection to ${peerId}: ${this.pc.connectionState}`);
    };
  }

  addLocalStream(stream: MediaStream) {
    stream.getTracks().forEach(track => {
      this.pc.addTrack(track, stream);
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[RTC] Error adding ICE candidate:', e);
    }
  }

  close() {
    this.pc.close();
  }

  async replaceAudioTrack(newTrack: MediaStreamTrack) {
    const senders = this.pc.getSenders();
    const audioSender = senders.find(s => s.track?.kind === 'audio');
    if (audioSender) {
      await audioSender.replaceTrack(newTrack);
    }
  }

  /**
   * Add a video track to the connection (for camera).
   * This triggers renegotiation.
   */
  addVideoTrack(track: MediaStreamTrack, stream: MediaStream) {
    if (this.videoSender) {
      console.warn(`[RTC] Video track already exists for ${this.peerId}`);
      return;
    }
    this.videoSender = this.pc.addTrack(track, stream);
    console.log(`[RTC] Added video track to ${this.peerId}`);
  }

  /**
   * Remove the video track from the connection.
   * This triggers renegotiation.
   */
  removeVideoTrack() {
    if (this.videoSender) {
      this.pc.removeTrack(this.videoSender);
      this.videoSender = null;
      console.log(`[RTC] Removed video track from ${this.peerId}`);
    }
  }

  /**
   * Check if this connection has an active video track.
   */
  hasVideoTrack(): boolean {
    return this.videoSender !== null;
  }
}

// Audio level detection for speaking indicators
export function createAudioAnalyzer(stream: MediaStream): () => number {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  const source = audioContext.createMediaStreamSource(stream);
  
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  return () => {
    analyser.getByteFrequencyData(dataArray);
    // Calculate average volume level (0-1)
    const sum = dataArray.reduce((a, b) => a + b, 0);
    return sum / (dataArray.length * 255);
  };
}
