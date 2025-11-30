// Screen sharing with subscription model
// Sharer sends to subscribers only via separate RTCPeerConnections

// Screen share constraints - prioritize clarity for text/UI
export const screenConstraints: DisplayMediaStreamOptions = {
  video: {
    // Prefer higher resolution for readability
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 60 }
  },
  audio: false  // Can be enabled later for system audio
};

// RTC configuration (same as main connections)
const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

/**
 * Acquire screen share stream via browser picker.
 */
export async function getScreenStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia(screenConstraints);
}

/**
 * Check if screen sharing is supported.
 */
export function isScreenShareSupported(): boolean {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

/**
 * A single screen share connection to a subscriber.
 * The sharer creates one of these for each peer who subscribes.
 */
export class ScreenShareConnection {
  pc: RTCPeerConnection;
  subscriberId: string;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  private stream: MediaStream;

  constructor(
    subscriberId: string,
    stream: MediaStream,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void
  ) {
    this.subscriberId = subscriberId;
    this.stream = stream;
    this.onIceCandidate = onIceCandidate;
    this.pc = new RTCPeerConnection(rtcConfig);

    // Add the screen share track
    stream.getTracks().forEach(track => {
      this.pc.addTrack(track, stream);
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate.toJSON());
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[Screen] Connection to subscriber ${subscriberId}: ${this.pc.connectionState}`);
    };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[Screen] Error adding ICE candidate:', e);
    }
  }

  close() {
    this.pc.close();
  }
}

/**
 * A viewer's connection to receive a screen share.
 * Created when subscribing to someone's screen.
 */
export class ScreenViewerConnection {
  pc: RTCPeerConnection;
  sharerId: string;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onTrack: (stream: MediaStream) => void;

  constructor(
    sharerId: string,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
    onTrack: (stream: MediaStream) => void
  ) {
    this.sharerId = sharerId;
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
      console.log(`[Screen] Viewer connection to ${sharerId}: ${this.pc.connectionState}`);
    };
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[Screen] Error adding ICE candidate:', e);
    }
  }

  close() {
    this.pc.close();
  }
}

/**
 * Manages screen sharing state as the sharer.
 * Handles multiple subscribers with individual connections.
 */
export class ScreenShareManager {
  private stream: MediaStream | null = null;
  private subscribers: Map<string, ScreenShareConnection> = new Map();
  private onIceCandidate: (subscriberId: string, candidate: RTCIceCandidateInit) => void;
  private onEnded: () => void;

  constructor(
    onIceCandidate: (subscriberId: string, candidate: RTCIceCandidateInit) => void,
    onEnded: () => void
  ) {
    this.onIceCandidate = onIceCandidate;
    this.onEnded = onEnded;
  }

  /**
   * Start sharing screen. Returns the stream if successful.
   */
  async start(): Promise<MediaStream | null> {
    try {
      this.stream = await getScreenStream();
      
      // Listen for when user stops sharing via browser UI
      this.stream.getVideoTracks()[0].onended = () => {
        console.log('[Screen] User stopped sharing via browser');
        this.stop();
        this.onEnded();
      };
      
      return this.stream;
    } catch (e) {
      console.error('[Screen] Failed to start sharing:', e);
      return null;
    }
  }

  /**
   * Stop sharing and close all subscriber connections.
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    this.subscribers.forEach(conn => conn.close());
    this.subscribers.clear();
  }

  /**
   * Handle a new subscriber requesting the stream.
   * Creates a connection and returns the offer to send.
   */
  async addSubscriber(subscriberId: string): Promise<RTCSessionDescriptionInit | null> {
    if (!this.stream) {
      console.warn('[Screen] No stream to share');
      return null;
    }

    // Close existing connection if any
    const existing = this.subscribers.get(subscriberId);
    if (existing) {
      existing.close();
    }

    const conn = new ScreenShareConnection(
      subscriberId,
      this.stream,
      (candidate) => this.onIceCandidate(subscriberId, candidate)
    );

    this.subscribers.set(subscriberId, conn);
    return conn.createOffer();
  }

  /**
   * Handle answer from subscriber.
   */
  async handleAnswer(subscriberId: string, answer: RTCSessionDescriptionInit) {
    const conn = this.subscribers.get(subscriberId);
    if (conn) {
      await conn.handleAnswer(answer);
    }
  }

  /**
   * Handle ICE candidate from subscriber.
   */
  async handleIceCandidate(subscriberId: string, candidate: RTCIceCandidateInit) {
    const conn = this.subscribers.get(subscriberId);
    if (conn) {
      await conn.addIceCandidate(candidate);
    }
  }

  /**
   * Remove a subscriber (they unsubscribed or left).
   */
  removeSubscriber(subscriberId: string) {
    const conn = this.subscribers.get(subscriberId);
    if (conn) {
      conn.close();
      this.subscribers.delete(subscriberId);
    }
  }

  /**
   * Check if currently sharing.
   */
  isSharing(): boolean {
    return this.stream !== null;
  }

  /**
   * Get subscriber count.
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Get the local screen stream (for preview).
   */
  getStream(): MediaStream | null {
    return this.stream;
  }
}
