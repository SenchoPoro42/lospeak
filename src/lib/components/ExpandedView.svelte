<script lang="ts">
  interface Props {
    stream: MediaStream | undefined;
    name: string;
    type?: 'screen' | 'camera';
    onclose: () => void;
  }

  let {
    stream,
    name,
    type = 'screen',
    onclose
  }: Props = $props();

  let videoEl: HTMLVideoElement | null = null;

  // Update video srcObject when stream changes
  $effect(() => {
    if (videoEl && stream) {
      videoEl.srcObject = stream;
    } else if (videoEl) {
      videoEl.srcObject = null;
    }
  });

  // Close on Escape key
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div 
  class="expanded-overlay"
  onclick={onclose}
  role="dialog"
  aria-modal="true"
  aria-label="Expanded {type} view"
>
  <div class="expanded-content" onclick={(e) => e.stopPropagation()}>
    <div class="expanded-header">
      <div class="expanded-info">
        <span class="expanded-icon"><i class="fa-solid {type === 'screen' ? 'fa-desktop' : 'fa-video'}"></i></span>
        <span class="expanded-name">{name}</span>
        <span class="expanded-type">{type === 'screen' ? 'Screen Share' : 'Camera'}</span>
      </div>
      <button class="close-button" onclick={onclose} aria-label="Close">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    
    <div class="expanded-video-container">
      {#if stream}
        <video
          bind:this={videoEl}
          autoplay
          playsinline
          class:mirror={type === 'camera'}
        ></video>
      {:else}
        <div class="no-stream">
          <span>Stream ended</span>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .expanded-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .expanded-content {
    width: 100%;
    max-width: 1400px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    animation: scaleIn 0.2s ease;
  }

  @keyframes scaleIn {
    from {
      transform: scale(0.95);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  .expanded-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem;
  }

  .expanded-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .expanded-icon {
    font-size: 1.5rem;
  }

  .expanded-name {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-primary, rgba(255, 255, 255, 0.95));
  }

  .expanded-type {
    font-size: 0.8rem;
    color: var(--text-muted, rgba(255, 255, 255, 0.4));
    padding: 0.25rem 0.5rem;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
  }

  .close-button {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: none;
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-secondary, rgba(255, 255, 255, 0.6));
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .close-button:hover {
    background: rgba(255, 255, 255, 0.2);
    color: var(--text-primary, rgba(255, 255, 255, 0.95));
    transform: scale(1.05);
  }

  .close-button svg {
    width: 20px;
    height: 20px;
  }

  .expanded-video-container {
    flex: 1;
    min-height: 0;
    border-radius: var(--radius-lg, 24px);
    overflow: hidden;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    max-height: 80vh;
  }

  video.mirror {
    transform: scaleX(-1);
  }

  .no-stream {
    color: var(--text-muted, rgba(255, 255, 255, 0.4));
    font-size: 1.1rem;
    padding: 3rem;
  }

  /* Mobile */
  @media (max-width: 480px) {
    .expanded-overlay {
      padding: 0.5rem;
    }

    .expanded-header {
      padding: 0.5rem 0.25rem;
    }

    .expanded-info {
      gap: 0.5rem;
    }

    .expanded-icon {
      font-size: 1.25rem;
    }

    .expanded-name {
      font-size: 1rem;
    }

    .expanded-type {
      display: none;
    }

    video {
      max-height: 85vh;
    }
  }
</style>
