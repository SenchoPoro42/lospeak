<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import PartySocket from 'partysocket';
  import { PeerConnection, audioConstraints, createAudioAnalyzer } from '$lib/rtc';
  import type { SignalMessage, PeerState } from '$lib/types';
import { page } from '$app/stores';
import { tick } from 'svelte';
import {
    isNoiseSuppressionSupported,
    startNoiseSuppression,
    stopNoiseSuppression,
    getActiveMethod,
    getVadScore,
    getVadThreshold,
    setVadThreshold
  } from '$lib/noise';

  // State
  let myId = $state('');
  let myName = $state('');
  let muted = $state(false);
  let connected = $state(false);
  let connecting = $state(true);
  let roomId = $state('');
  let showSettings = $state(false);
  let audioDevices = $state<MediaDeviceInfo[]>([]);
  let selectedDeviceId = $state<string>('');
  let noiseFilterEnabled = $state(false);
  let noiseFilterSupported = $state(false);
  let vadScore = $state(0);
  let vadThreshold = $state(0.85);
  let vadPeak = $state(0);
  let peakDecayTimer: ReturnType<typeof setTimeout> | null = null;
  
  // Volume controls
  let micGain = $state(1.0);       // 0-2 range (0% to 200%)
  let outputVolume = $state(1.0); // 0-1 range (0% to 100%)
  let micGainNode: GainNode | null = null;
  let micAudioContext: AudioContext | null = null;
  
  let peers = $state<Map<string, PeerState>>(new Map());
  let localStream: MediaStream | null = null;
  let socket: PartySocket | null = null;
  let connections = new Map<string, PeerConnection>();
  let audioElements = new Map<string, HTMLAudioElement>();
  let localAudioAnalyzer: (() => number) | null = null;
  let selfAudioLevel = $state(0);
  let selfSpeaking = $state(false);
  let animationFrame: number;

  // PartyKit host - change this after deployment
  const PARTYKIT_HOST = browser 
    ? (import.meta.env.VITE_PARTYKIT_HOST || 'localhost:1999')
    : '';

  // Display name editing
  let editingName = $state(false);
  let nameDraft = $state('');
  let nameInputEl: HTMLInputElement | null = null;
  async function startEditName() { editingName = true; nameDraft = myName; await tick(); nameInputEl?.focus(); }
  function cancelEditName() { editingName = false; }
  function commitEditName() {
    const desired = nameDraft.trim();
    if (!desired || !socket) { editingName = false; return; }
    socket.send(JSON.stringify({ type: 'rename-request', name: desired }));
    editingName = false;
  }

  // Room code split for banner
  function splitRoom(code: string) {
    const m = code.match(/^([a-z]+)-([a-z]+)-(\d{3})$/);
    return m ? { w1: m[1], w2: m[2], num: m[3] } : { w1: code, w2: '', num: '' };
  }
  let roomParts = $state({ w1: '', w2: '', num: '' });
  let copied = $state(false);

  function getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2);
  }

  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioDevices = devices.filter(d => d.kind === 'audioinput');
      // Set default device if not set
      if (!selectedDeviceId && audioDevices.length > 0) {
        selectedDeviceId = audioDevices[0].deviceId;
      }
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
    }
  }

  /**
   * Process audio through a GainNode to allow mic volume control.
   * Returns a new MediaStream with the processed audio.
   */
  function createGainProcessedStream(inputStream: MediaStream): MediaStream {
    // Close existing context if any
    if (micAudioContext && micAudioContext.state !== 'closed') {
      micAudioContext.close();
    }
    
    micAudioContext = new AudioContext();
    const source = micAudioContext.createMediaStreamSource(inputStream);
    micGainNode = micAudioContext.createGain();
    micGainNode.gain.value = micGain;
    
    const destination = micAudioContext.createMediaStreamDestination();
    source.connect(micGainNode);
    micGainNode.connect(destination);
    
    return destination.stream;
  }

  async function initAudio(deviceId?: string) {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          ...audioConstraints.audio as MediaTrackConstraints,
          deviceId: deviceId ? { exact: deviceId } : undefined
        },
        video: false
      };
      const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Process through gain node for volume control
      localStream = createGainProcessedStream(rawStream);
      localAudioAnalyzer = createAudioAnalyzer(localStream);
      await loadAudioDevices();
      
      // Check noise suppression support
      noiseFilterSupported = isNoiseSuppressionSupported();
      
      // Update selected device to match actual device
      const track = rawStream.getAudioTracks()[0];
      if (track) {
        const settings = track.getSettings();
        if (settings.deviceId) {
          selectedDeviceId = settings.deviceId;
        }
      }
      return true;
    } catch (err) {
      console.error('Failed to get audio:', err);
      return false;
    }
  }

  async function switchAudioDevice(deviceId: string) {
    if (!deviceId || deviceId === selectedDeviceId) return;
    
    try {
      // Stop old tracks
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      
      // Get new stream with selected device
      const constraints: MediaStreamConstraints = {
        audio: {
          ...audioConstraints.audio as MediaTrackConstraints,
          deviceId: { exact: deviceId }
        },
        video: false
      };
      const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
      localStream = createGainProcessedStream(rawStream);
      localAudioAnalyzer = createAudioAnalyzer(localStream);
      selectedDeviceId = deviceId;
      
      // Apply mute state
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
      
      // Replace track on all peer connections
      const newTrack = localStream.getAudioTracks()[0];
      if (newTrack) {
        for (const pc of connections.values()) {
          await pc.replaceAudioTrack(newTrack);
        }
      }
      
      console.log('[Audio] Switched to device:', deviceId);
    } catch (err) {
      console.error('Failed to switch audio device:', err);
    }
  }

  /**
   * Update mic gain in real-time
   */
  function updateMicGain(value: number) {
    micGain = value;
    if (micGainNode) {
      micGainNode.gain.value = value;
    }
  }

  /**
   * Update output volume for all peer audio elements
   */
  function updateOutputVolume(value: number) {
    outputVolume = value;
    for (const audio of audioElements.values()) {
      audio.volume = value;
    }
  }

  /**
   * Toggle noise filter on/off.
   * When enabled, processes audio through RNNoise to remove
   * keyboard clicks, fan noise, and other background sounds.
   */
  async function toggleNoiseFilter() {
    if (!localStream) return;
    
    const track = localStream.getAudioTracks()[0];
    if (!track) return;

    try {
      let newTrack: MediaStreamTrack;

      if (!noiseFilterEnabled) {
        // Enable: process track through RNNoise
        console.log('[Noise] Enabling filter...');
        newTrack = await startNoiseSuppression(track);
        // Adopt processed track as our local stream so future PCs get suppressed audio
        localStream = new MediaStream([newTrack]);
        localAudioAnalyzer = createAudioAnalyzer(localStream);
        // Apply current mute state
        newTrack.enabled = !muted;
        noiseFilterEnabled = true;
      } else {
        // Disable: stop processing and use raw track
        console.log('[Noise] Disabling filter...');
        await stopNoiseSuppression();
        
        // Get fresh raw track from current device, processed through gain
        const constraints: MediaStreamConstraints = {
          audio: {
            ...audioConstraints.audio as MediaTrackConstraints,
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined
          },
          video: false
        };
        const freshStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Process through gain node for volume control
        localStream = createGainProcessedStream(freshStream);
        newTrack = localStream.getAudioTracks()[0];
        localAudioAnalyzer = createAudioAnalyzer(localStream);
        
        // Apply mute state
        newTrack.enabled = !muted;
        noiseFilterEnabled = false;
      }

      // Replace track on all peer connections
      for (const pc of connections.values()) {
        await pc.replaceAudioTrack(newTrack);
      }

      console.log('[Noise] Filter', noiseFilterEnabled ? 'enabled' : 'disabled');
    } catch (err) {
      console.error('Failed to toggle noise filter:', err);
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
      const data = JSON.parse(event.data) as SignalMessage;
      
      switch (data.type) {
        case 'welcome':
          myId = data.peerId;
          myName = data.name;
          connected = true;
          connecting = false;

          // If user has a preferred name, request it
          try {
            const saved = localStorage.getItem('displayName');
            if (saved && saved.trim() && saved !== myName) {
              socket?.send(JSON.stringify({ type: 'rename-request', name: saved }));
            }
          } catch {}
          
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

        case 'rename': {
          if (data.peerId === myId) {
            myName = data.name;
            try { localStorage.setItem('displayName', myName); } catch {}
          } else {
            const p = peers.get(data.peerId);
            if (p) {
              peers.set(data.peerId, { ...p, name: data.name });
              peers = new Map(peers);
            }
          }
          break;
        }

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
        audio.volume = outputVolume; // Apply current output volume
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

  // Invite link helpers
  function inviteUrl() {
    return typeof window !== 'undefined' ? window.location.href : '';
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(roomId);
      copied = true;
      setTimeout(() => copied = false, 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }
  async function copyUrl() {
    try { await navigator.clipboard.writeText(inviteUrl()); } catch {}
  }
  async function shareLink() {
    if (navigator.share) {
      try { await navigator.share({ title: 'LoSpeak room', url: inviteUrl() }); } catch {}
    } else {
      await copyUrl();
    }
  }

  // Route controls room; no join action here

  // Update local audio level and VAD score
  function updateLocalLevel() {
    if (localAudioAnalyzer && !muted) {
      const lvl = localAudioAnalyzer();
      selfAudioLevel = lvl;
      selfSpeaking = lvl > 0.05;
    } else {
      selfSpeaking = false;
      selfAudioLevel = 0;
    }
    // Update VAD score for meter display
    if (noiseFilterEnabled) {
      vadScore = getVadScore();
      
      // Track peak with decay
      if (vadScore > vadPeak) {
        vadPeak = vadScore;
        // Reset decay timer
        if (peakDecayTimer) clearTimeout(peakDecayTimer);
        peakDecayTimer = setTimeout(() => {
          // Slowly decay peak
          const decayPeak = () => {
            if (vadPeak > vadScore + 0.01) {
              vadPeak = vadPeak * 0.95;
              requestAnimationFrame(decayPeak);
            }
          };
          decayPeak();
        }, 1500); // Hold peak for 1.5s before decay
      }
    } else {
      vadPeak = 0;
    }
    animationFrame = requestAnimationFrame(updateLocalLevel);
  }
  
  // Handle threshold drag on VAD meter
  let isDraggingThreshold = $state(false);
  let vadMeterBar: HTMLElement | null = $state(null);
  
  function handleThresholdDragStart(e: MouseEvent | TouchEvent) {
    isDraggingThreshold = true;
    e.preventDefault();
    document.addEventListener('mousemove', handleThresholdDrag);
    document.addEventListener('mouseup', handleThresholdDragEnd);
    document.addEventListener('touchmove', handleThresholdDrag);
    document.addEventListener('touchend', handleThresholdDragEnd);
  }
  
  function handleThresholdDrag(e: MouseEvent | TouchEvent) {
    if (!isDraggingThreshold || !vadMeterBar) return;
    
    const rect = vadMeterBar.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    const percent = Math.max(0.5, Math.min(0.98, x / rect.width));
    
    vadThreshold = percent;
    setVadThreshold(percent);
  }
  
  function handleThresholdDragEnd() {
    isDraggingThreshold = false;
    document.removeEventListener('mousemove', handleThresholdDrag);
    document.removeEventListener('mouseup', handleThresholdDragEnd);
    document.removeEventListener('touchmove', handleThresholdDrag);
    document.removeEventListener('touchend', handleThresholdDragEnd);
  }

  onMount(async () => {
    if (!browser) return;
    
    roomId = ($page.params.room as string) || 'main';
    roomParts = splitRoom(roomId);
    const hasAudio = await initAudio();
    if (hasAudio) {
      // Enable noise filter before connecting so initial sender is suppressed
      if (noiseFilterSupported && !noiseFilterEnabled) {
        await toggleNoiseFilter();
      }
      connectToRoom(roomId);
      updateLocalLevel();
    }
  });

  onDestroy(() => {
    if (!browser) return;
    
    cancelAnimationFrame(animationFrame);
    
    // Clean up noise suppression
    stopNoiseSuppression();
    
    // Clean up mic audio context
    if (micAudioContext && micAudioContext.state !== 'closed') {
      micAudioContext.close();
    }
    
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
    <h1><a href="/" class="brand-link">LoSpeak</a></h1>
  </header>


  <!-- Room banner -->
  {#if roomParts.w1}
    <div class="room-banner glass">
      <span class="label">Room</span>
      <div class="code">
        <span class="word">{roomParts.w1}</span>
        <span class="dash">–</span>
        <span class="word">{roomParts.w2}</span>
        <span class="dash">–</span>
        <span class="num">{roomParts.num}</span>
      </div>
      <div class="actions">
        <button class="icon" class:copied onclick={copyCode} title={copied ? 'Copied!' : 'Copy code'} aria-label="Copy room code">
          {#if copied}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          {/if}
        </button>
        {#if 'share' in navigator}
          <button class="icon" onclick={shareLink} title="Share" aria-label="Share invite link">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="peers-grid">
    <!-- Self card -->
    <div class="peer-card self-card glass" class:speaking={selfSpeaking && !muted} class:disconnected={!connected && !connecting} class:connecting>
      <div class="avatar">
        <div class="avatar-ring"></div>
        {getInitials(myName || 'You')}
      </div>
      <div class="peer-name">
        {#if editingName}
          <input class="name-input" bind:this={nameInputEl} bind:value={nameDraft}
                 onkeydown={(e) => (e.key === 'Enter' ? commitEditName() : e.key === 'Escape' ? cancelEditName() : null)}
                 onblur={commitEditName}
                 aria-label="Your display name" />
          <span class="you-badge">You</span>
        {:else}
          <button type="button" class="self-name-button" title="Edit display name" onclick={startEditName} onkeydown={(e) => e.key === 'Enter' && startEditName()} aria-label="Edit display name">
            <span class="self-name">{myName || '…'}</span>
            <span class="you-badge">You</span>
          </button>
        {/if}
      </div>
      <span class="peer-status" class:muted={muted}>
        {#if !connected}
          {connecting ? 'Connecting...' : 'Disconnected'}
        {:else if muted}
          Muted
        {:else}
          &nbsp;
        {/if}
      </span>
    </div>
    <!-- Remote peers -->
    {#each [...peers.values()] as peer (peer.id)}
      <div class="peer-card glass" class:speaking={peer.speaking && !peer.muted}>
        <div class="avatar">
          <div class="avatar-ring"></div>
          {getInitials(peer.name)}
        </div>
        <span class="peer-name">{peer.name}</span>
        <span class="peer-status" class:muted={peer.muted}>
          {peer.muted ? 'Muted' : ''}
        </span>
      </div>
    {/each}
  </div>

  {#if connected && peers.size === 0}
    <div class="empty-state glass">
      <h3>Waiting for others</h3>
      <p>Share this link to invite people</p>
      <div class="share-row">
        <input type="text" readonly value={typeof window !== 'undefined' ? window.location.href : ''} />
        <button onclick={copyUrl}>Copy link</button>
        <button onclick={shareLink} disabled={!('share' in navigator)}>Share</button>
      </div>
    </div>
  {/if}

  {#if connected}
    <!-- Settings button -->
    <button 
      class="settings-button glass"
      onclick={() => showSettings = !showSettings}
      aria-label="Settings"
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>

    <!-- Settings panel -->
    {#if showSettings}
      <div class="settings-panel glass">
        <h3>Audio Settings</h3>
        
        <!-- Microphone selection -->
        <label>
          <span>Microphone</span>
          <select 
            value={selectedDeviceId}
            onchange={(e) => switchAudioDevice(e.currentTarget.value)}
          >
            {#each audioDevices as device}
              <option value={device.deviceId}>
                {device.label || `Microphone ${audioDevices.indexOf(device) + 1}`}
              </option>
            {/each}
          </select>
        </label>

        <!-- Mic Gain slider -->
        <label class="slider-label">
          <span>Mic Level <span class="volume-value">{Math.round(micGain * 100)}%</span></span>
          <input 
            type="range" 
            min="0" 
            max="2" 
            step="0.05" 
            value={micGain}
            oninput={(e) => updateMicGain(parseFloat(e.currentTarget.value))}
            class="volume-slider mic-slider"
          />
        </label>

        <!-- Incoming Volume slider -->
        <label class="slider-label">
          <span>Incoming Volume <span class="volume-value">{Math.round(outputVolume * 100)}%</span></span>
          <input 
            type="range" 
            min="0" 
            max="1" 
            step="0.05" 
            value={outputVolume}
            oninput={(e) => updateOutputVolume(parseFloat(e.currentTarget.value))}
            class="volume-slider output-slider"
          />
        </label>

        <!-- Noise filter toggle -->
        <label class="toggle-label">
          <span>Noise Filter</span>
          <button 
            class="toggle" 
            class:active={noiseFilterEnabled}
            onclick={toggleNoiseFilter}
            disabled={!noiseFilterSupported}
            aria-pressed={noiseFilterEnabled}
            aria-label="Toggle noise filter"
          >
            <span class="toggle-slider"></span>
          </button>
        </label>
        
        {#if noiseFilterEnabled}
          <!-- VAD Meter -->
          <div class="vad-meter">
            <div class="vad-meter-label">
              <span>Voice Level</span>
              <span class="vad-score">{(vadScore * 100).toFixed(0)}%</span>
            </div>
            <div 
              class="vad-meter-bar" 
              bind:this={vadMeterBar}
              role="slider"
              aria-valuemin="50"
              aria-valuemax="98"
              aria-valuenow={Math.round(vadThreshold * 100)}
              aria-label="VAD threshold"
              tabindex="0"
            >
              <div 
                class="vad-meter-fill" 
                class:passing={vadScore >= vadThreshold}
                style="width: {vadScore * 100}%"
              ></div>
              {#if vadPeak > 0.01}
                <div 
                  class="vad-peak-marker"
                  style="left: {vadPeak * 100}%"
                  title="Peak: {(vadPeak * 100).toFixed(0)}%"
                ></div>
              {/if}
              <div 
                class="vad-threshold-marker" 
                class:dragging={isDraggingThreshold}
                style="left: {vadThreshold * 100}%"
                title="Drag to adjust threshold ({(vadThreshold * 100).toFixed(0)}%)"
                onmousedown={handleThresholdDragStart}
                ontouchstart={handleThresholdDragStart}
                role="button"
                tabindex="0"
              >
                <span class="threshold-label">{(vadThreshold * 100).toFixed(0)}%</span>
              </div>
            </div>
            <p class="filter-hint">
              {vadScore >= vadThreshold ? '🎤 Voice passing' : '🔇 Silenced'}
              <span class="threshold-hint">Drag marker to adjust</span>
            </p>
          </div>
        {:else if !noiseFilterSupported}
          <p class="filter-hint unsupported">Not supported in this browser</p>
        {/if}
      </div>
    {/if}

    <!-- Call controls -->
    <div class="call-controls">
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
      <a 
        href="/" 
        class="hangup-button"
        aria-label="Leave room"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
        </svg>
      </a>
    </div>
  {/if}
</div>
