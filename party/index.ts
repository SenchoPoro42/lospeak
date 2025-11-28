import type * as Party from "partykit/server";

// Elegant name generation - celestial + nature inspired
const adjectives = [
  "Quiet", "Silver", "Amber", "Pale", "Soft", "Still", "Gentle", "Faint",
  "Distant", "Hidden", "Ancient", "Hollow", "Veiled", "Dusk", "Dawn", "Lunar",
  "Solar", "Misty", "Frost", "Ember", "Ashen", "Golden", "Violet", "Scarlet"
];

const nouns = [
  "Ember", "Drift", "Echo", "Moon", "Thunder", "Water", "Stone", "Wind",
  "Shadow", "Light", "Whisper", "Tide", "Flame", "Frost", "Storm", "Vale",
  "Peak", "Grove", "Shore", "Haze", "Glow", "Spark", "Veil", "Mist"
];

function generateName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

// Message types for signaling
type SignalMessage =
  | { type: "join"; peerId: string; name: string }
  | { type: "leave"; peerId: string }
  | { type: "peers"; peers: Array<{ id: string; name: string }> }
  | { type: "offer"; from: string; to: string; offer: RTCSessionDescriptionInit }
  | { type: "answer"; from: string; to: string; answer: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "mute-status"; peerId: string; muted: boolean };

interface PeerInfo {
  id: string;
  name: string;
  connection: Party.Connection;
}

export default class LoSpeakServer implements Party.Server {
  peers: Map<string, PeerInfo> = new Map();

  constructor(public room: Party.Room) {}

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const peerId = conn.id;
    const name = generateName();
    
    // Store peer info
    this.peers.set(peerId, { id: peerId, name, connection: conn });

    // Send the new peer their assigned name and existing peers
    const existingPeers = Array.from(this.peers.values())
      .filter(p => p.id !== peerId)
      .map(p => ({ id: p.id, name: p.name }));
    
    conn.send(JSON.stringify({
      type: "welcome",
      peerId,
      name,
      peers: existingPeers
    }));

    // Notify all other peers about the new peer
    this.broadcast(JSON.stringify({
      type: "join",
      peerId,
      name
    }), [peerId]);
  }

  onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message) as SignalMessage;
      
      switch (data.type) {
        case "offer":
        case "answer":
        case "ice-candidate":
          // Relay signaling messages to specific peer
          const targetPeer = this.peers.get(data.to);
          if (targetPeer) {
            targetPeer.connection.send(JSON.stringify({
              ...data,
              from: sender.id
            }));
          }
          break;
          
        case "mute-status":
          // Broadcast mute status to all peers
          this.broadcast(JSON.stringify({
            type: "mute-status",
            peerId: sender.id,
            muted: data.muted
          }), [sender.id]);
          break;
      }
    } catch (e) {
      console.error("Failed to parse message:", e);
    }
  }

  onClose(conn: Party.Connection) {
    const peerId = conn.id;
    this.peers.delete(peerId);
    
    // Notify all peers about the departure
    this.broadcast(JSON.stringify({
      type: "leave",
      peerId
    }));
  }

  broadcast(message: string, exclude: string[] = []) {
    for (const [id, peer] of this.peers) {
      if (!exclude.includes(id)) {
        peer.connection.send(message);
      }
    }
  }
}

export const config = {
  hibernate: true
};
