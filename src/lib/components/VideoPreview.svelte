<script lang="ts">
  interface Props {
    stream: MediaStream | undefined;
    muted?: boolean;
    mirror?: boolean;
    aspectRatio?: '4:3' | '16:9' | 'auto';
    onclick?: () => void;
    class?: string;
  }

  let {
    stream,
    muted = false,
    mirror = false,
    aspectRatio = '4:3',
    onclick,
    class: className = ''
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
</script>

<div 
  class="video-preview-wrapper {className}"
  class:clickable={!!onclick}
  class:mirror
  style:aspect-ratio={aspectRatio === 'auto' ? 'auto' : aspectRatio.replace(':', ' / ')}
  onclick={onclick}
  onkeydown={(e) => e.key === 'Enter' && onclick?.()}
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
>
  {#if stream}
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      {muted}
    ></video>
  {:else}
    <div class="no-video">
      <slot name="placeholder">
        <span class="no-video-icon">📹</span>
      </slot>
    </div>
  {/if}
  <slot name="overlay"></slot>
</div>

<style>
  .video-preview-wrapper {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    border-radius: var(--radius-md, 16px);
    overflow: hidden;
    background: var(--bg-secondary, #12121a);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-preview-wrapper.clickable {
    cursor: pointer;
    transition: transform var(--transition-fast, 150ms ease), 
                box-shadow var(--transition-fast, 150ms ease);
  }

  .video-preview-wrapper.clickable:hover {
    transform: scale(1.02);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .video-preview-wrapper.mirror video {
    transform: scaleX(-1);
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }

  .no-video {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--text-muted, rgba(255, 255, 255, 0.4));
  }

  .no-video-icon {
    font-size: 2rem;
    opacity: 0.5;
  }
</style>
