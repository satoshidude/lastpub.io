<slot />

<style>
  :global(:root) {
    color-scheme: dark;
    --bg: #10131a;
    --panel: #1a1f2b;
    --border: #2c3446;
    --text: #e6e9f0;
    --muted: #8b93a7;
    --accent: #7aa2f7;
    --danger: #f7768e;
    --ok: #9ece6a;
    --warn: #e0af68;
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.5;
  }
  :global(input),
  :global(textarea),
  :global(select) {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem;
    font: inherit;
    width: 100%;
    box-sizing: border-box;
  }
  :global(button) {
    background: var(--accent);
    color: #0d1017;
    border: 0;
    border-radius: 6px;
    padding: 0.55rem 1rem;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  :global(button:disabled) {
    opacity: 0.5;
    cursor: default;
  }
  :global(button.secondary) {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
  }
  :global(button.danger) {
    background: var(--danger);
  }
</style>
