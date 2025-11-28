<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import PartySocket from 'partysocket';
  import { PeerConnection, audioConstraints, createAudioAnalyzer } from '$lib/rtc';
  import type { SignalMessage, PeerState } from '$lib/types';

  // State
  let myId = $state('');
  let myName = $state('');
  let muted = $state(false);
  let connected = $state(false);
  let connecting = $state(true);
  let roomId = $state('main');
  let roomInput = $state('');
  
  let peers = $state<Map<string, PeerState>>(new Map());
  let localStream: MediaStream | null = null;
  let socket: PartySocket | null = null;
  let connections = new Map<string, PeerConnection>();
  let audioElements = new Map<string, HTMLAudioElement>();
  let localAudioAnalyzer: (() => number) | null = null;
  let animationFrame: number;

  // PartyKit host - change this after deployment
  const PARTYKIT_HOST = browser 
    ? (import.meta.env.VITE_PARTYKIT_HOST || 'localhost:1999')
    : '';

  function getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2);
  }

  async function initAudio() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      localAudioAnalyzer = createAudioAnalyzer(localStream);
      return true;
    } catch (err) {
      console.error('Failed to get audio:', err);
      return false;
    }
  }

  function connectToRoom(room: string) {
    if (socket) {
      socket.close();
    }

    roomId = room;
    connecting = true;
    
    socket = new PartySocket({
      host: PARTYKIT_HOST,
      room: roomId
    });

    socket.addEventListener('open', () => {
      console.log('[Party] Connected to room:', roomId);
    });

    socket.addEventListener('message', async (event) => {
      const data = JSON.parse(event.data) as SignalMessage | { type: 'welcome'; peerId: string; name: string; peers: Array<{ id: string; name: string }> };
      
      switch (data.type) {
        case 'welcome':
          myId = data.peerId;
          myName = data.name;
          connected = true;
          connecting = false;
          
          // Connect to existing peers
          for (const peer of data.peers) {
            await connectToPeer(peer.id, peer.name, true);
          }
          break;

        case 'join':
          await connectToPeer(data.peerId, data.name, false);
          break;

        case 'leave':
          disconnectFromPeer(data.peerId);
          break;

        case 'offer':
          await handleOffer(data.from, data.offer);
          break;

        case 'answer':
          await handleAnswer(data.from, data.answer);
          break;

        case 'ice-candidate':
          await handleIceCandidate(data.from, data.candidate);
          break;

        case 'mute-status':
          const peer = peers.get(data.peerId);
          if (peer) {
            peers.set(data.peerId, { ...peer, muted: data.muted });
            peers = new Map(peers);
          }
          break;
      }
    });

    socket.addEventListener('close', () => {
      console.log('[Party] Disconnected');
      connected = false;
      connecting = false;
    });

    socket.addEventListener('error', (err) => {
      console.error('[Party] Error:', err);
      connecting = false;
    });
  }

  async function connectToPeer(peerId: string, name: string, initiator: boolean) {
    if (connections.has(peerId)) return;

    const peerState: PeerState = {
      id: peerId,
      name,
      muted: false,
      speaking: false,
      audioLevel: 0
    };
    peers.set(peerId, peerState);
    peers = new Map(peers);

    const pc = new PeerConnection(
      peerId,
      (candidate) => {
        socket?.send(JSON.stringify({
          type: 'ice-candidate',
          to: peerId,
          candidate
        }));
      },
      (stream) => {
        // Create audio element for this peer
        const audio = new Audio();
        audio.srcObject = stream;
        audio.autoplay = true;
        audioElements.set(peerId, audio);
        
        // Set up audio level detection for remote peer
        const analyzer = createAudioAnalyzer(stream);
        const updateLevel = () => {
          const peer = peers.get(peerId);
          if (peer) {
            const level = analyzer();
            peers.set(peerId, { 
              ...peer, 
              audioLevel: level,
              speaking: level > 0.05
            });
            peers = new Map(peers);
          }
        };
        
        // Update audio levels periodically
        const interval = setInterval(updateLevel, 100);
        // Store interval for cleanup
        (pc as any)._levelInterval = interval;
      }
    );

    connections.set(peerId, pc);

    if (localStream) {
      pc.addLocalStream(localStream);
    }

    if (initiator) {
      const offer = await pc.createOffer();
      socket?.send(JSON.stringify({
        type: 'offer',
        to: peerId,
        offer
      }));
    }
  }

  async function handleOffer(from: string, offer: RTCSessionDescriptionInit) {
    let pc = connections.get(from);
    
    if (!pc) {
      // Peer initiated connection to us
      const existingPeer = peers.get(from);
      if (!existingPeer) {
        // We don't know this peer yet, wait for join message
        return;
      }
      await connectToPeer(from, existingPeer.name, false);
      pc = connections.get(from)!;
    }

    const answer = await pc.handleOffer(offer);
    socket?.send(JSON.stringify({
      type: 'answer',
      to: from,
      answer
    }));
  }

  async function handleAnswer(from: string, answer: RTCSessionDescriptionInit) {
    const pc = connections.get(from);
    if (pc) {
      await pc.handleAnswer(answer);
    }
  }

  async function handleIceCandidate(from: string, candidate: RTCIceCandidateInit) {
    const pc = connections.get(from);
    if (pc) {
      await pc.addIceCandidate(candidate);
    }
  }

  function disconnectFromPeer(peerId: string) {
    const pc = connections.get(peerId);
    if (pc) {
      clearInterval((pc as any)._levelInterval);
      pc.close();
      connections.delete(peerId);
    }
    
    const audio = audioElements.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audioElements.delete(peerId);
    }
    
    peers.delete(peerId);
    peers = new Map(peers);
  }

  function toggleMute() {
    muted = !muted;
    
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    }
    
    socket?.send(JSON.stringify({
      type: 'mute-status',
      peerId: myId,
      muted
    }));
  }

  function joinRoom() {
    if (roomInput.trim()) {
      connectToRoom(roomInput.trim().toLowerCase());
    }
  }

  // Update local audio level
  function updateLocalLevel() {
    if (localAudioAnalyzer && !muted) {
      // Could be used for self-visualization if needed
    }
    animationFrame = requestAnimationFrame(updateLocalLevel);
  }

  onMount(async () => {
    if (!browser) return;
    
    const hasAudio = await initAudio();
    if (hasAudio) {
      connectToRoom(roomId);
      updateLocalLevel();
    }
  });

  onDestroy(() => {
    if (!browser) return;
    
    cancelAnimationFrame(animationFrame);
    
    // Clean up connections
    connections.forEach(pc => pc.close());
    connections.clear();
    
    // Clean up audio
    audioElements.forEach(audio => {
      audio.srcObject = null;
    });
    audioElements.clear();
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    
    socket?.close();
  });
