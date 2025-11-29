<script lang="ts">
  import { goto } from '$app/navigation';
  import { generateRoomCode, normalizeRoomCode, isValidRoomCode, isKnownWord } from '$lib/roomCode';
  import { onMount } from 'svelte';

  let codeInput = '';
  let error = '';

  // Segmented code inputs
  let codeW1 = '';
  let codeW2 = '';
  let codeNum = '';
  let w1El: HTMLInputElement | null = null;
  let w2El: HTMLInputElement | null = null;
  let numEl: HTMLInputElement | null = null;

  // Preferred display name (stored locally; applied after join via rename-request)
  let displayName = '';
  let editingName = false;
  let nameDraft = '';
  let nameInputEl: HTMLInputElement | null = null;

  onMount(() => {
    try {
      const saved = localStorage.getItem('displayName');
      if (saved) displayName = saved;
    } catch {}
  });

  function startEdit() { editingName = true; nameDraft = displayName; setTimeout(() => nameInputEl?.focus(), 0); }
  function commitEdit() {
    const desired = nameDraft.trim();
    if (desired) {
      displayName = desired;
      try { localStorage.setItem('displayName', desired); } catch {}
    }
    editingName = false;
  }
  function cancelEdit() { editingName = false; }

  function initials(name: string): string {
    return (name || 'You').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }

  function createRoom() {
    const code = generateRoomCode();
    goto(`/r/${code}`);
  }

  function joinByCode() {
    // Prefer segmented inputs when used
    const segUsed = codeW1 || codeW2 || codeNum;
    let normalized = '';
    if (segUsed) {
      const w1 = (codeW1 || '').trim().toLowerCase().replace(/[^a-z]/g, '');
      const w2 = (codeW2 || '').trim().toLowerCase().replace(/[^a-z]/g, '');
      const n = (codeNum || '').trim().replace(/\D/g, '').padStart(3, '0');
      normalized = `${w1}-${w2}-${n}`;
    } else {
      normalized = normalizeRoomCode(codeInput);
    }
    if (!isValidRoomCode(normalized)) {
      error = 'Enter two words and a 3-digit number (e.g., ember-vale-742)';
      return;
    }
    goto(`/r/${normalized}`);
  }

  function handleW1Input(e: Event) {
    codeW1 = (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z]/g, '');
    // Auto-advance when a known word is typed
    if (isKnownWord(codeW1)) {
      w2El?.focus();
    }
  }
  function handleW2Input(e: Event) {
    codeW2 = (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z]/g, '');
    // Auto-advance when a known word is typed
    if (isKnownWord(codeW2)) {
      numEl?.focus();
    }
  }
  function handleNumInput(e: Event) {
    codeNum = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 3);
  }

  function w1Keydown(e: KeyboardEvent) {
    if (e.key === '-' || e.key === ' ') { e.preventDefault(); w2El?.focus(); }
  }
  function w2Keydown(e: KeyboardEvent) {
    if (e.key === '-' || e.key === ' ') { e.preventDefault(); numEl?.focus(); }
    if (e.key === 'Backspace' && !codeW2) { e.preventDefault(); w1El?.focus(); }
  }
  function numKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && !codeNum) { e.preventDefault(); w2El?.focus(); }
    if (e.key === 'Enter') joinByCode();
  }

  async function handleSmartPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text') || '';
    const norm = normalizeRoomCode(text);
    if (norm && isValidRoomCode(norm)) {
      e.preventDefault();
      const [w1, w2, n] = norm.split('-');
      codeW1 = w1; codeW2 = w2; codeNum = n;
      numEl?.focus();
    }
  }
</script>

<svelte:head>
  <title>LoSpeak</title>
  <meta name="description" content="Local voice chat" />
</svelte:head>

<div class="container">
  <header class="header">
    <h1><a href="/" class="brand-link">LoSpeak</a></h1>
    <p class="subtitle">Simple, shareable rooms for peer-to-peer voice chat</p>
  </header>

  <!-- Self card on landing -->
  <div class="glass profile-card">
    <div class="peer-card self-card">
      <div class="avatar">
        <div class="avatar-ring"></div>
        {initials(displayName)}
      </div>
      <div class="peer-name">
        {#if editingName}
          <input class="name-input" bind:this={nameInputEl} bind:value={nameDraft}
                 onkeydown={(e) => (e.key === 'Enter' ? commitEdit() : e.key === 'Escape' ? cancelEdit() : null)}
                 onblur={commitEdit}
                 aria-label="Your display name" />
          <span class="you-badge">You</span>
        {:else}
          <button type="button" class="self-name-button" title="Edit display name" onclick={startEdit}
                  onkeydown={(e) => e.key === 'Enter' && startEdit()} aria-label="Edit display name">
            <span class="self-name">{displayName || 'Your name'}</span>
            <span class="you-badge">You</span>
          </button>
        {/if}
      </div>
      <span class="peer-status">Not connected</span>
    </div>
  </div>

  <div class="landing glass">
    <div class="actions">
      <button class="primary" onclick={createRoom}>Create new room</button>
    </div>

    <div class="divider">or</div>

    <div class="join segmented" role="group" aria-label="Room code">
      <input class="seg w1" bind:this={w1El} inputmode="text" autocapitalize="off" autocomplete="off" spellcheck={false}
             placeholder="word"
             value={codeW1}
             oninput={handleW1Input}
             onkeydown={w1Keydown}
             onpaste={handleSmartPaste}
             aria-label="First word" />
      <span class="dash">-</span>
      <input class="seg w2" bind:this={w2El} inputmode="text" autocapitalize="off" autocomplete="off" spellcheck={false}
             placeholder="word"
             value={codeW2}
             oninput={handleW2Input}
             onkeydown={w2Keydown}
             onpaste={handleSmartPaste}
             aria-label="Second word" />
      <span class="dash">-</span>
      <input class="seg num" bind:this={numEl} inputmode="numeric" pattern="[0-9]*" placeholder="000"
             value={codeNum}
             oninput={handleNumInput}
             onkeydown={numKeydown}
             onpaste={handleSmartPaste}
             aria-label="Number" />
      <button onclick={joinByCode}>Join</button>
    </div>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
</div>
