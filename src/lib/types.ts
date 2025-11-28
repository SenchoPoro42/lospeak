// Signaling message types (must match server)
export type SignalMessage =
  | { type: "welcome"; peerId: string; name: string; peers: PeerInfo[] }
  | { type: "join"; peerId: string; name: string }
  | { type: "leave"; peerId: string }
  | { type: "offer"; from: string; to: string; offer: RTCSessionDescriptionInit }
  | { type: "answer"; from: string; to: string; answer: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "mute-status"; peerId: string; muted: boolean };

export interface PeerInfo {
  id: string;
  name: string;
}

export interface PeerState extends PeerInfo {
  muted: boolean;
  speaking: boolean;
  connection?: RTCPeerConnection;
  audioLevel: number;
}