</script>

<svelte:head>
  <title>LoSpeak</title>
  <meta name="description" content="Local network voice chat" />
</svelte:head>

<div class="container">
  <header class="header">
    <h1>LoSpeak</h1>
    {#if connected && myName}
      <p class="subtitle">You are <span class="self-name">{myName}</span></p>
    {:else if connecting}
      <p class="subtitle">Connecting...</p>
    {:else}
      <p class="subtitle">Voice chat for the room</p>
    {/if}
  </header>

  <div class="status-bar glass-subtle">
    <span class="status-dot" class:connecting class:disconnected={!connected && !connecting}></span>
    <span>
      {#if connected}
        Room: {roomId}
      {:else if connecting}
        Connecting...
      {:else}
        Disconnected
      {/if}
    </span>
  </div>

  {#if peers.size > 0}
    <div class="peers-grid">
      {#each [...peers.values()] as peer (peer.id)}
        <div class="peer-card glass" class:speaking={peer.speaking && !peer.muted}>
          <div class="avatar">
            <div class="avatar-ring"></div>
            {getInitials(peer.name)}
          </div>
          <span class="peer-name">{peer.name}</span>
          <span class="peer-status" class:muted={peer.muted}>
            {peer.muted ? 'Muted' : 'Connected'}
          </span>
        </div>
      {/each}
    </div>
  {:else if connected}
    <div class="empty-state glass">
      <h3>Waiting for others</h3>
      <p>Share this room to invite people</p>
      <div class="room-input">
        <input 
          type="text" 
          placeholder="Room name..."
          bind:value={roomInput}
          onkeydown={(e) => e.key === 'Enter' && joinRoom()}
        />
        <button onclick={joinRoom}>Join</button>
      </div>
    </div>
  {:else}
    <div class="empty-state glass">
      <h3>Enable microphone access</h3>
      <p>Click allow when prompted</p>
    </div>
  {/if}

  {#if connected}
    <button 
      class="mute-button" 
      class:muted 
      onclick={toggleMute}
      aria-label={muted ? 'Unmute' : 'Mute'}
    >
      {#if muted}
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
      {/if}
    </button>
  {/if}
</div>
