<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import * as nip19 from 'nostr-tools/nip19'
  import { PRESETS, nip07Signer, type Signer } from '@lastpub/core'
  import { LastpubClient, FeedbackError } from '$lib/client.js'
  import { storage, type PendingStage5, type Settings, type SwitchData } from '$lib/storage.js'

  let settings: Settings = { relays: [], towerNpub: '' }
  let relaysInput = ''
  let signer: Signer | null = null
  let client: LastpubClient | null = null
  let pubkey = ''
  let sw: SwitchData | null = null
  let pending: PendingStage5 | null = null

  let message = ''
  let recipientNpub = ''
  let presetIndex = 1
  let editingMessageId: string | null = null
  let editedMessage = ''
  let confirmDelete = false

  let busy = ''
  let error = ''
  let now = Math.floor(Date.now() / 1000)
  const clock = setInterval(() => (now = Math.floor(Date.now() / 1000)), 1000)
  onDestroy(() => {
    clearInterval(clock)
    client?.close()
  })

  onMount(() => {
    settings = storage.loadSettings()
    relaysInput = settings.relays.join(', ')
    sw = storage.loadSwitch()
    pending = storage.loadPending()
  })

  $: phase = !sw
    ? 'none'
    : now <= sw.publishAt
      ? 'ACTIVE'
      : now <= sw.roundTime
        ? 'TRIGGERED'
        : 'RELEASED'

  function neventOf(wrapId: string, wrapPubkey: string): string {
    return nip19.neventEncode({
      id: wrapId,
      relays: settings.relays.slice(0, 4),
      author: wrapPubkey,
    })
  }
  function npubShort(hex: string): string {
    const npub = nip19.npubEncode(hex)
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`
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

  function saveSettings(): void {
    settings.relays = relaysInput.split(',').map((s) => s.trim()).filter(Boolean)
    storage.saveSettings(settings)
    if (signer) client = new LastpubClient(signer, settings)
  }

  async function login(): Promise<void> {
    error = ''
    try {
      if (!window.nostr) throw new Error('No NIP-07 extension found (Alby, nos2x, …)')
      signer = nip07Signer(window.nostr)
      pubkey = await signer.getPublicKey()
      client = new LastpubClient(signer, settings)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function run(label: string, fn: () => Promise<void>): Promise<void> {
    if (!client) return
    busy = label
    error = ''
    try {
      await fn()
    } catch (e) {
      error =
        e instanceof FeedbackError
          ? `Tower rejected: ${e.info}`
          : e instanceof Error
            ? e.message
            : String(e)
    } finally {
      busy = ''
    }
  }

  const doCreate = () =>
    run('Creating switch …', async () => {
      const preset = PRESETS[presetIndex]
      sw = await client!.createSwitch({
        message,
        recipientNpub,
        interval: preset.interval,
        grace: preset.grace,
      })
      message = ''
      recipientNpub = ''
    })

  const startEdit = (messageId: string) =>
    run('Decrypting message …', async () => {
      editedMessage = (await client!.readDraft(sw!, messageId)).message
      editingMessageId = messageId
    })

  const doCheckin = () =>
    run('Check-in in progress — please confirm extension prompts (sign/decrypt) …', async () => {
      sw = await client!.checkin(
        sw!,
        editingMessageId ? { messageId: editingMessageId, message: editedMessage } : undefined,
      )
      pending = null
      editingMessageId = null
    }).then(() => {
      pending = storage.loadPending()
    })

  const doRetry = () =>
    run('Retrying stage 5 …', async () => {
      sw = await client!.completeStage5(sw!, pending!)
      pending = null
    }).then(() => {
      pending = storage.loadPending()
    })

  const doDelete = () => {
    if (!confirmDelete) {
      confirmDelete = true
      return
    }
    confirmDelete = false
    void run('Deleting …', async () => {
      await client!.deleteSwitch(sw!)
      sw = null
    })
  }

  function doExport(messageId: string): void {
    if (!client || !sw) return
    const data = client.buildExportFile(sw, messageId)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'lastpub-export.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }
</script>

<main>
  <h1>lastpub <span class="tag">publish after silence</span></h1>

  <details class="panel" open={!settings.towerNpub}>
    <summary>Settings</summary>
    <label>
      Relays (comma-separated)
      <input bind:value={relaysInput} placeholder="ws://127.0.0.1:7777" />
    </label>
    <label>
      Tower npub
      <input bind:value={settings.towerNpub} placeholder="npub1…" />
    </label>
    <button class="secondary" on:click={saveSettings}>Save</button>
  </details>

  {#if !signer}
    <div class="panel center">
      <p>Sign in via NIP-07 extension (nip44-capable, e.g. Alby or nos2x).</p>
      <button on:click={login}>Sign in with extension</button>
    </div>
  {:else}
    <p class="muted">Signed in as <code>{pubkey.slice(0, 16)}…</code></p>

    {#if pending}
      <div class="banner warn">
        <strong>Check-in incomplete.</strong> The timer hasn't been confirmed yet — the
        old capsule is still in the job, so the revocation window would be shortened on
        trigger. Retry stage 5 now.
        <button on:click={doRetry} disabled={!!busy}>Retry</button>
      </div>
    {/if}

    {#if !sw}
      <div class="panel">
        <h2>Create switch</h2>
        <p class="muted small">
          The switch is your timer: if you don't check in within the interval, your
          stored message is delivered.
        </p>
        <label>
          Interval / revocation window
          <select bind:value={presetIndex}>
            <option value={0}>7 days / 3 days — high attention</option>
            <option value={1}>30 days / 5 days — standard</option>
            <option value={2}>90 days / 7 days — long-term</option>
          </select>
        </label>
        <h3>Message</h3>
        <label>
          Recipient (npub)
          <input bind:value={recipientNpub} placeholder="npub1…" />
        </label>
        <label>
          Message (leaves the browser only sealed)
          <textarea rows="6" bind:value={message}></textarea>
        </label>
        <button on:click={doCreate} disabled={!!busy || !message || !recipientNpub}>
          Seal &amp; store
        </button>
      </div>
    {:else}
      <div class="panel">
        <h2>
          Your switch
          {#if phase === 'ACTIVE'}<span class="pill ok">active</span>
          {:else if phase === 'TRIGGERED'}<span class="pill warn">triggered — grace running</span>
          {:else}<span class="pill danger">published &amp; readable</span>{/if}
        </h2>

        {#if phase === 'ACTIVE'}
          <p>
            Next deadline: <strong>{fmt(sw.publishAt)}</strong>
            <span class="muted">(in {fmtRemaining(sw.publishAt)})</span>
          </p>
        {:else if phase === 'TRIGGERED'}
          <p>
            The messages have been published, but remain unreadable to anyone until
            <strong>{fmt(sw.roundTime)}</strong>
            <span class="muted">({fmtRemaining(sw.roundTime)})</span>.
            A check-in now revokes them.
          </p>
        {:else}
          <p>
            The round has been reached — recipients have been able to read since
            <strong>{fmt(sw.roundTime)}</strong>. A check-in restarts the switch with
            fresh capsules.
          </p>
        {/if}

        <div class="row">
          <button
            on:click={doCheckin}
            disabled={!!busy || (editingMessageId !== null && !editedMessage.trim())}
          >
            {phase === 'ACTIVE' ? 'Check-in' : 'Check-in & revoke'}
          </button>
          <button class="danger" on:click={doDelete} disabled={!!busy}>
            {confirmDelete ? 'Really delete? (silent, recipients learn nothing)' : 'Delete'}
          </button>
          {#if confirmDelete}
            <button class="secondary" on:click={() => (confirmDelete = false)}>Cancel</button>
          {/if}
        </div>
        <p class="muted small">
          Check-in anchor: {fmt(sw.lastCheckinAt)} · Interval {sw.interval / 86400} d · Grace
          {sw.grace / 86400} d
        </p>
      </div>

      <div class="panel">
        <h2>
          {sw.messages.length === 1 ? 'Message' : `Messages (${sw.messages.length})`}
        </h2>
        {#each sw.messages as msg (msg.id)}
          <div class="message-card">
            <p>
              To <code title={nip19.npubEncode(msg.recipient)}>{npubShort(msg.recipient)}</code>
              <span class="muted small">
                · Job <code>{msg.requestId.slice(0, 12)}…</code> ·
                <a
                  href="https://njump.me/{neventOf(msg.wrap.id, msg.wrap.pubkey)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Not publicly discoverable before the trigger (withholding) — the link only works after publication."
                  >capsule on njump</a
                >
              </span>
            </p>

            {#if msg.concealmentBroken}
              <div class="banner warn">
                After a false trigger, concealment toward this recipient is permanently
                broken. Options: change recipient, talk it over, or leave it as is.
              </div>
            {/if}

            {#if editingMessageId === msg.id}
              <label>
                Edit message (will be sealed with the next check-in)
                <textarea rows="6" bind:value={editedMessage}></textarea>
              </label>
              <div class="row">
                <button class="secondary" on:click={() => (editingMessageId = null)}
                  >Cancel</button
                >
              </div>
            {:else}
              <div class="row">
                <button class="secondary" on:click={() => startEdit(msg.id)} disabled={!!busy}
                  >Edit</button
                >
                <button class="secondary" on:click={() => doExport(msg.id)}>Export</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if busy}<p class="muted">{busy}</p>{/if}
    {#if error}<div class="banner danger">{error}</div>{/if}
  {/if}
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
  h3 {
    font-size: 1rem;
    margin-bottom: 0;
    color: var(--muted);
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
  .panel.center {
    text-align: center;
    padding: 2rem;
  }
  .message-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin: 0.75rem 0;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
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
    margin-top: 1rem;
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
    vertical-align: middle;
    margin-left: 0.5rem;
  }
  .pill.ok {
    background: color-mix(in srgb, var(--ok) 25%, transparent);
    color: var(--ok);
  }
  .pill.warn {
    background: color-mix(in srgb, var(--warn) 25%, transparent);
    color: var(--warn);
  }
  .pill.danger {
    background: color-mix(in srgb, var(--danger) 25%, transparent);
    color: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.8rem;
  }
  code {
    font-size: 0.85em;
  }
</style>
