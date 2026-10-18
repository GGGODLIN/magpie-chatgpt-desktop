# magpie-chatgpt-desktop

`magpie-chatgpt-desktop` connects [Magpie](https://github.com/yetone/magpie) to a signed-in official macOS ChatGPT desktop app (`/Applications/ChatGPT.app`) over the local Chromium DevTools Protocol (CDP).

Instead of launching an isolated browser profile against `chatgpt.com` or relying on brittle DOM selectors, this plugin resolves the authenticated internal client inside the desktop renderer by method shape (`safeGet`, `streamPost`, `cancelStream`, excluding `RpcPromise` stubs) and verifies it with a read-only device attestation challenge before sending text requests.

## Requirements

- **OS:** macOS (`darwin`)
- **Desktop App:** Official ChatGPT desktop app installed at `/Applications/ChatGPT.app` and signed in to your account
- **Runtime:** [Bun](https://bun.sh/) (included with Magpie's plugin host)

## Install in Magpie

### From Magpie Plugins Page (GitHub `magpie-plugin`)

Search for `magpie-chatgpt-desktop` or paste `github:GGGODLIN/magpie-chatgpt-desktop` in Magpie's **Plugins → Add plugin** dialog.

### Sign-In Flow

When you click **Sign in** on the **ChatGPT Desktop** provider in Magpie:

1. **Already running with an active debugging port:** Sign-in completes immediately without restarting `ChatGPT.app`.
2. **Not running:** The plugin launches `/Applications/ChatGPT.app` with `--remote-debugging-port=<port>` using an available high port (`58000–65000`, fallback `19333`) and waits up to 20 seconds for readiness.
3. **Running without a debugging port:** To avoid closing active windows or losing unsaved drafts without consent, Magpie prompts you to choose:
   - **Restart automatically:** Gracefully quits `ChatGPT.app` and relaunches it with a debugging port enabled.
   - **Restart manually:** Leaves the running `ChatGPT.app` untouched.

> **Safety boundary:** Non-sign-in operations (`models`, `usage`, and `fetch` chat requests) only read and connect to an existing debugging port. They never launch, quit, or restart `ChatGPT.app` in the background.

## Provider Options

- **`instant_fallback` (Quota fallback to Instant):**
  - **Default:** `false` (disabled — no silent downgrade).
  - **When enabled (`true`):** If a request for a `pro` or `thinking` model receives a structured `model_cap_exceeded` refusal before any conversation ID or assistant activity occurs, the plugin automatically retries once with an available non-work-mode (`is_work_mode_model === false`) `-instant` model from the same version in your account's catalog.

## Three-Tier Debugging Port Resolution

1. **Explicit configuration or running process flag:** `CHATGPT_CDP_PORT`, `SIDECAR_CDP`, `CODEX_CDP_PORT`, or `--remote-debugging-port` on the running `ChatGPT.app` process.
2. **Automatic free high port on launch (`58000–65000`):** Scans `127.0.0.1` for an unoccupied TCP port when launching or restarting `ChatGPT.app`.
3. **Default fallback (`19333`):** Used when no explicit port or high port is selected.

## Limitations

- **Text-only (`tool_call: false`):** All models declare `tool_call: false` and text-only input/output. Requests with images, audio, files, or tool roles are rejected with HTTP `400` before any CDP call.
- **Serial concurrency (`maxConcurrency: 1`):** Requests are processed one at a time per account.
- **No automatic retry on unknown send state:** Once a conversation stream has started, any timeout, disconnect, or missing finished assistant message returns HTTP `502` with `X-Should-Retry: false` (or CLI exit code `3`) and is never automatically resent.

## License

[MIT](./LICENSE)
