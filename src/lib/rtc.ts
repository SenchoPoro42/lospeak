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
  onTrack: (stream: MediaStream) => void;

  constructor(
    peerId: string,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
    onTrack: (stream: MediaStream) => void
  ) {
    this.peerId = peerId;
    this.onIceCandidate = onIceCandidate;
    this.onTrack = onTrack;
    this.pc = new RTCPeerConnection(rtcConfig);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate.toJSON());
      }
    };

    this.pc.ontrack = (event) => {
      if (event.streams[0]) {
        this.onTrack(event.streams[0]);
      }
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
