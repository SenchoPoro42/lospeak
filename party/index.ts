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

function sanitizeName(raw: string): string {
  let name = (raw || "").toString().trim();
  // Collapse whitespace and limit charset/length
  name = name.replace(/\s+/g, " ").replace(/[^A-Za-z0-9 _\-]/g, "").slice(0, 24);
  return name || generateName();
}

function isNameTaken(peers: Map<string, PeerInfo>, name: string, exceptId?: string): boolean {
  name = name.toLowerCase();
  for (const [id, p] of peers) {
    if (id !== exceptId && p.name.toLowerCase() === name) return true;
  }
  return false;
}

function allocateUniqueName(peers: Map<string, PeerInfo>, base?: string): string {
  const tryBase = sanitizeName(base || generateName());
  if (!isNameTaken(peers, tryBase)) return tryBase;
  // Append numeric suffix until free
  for (let i = 2; i < 1000; i++) {
    const candidate = `${tryBase}-${i}`;
    if (!isNameTaken(peers, candidate)) return candidate;
  }
  // Fallback (should never happen)
  return `${tryBase}-${Date.now() % 1000}`;
}

// Message types for signaling
type SignalMessage =
  | { type: "join"; peerId: string; name: string }
  | { type: "leave"; peerId: string }
  | { type: "peers"; peers: Array<{ id: string; name: string }> }
  | { type: "offer"; from: string; to: string; offer: RTCSessionDescriptionInit }
  | { type: "answer"; from: string; to: string; answer: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "mute-status"; peerId: string; muted: boolean }
  | { type: "rename-request"; name: string }
  | { type: "rename"; peerId: string; name: string }
  | { type: "error"; reason: string }
  // Camera (presence layer)
  | { type: "camera-status"; peerId: string; enabled: boolean }
  // Screen share
  | { type: "screen-start"; peerId: string }
  | { type: "screen-stop"; peerId: string }
  | { type: "screen-subscribe"; from: string; to: string }
  | { type: "screen-unsubscribe"; from: string; to: string }
  | { type: "screen-offer"; from: string; to: string; offer: RTCSessionDescriptionInit }
  | { type: "screen-answer"; from: string; to: string; answer: RTCSessionDescriptionInit }
  | { type: "screen-ice"; from: string; to: string; candidate: RTCIceCandidateInit };

interface PeerInfo {
  id: string;
  name: string;
  connection: Party.Connection;
}

// Maximum concurrent screen sharers (soft limit)
const MAX_SCREEN_SHARERS = 4;

export default class LoSpeakServer implements Party.Server {
  peers: Map<string, PeerInfo> = new Map();
  screenSharers: Set<string> = new Set(); // Track who's sharing screen

  constructor(public room: Party.Room) {}

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const peerId = conn.id;
    const name = allocateUniqueName(this.peers);
    
    // Store peer info
    this.peers.set(peerId, { id: peerId, name, connection: conn });

    // Send the new peer their assigned name and existing peers (including screen share status)
    const existingPeers = Array.from(this.peers.values())
      .filter(p => p.id !== peerId)
      .map(p => ({ 
        id: p.id, 
        name: p.name,
        screenSharing: this.screenSharers.has(p.id)
      }));
    
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

        case "camera-status":
          // Broadcast camera status to all peers (presence layer)
          this.broadcast(JSON.stringify({
            type: "camera-status",
            peerId: sender.id,
            enabled: (data as any).enabled
          }), [sender.id]);
          break;

        case "screen-start": {
          // Track screen sharer and broadcast
          if (this.screenSharers.size >= MAX_SCREEN_SHARERS && !this.screenSharers.has(sender.id)) {
            // Soft limit reached - still allow but could warn
            console.log(`[Room ${this.room.id}] Screen share slots full (${this.screenSharers.size}/${MAX_SCREEN_SHARERS})`);
          }
          this.screenSharers.add(sender.id);
          this.broadcast(JSON.stringify({
            type: "screen-start",
            peerId: sender.id
          }), [sender.id]);
          break;
        }

        case "screen-stop":
          // Remove from sharers and broadcast
          this.screenSharers.delete(sender.id);
          this.broadcast(JSON.stringify({
            type: "screen-stop",
            peerId: sender.id
          }), [sender.id]);
          break;

        case "screen-subscribe":
        case "screen-unsubscribe":
        case "screen-offer":
        case "screen-answer":
        case "screen-ice": {
          // Relay screen share signaling to specific peer
          const target = this.peers.get((data as any).to);
          if (target) {
            target.connection.send(JSON.stringify({
              ...data,
              from: sender.id
            }));
          }
          break;
        }
        case "rename-request": {
          const current = this.peers.get(sender.id);
          if (!current) break;
          const proposed = sanitizeName((data as any).name);
          const unique = isNameTaken(this.peers, proposed, sender.id)
            ? allocateUniqueName(this.peers, proposed)
            : proposed;
          if (unique !== current.name) {
            current.name = unique;
            this.peers.set(sender.id, current);
            this.broadcast(JSON.stringify({
              type: "rename",
              peerId: sender.id,
              name: unique
            }));
          }
          break;
        }
      }
    } catch (e) {
      console.error("Failed to parse message:", e);
    }
  }

  onClose(conn: Party.Connection) {
    const peerId = conn.id;
    this.peers.delete(peerId);
    
    // Clean up screen share if they were sharing
    if (this.screenSharers.has(peerId)) {
      this.screenSharers.delete(peerId);
      // Broadcast screen-stop so others can clean up
      this.broadcast(JSON.stringify({
        type: "screen-stop",
        peerId
      }));
    }
    
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
