// Signaling message types (must match server)
export type SignalMessage =
  // Connection & identity
  | { type: "welcome"; peerId: string; name: string; peers: PeerInfo[] }
  | { type: "join"; peerId: string; name: string }
  | { type: "leave"; peerId: string }
  | { type: "rename"; peerId: string; name: string }
  | { type: "rename-request"; name: string }
  | { type: "error"; reason: string }
  // Audio WebRTC signaling
  | { type: "offer"; from: string; to: string; offer: RTCSessionDescriptionInit }
  | { type: "answer"; from: string; to: string; answer: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "mute-status"; peerId: string; muted: boolean }
  // Camera (presence layer - no subscription needed)
  | { type: "camera-status"; peerId: string; enabled: boolean }
  // Screen share announcements
  | { type: "screen-start"; peerId: string }
  | { type: "screen-stop"; peerId: string }
  // Screen share subscription flow
  | { type: "screen-subscribe"; from: string; to: string }
  | { type: "screen-unsubscribe"; from: string; to: string }
  // Screen share WebRTC signaling (separate connections)
  | { type: "screen-offer"; from: string; to: string; offer: RTCSessionDescriptionInit }
  | { type: "screen-answer"; from: string; to: string; answer: RTCSessionDescriptionInit }
  | { type: "screen-ice"; from: string; to: string; candidate: RTCIceCandidateInit };

export interface PeerInfo {
  id: string;
  name: string;
  screenSharing?: boolean;  // Included in welcome message for existing peers
}

export interface PeerState extends PeerInfo {
  // Audio state
  muted: boolean;
  speaking: boolean;
  audioLevel: number;
  connection?: RTCPeerConnection;
  
  // Local volume control (user's personal preference for this peer)
  localVolume: number;  // 0-1, multiplied with global outputVolume
  localMuted: boolean;  // Muted locally by user
  
  // Camera (presence layer - received automatically)
  cameraEnabled: boolean;
  cameraStream?: MediaStream;
  cameraAspectRatio?: number;  // e.g., 1.78 for 16:9, 1.33 for 4:3
  
  // Screen share (content layer - subscription required)
  screenSharing: boolean;
  screenStream?: MediaStream;
  screenSubscribed: boolean;
  screenAspectRatio?: number;  // e.g., 3.56 for 32:9, 1.78 for 16:9
}
