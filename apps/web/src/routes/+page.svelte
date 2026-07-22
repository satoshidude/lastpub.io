<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import * as nip19 from 'nostr-tools/nip19'
  import { PRESETS, nip07Signer, type Signer } from '@lastpub/core'
  import { LastpubClient, FeedbackError } from '@lastpub/client'
  import { storage, type PendingStage5, type Settings, type SwitchData } from '$lib/storage.js'

  let settings: Settings = { relays: [], towerNpubs: [] }
  let relaysInput = ''
  let towersInput = ''
  let signer: Signer | null = null
  let client: LastpubClient | null = null
  let pubkey = ''
  let sw: SwitchData | null = null
  let pending: PendingStage5 | null = null

  let message = ''
  let recipientNpub = ''
  let presetIndex = 1
  let reschedPresetIndex = 1
  let reschedFor = ''
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
    towersInput = settings.towerNpubs.join(', ')
    sw = storage.loadSwitch()
    pending = storage.loadPending()
  })

  // Two phases only: withheld until the deadline, then published & readable at
  // the same moment — there is no window in between.
  $: phase = !sw ? 'none' : now <= sw.publishAt ? 'ACTIVE' : 'PUBLISHED'

  // Sync the reschedule selector to the switch's current interval once per switch,
  // so the user's later choice isn't overwritten on every clock tick.
  $: if (sw && sw.switchId !== reschedFor) {
    const i = PRESETS.findIndex((p) => p.interval === sw.interval)
    reschedPresetIndex = i >= 0 ? i : 1
    reschedFor = sw.switchId
  }

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
    settings.towerNpubs = towersInput.split(',').map((s) => s.trim()).filter(Boolean)
    storage.saveSettings(settings)
    if (signer) client = new LastpubClient(signer, settings, storage)
  }

  async function login(): Promise<void> {
    error = ''
    try {
      if (!window.nostr) throw new Error('No NIP-07 extension found (Alby, nos2x, …)')
      signer = nip07Signer(window.nostr)
      pubkey = await signer.getPublicKey()
      client = new LastpubClient(signer, settings, storage)
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
        { interval: PRESETS[reschedPresetIndex].interval },
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
    void run('Deleting message …', async () => {
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

  let fileInput: HTMLInputElement

  const doRestoreRelay = () =>
    run('Recovering from the relays — please confirm decrypt prompts …', async () => {
      const restored = await client!.restoreFromRelay()
      if (!restored) {
        error = 'No switch of yours was found on these relays. Try the relay you originally used, or import your export file.'
        return
      }
      sw = restored
    })

  async function onImportFile(): Promise<void> {
    const file = fileInput?.files?.[0]
    if (!file) return
    await run('Importing export file …', async () => {
      sw = await client!.restoreFromExport(JSON.parse(await file.text()))
    })
    fileInput.value = ''
  }
</script>

<main>
  <h1>lastpub <span class="tag">publish after silence</span></h1>

  <details class="panel" open={!settings.towerNpubs.length}>
    <summary>Settings</summary>
    <label>
      Relays (comma-separated)
      <input bind:value={relaysInput} placeholder="wss://nos.lol, wss://relay.damus.io" />
    </label>
    <p class="muted small help">
      WebSocket URLs of the nostr relays this app publishes to and reads from. Use relays
      that accept writes from anyone — public ones like <code>wss://nos.lol</code> or
      <code>wss://relay.damus.io</code>, or your own. Every tower must be reachable on at
      least one of them. This demo is preconfigured with public relays.
    </p>
    <label>
      Tower npubs (comma-separated)
      <input bind:value={towersInput} placeholder="npub1…, npub1…" />
    </label>
    <p class="muted small help">
      Public keys of the schedulers (“towers”) that hold your sealed message and publish it
      if you fall silent. A tower is a separate service you have to trust — not your own
      key, and not a relay. <strong>List more than one for redundancy:</strong> the capsule
      is deposited with each, and if any single tower survives to your deadline, the message
      still fires. Get one from a tower operator, or run your own with
      <code>npm run dev-stack</code>, which prints its npub. This demo is preconfigured with
      one public reference tower.
    </p>
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
        old capsule is still in the job and would fire at the old deadline. Retry stage 5
        now.
        <button on:click={doRetry} disabled={!!busy}>Retry</button>
      </div>
    {/if}

    {#if !sw}
      <div class="panel">
        <h2>Your switch</h2>
        <p class="muted small">
          The switch is your timer. Set the interval, add a message, and check in before
          the deadline — miss it and the message is delivered and readable at once. There
          is no message yet, so the switch is idle.
        </p>
        <label>
          Check-in interval
          <select bind:value={presetIndex}>
            <option value={0}>7 days — high attention</option>
            <option value={1}>30 days — standard</option>
            <option value={2}>90 days — long-term</option>
          </select>
        </label>
        <h3>Add a message</h3>
        <label>
          Recipient (npub)
          <input bind:value={recipientNpub} placeholder="npub1…" />
        </label>
        <label>
          Message (leaves the browser only sealed)
          <textarea rows="6" bind:value={message}></textarea>
        </label>
        <button on:click={doCreate} disabled={!!busy || !message || !recipientNpub}>
          Seal &amp; arm the switch
        </button>

        <h3>Or recover an existing switch</h3>
        <p class="muted small help">
          Lost your local state — new device, other browser, cleared storage? Your switch
          isn't gone: rebuild it from your key. Your drafts and the scheduled job live on
          the relays, and an export file carries everything on its own. Either way you can
          resume check-ins, even against a different tower.
        </p>
        <div class="row">
          <button class="secondary" on:click={doRestoreRelay} disabled={!!busy}
            >Restore from relay</button
          >
          <button class="secondary" on:click={() => fileInput.click()} disabled={!!busy}
            >Import export file</button
          >
          <input
            type="file"
            accept="application/json,.json"
            bind:this={fileInput}
            on:change={onImportFile}
            style="display:none"
          />
        </div>
      </div>
    {:else}
      <div class="panel">
        <h2>
          Your switch
          {#if phase === 'ACTIVE'}<span class="pill ok">active</span>
          {:else}<span class="pill danger">published &amp; readable</span>{/if}
        </h2>

        {#if phase === 'ACTIVE'}
          <p>
            Next deadline: <strong>{fmt(sw.publishAt)}</strong>
            <span class="muted">(in {fmtRemaining(sw.publishAt)})</span>
          </p>
          <label>
            Check-in interval
            <select bind:value={reschedPresetIndex}>
              <option value={0}>7 days — high attention</option>
              <option value={1}>30 days — standard</option>
              <option value={2}>90 days — long-term</option>
            </select>
          </label>
          <p class="muted small help">
            Changing the interval takes effect on your next check-in — it reschedules the
            deadline from that moment.
          </p>
        {:else}
          <p>
            The deadline passed — the message was published and has been readable by its
            recipient since <strong>{fmt(sw.publishAt)}</strong>. It cannot be recalled. A
            check-in starts the switch over with a fresh capsule.
          </p>
        {/if}

        <div class="row">
          <button
            on:click={doCheckin}
            disabled={!!busy || (editingMessageId !== null && !editedMessage.trim())}
          >
            {phase === 'ACTIVE' ? 'Check-in' : 'Check-in (restart)'}
          </button>
        </div>
        <p class="muted small">
          Check-in anchor: {fmt(sw.lastCheckinAt)} · Interval {sw.interval / 86400} d
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
                ·
                <span
                  title={msg.placements.map((p) => nip19.npubEncode(p.towerPub)).join('\n')}
                  >{msg.placements.length === 1
                    ? '1 tower'
                    : `${msg.placements.length} towers (redundant)`}</span
                > ·
                <a
                  href="https://njump.me/{neventOf(msg.wrap.id, msg.wrap.pubkey)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  title={phase === 'ACTIVE'
                    ? 'The nevent reference of the capsule. It only resolves after the deadline — the tower withholds the event until then (concealment).'
                    : 'Published at the trigger — now publicly resolvable.'}
                  >capsule on njump</a
                >
                {#if phase === 'ACTIVE'}<span class="muted"> (withheld until the deadline)</span>{/if}
              </span>
            </p>

            {#if msg.concealmentBroken}
              <div class="banner warn">
                The deadline passed once, so this message was published and read: concealment
                toward this recipient is permanently broken. Options: change recipient, talk
                it over, or leave it as is.
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
                <button class="danger" on:click={doDelete} disabled={!!busy}>
                  {confirmDelete
                    ? 'Really delete? (silent — the recipient learns nothing)'
                    : 'Delete message'}
                </button>
                {#if confirmDelete}
                  <button class="secondary" on:click={() => (confirmDelete = false)}>Cancel</button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
        <p class="muted small">
          Deleting a message cancels its job silently and leaves the switch idle — the
          recipient is never notified. The timer settings stay; you can add a new message.
        </p>
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
  .help {
    margin: -0.4rem 0 0.75rem;
    line-height: 1.45;
  }
  code {
    font-size: 0.85em;
  }
</style>
