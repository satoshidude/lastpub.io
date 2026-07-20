<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { SimplePool } from 'nostr-tools/pool'
  import * as nip19 from 'nostr-tools/nip19'
  import {
    decryptCapsule,
    nip07Signer,
    unwrapCapsule,
    type Event,
    type Rumor,
    type Signer,
  } from '@lastpub/core'
  import {
    DEFAULT_RELAYS,
    checkRevoked,
    fetchCurrentRound,
    fetchWrap,
    parseFile,
    parseInput,
    roundStatus,
  } from '$lib/decrypt.js'

  const pool = new SimplePool()

  let input = ''
  let relaysInput = DEFAULT_RELAYS.join(', ')
  let wrap: Event | null = null
  let rumor: Rumor | null = null
  let round = 0
  let readableAt = 0
  let unlocked = false
  let revoked = false
  let plaintext: string | null = null
  let busy = ''
  let error = ''
  let now = Math.floor(Date.now() / 1000)

  const clock = setInterval(() => {
    now = Math.floor(Date.now() / 1000)
    if (!unlocked && readableAt > 0 && now >= readableAt) unlocked = true
  }, 1000)
  onDestroy(() => {
    clearInterval(clock)
    pool.close(relays())
  })

  onMount(() => {
    const hash = location.hash.slice(1)
    if (hash) {
      input = decodeURIComponent(hash)
      void load()
    }
  })

  function relays(): string[] {
    return relaysInput.split(',').map((s) => s.trim()).filter(Boolean)
  }

  function fmt(ts: number): string {
    return new Date(ts * 1000).toLocaleString()
  }
  function fmtRemaining(target: number): string {
    const s = Math.max(0, target - now)
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min ${s % 60} s`
  }

  async function withBusy(label: string, fn: () => Promise<void>): Promise<void> {
    busy = label
    error = ''
    try {
      await fn()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = ''
    }
  }

  const load = () =>
    withBusy('Searching for capsule …', async () => {
      plaintext = null
      rumor = null
      const ref = parseInput(input)
      const searchRelays = [...new Set([...ref.relays, ...relays()])]
      const found = await fetchWrap(pool, searchRelays, ref.id)
      if (!found) {
        throw new Error(
          'Capsule not found on any relay. Check the relay list — or use the export file (offline path).',
        )
      }
      wrap = found
      revoked = await checkRevoked(pool, searchRelays, found)
    })

  async function onFile(e: unknown): Promise<void> {
    const file = (e as { currentTarget: HTMLInputElement }).currentTarget.files?.[0]
    if (!file) return
    await withBusy('Reading file …', async () => {
      plaintext = null
      rumor = null
      wrap = parseFile(await file.text())
      revoked = await checkRevoked(pool, relays(), wrap)
    })
  }

  const unwrap = () =>
    withBusy('Unwrapping capsule …', async () => {
      if (!window.nostr) throw new Error('No NIP-07 extension found (Alby, nos2x, …)')
      const signer: Signer = nip07Signer(window.nostr)
      const res = await unwrapCapsule(signer, wrap!)
      rumor = res.rumor
      round = res.round
      const current = await fetchCurrentRound().catch(() => 0)
      const status = roundStatus(round, current)
      readableAt = status.readableAt
      unlocked = status.unlocked
    })

  const decrypt = () =>
    withBusy('Fetching and verifying beacon …', async () => {
      plaintext = await decryptCapsule(rumor!)
    })
</script>

<main>
  <h1>lastpub <span class="tag">decrypt</span></h1>
  <p class="muted">
    This page runs entirely in your browser. Decryption only with your key
    (NIP-07) and only once the drand round is reached and the beacon is verified.
  </p>

  <div class="panel">
    <label>
      nevent or event ID
      <input bind:value={input} placeholder="nevent1…" />
    </label>
    <label>
      Relays (comma-separated)
      <input bind:value={relaysInput} />
    </label>
    <div class="row">
      <button on:click={load} disabled={!!busy || !input}>Load capsule</button>
      <label class="filebtn">
        Open export file
        <input type="file" accept="application/json" on:change={onFile} hidden />
      </label>
    </div>
  </div>

  {#if wrap}
    <div class="panel">
      <p>
        Capsule <code>{wrap.id.slice(0, 16)}…</code>
        · <a
          href="https://njump.me/{nip19.neventEncode({ id: wrap.id, relays: relays().slice(0, 4), author: wrap.pubkey })}"
          target="_blank"
          rel="noopener noreferrer">view on njump</a
        >
        {#if revoked}<span class="pill warn">revoked by author</span>{/if}
      </p>
      {#if revoked}
        <div class="banner warn">
          The author has revoked this message. It remains technically decryptable
          once the round is reached — the author asks you not to read it.
        </div>
      {/if}

      {#if !rumor}
        <button on:click={unwrap} disabled={!!busy}>Unwrap with my key</button>
      {:else if plaintext === null}
        {#if unlocked}
          <button on:click={decrypt} disabled={!!busy}>Decrypt</button>
        {:else}
          <p>
            Readable from <strong>{fmt(readableAt)}</strong>
            <span class="muted">(in {fmtRemaining(readableAt)})</span> — drand round
            <code>{round}</code>. The time lives in the math, not on this page.
          </p>
        {/if}
      {:else}
        <h2>Message</h2>
        <pre class="message">{plaintext}</pre>
        <p class="muted small">
          Only in this view — not stored. Save the text yourself if needed.
        </p>
      {/if}
    </div>
  {/if}

  {#if busy}<p class="muted">{busy}</p>{/if}
  {#if error}<div class="banner danger">{error}</div>{/if}
</main>

<style>
  main {
    max-width: 680px;
    margin: 0 auto;
    padding: 2rem 1rem 4rem;
  }
  h1 {
    font-size: 1.6rem;
  }
  .tag {
    font-size: 0.9rem;
    color: var(--muted);
    font-weight: 400;
    margin-left: 0.5rem;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin: 1rem 0;
  }
  label {
    display: block;
    margin: 0.75rem 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .filebtn {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.55rem 1rem;
    cursor: pointer;
    margin: 0;
    color: var(--text);
    font-weight: 600;
  }
  .banner {
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin: 1rem 0;
  }
  .banner.warn {
    background: color-mix(in srgb, var(--warn) 15%, transparent);
    border: 1px solid var(--warn);
  }
  .banner.danger {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    border: 1px solid var(--danger);
  }
  .pill {
    font-size: 0.75rem;
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    margin-left: 0.5rem;
    background: color-mix(in srgb, var(--warn) 25%, transparent);
    color: var(--warn);
  }
  .message {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.8rem;
  }
</style>
