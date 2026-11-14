// Import first in any test file that loads src/ or spawns the CLI. These variables outrank the mock address a test
// passes through SIDECAR_CDP or plugin state, so a shell that exports one (a remote setup does) would point the tests
// at the real ChatGPT Desktop, where a send test can post a real message.
for (const name of ["CHATGPT_CDP_PORT", "SIDECAR_CDP", "CODEX_CDP_PORT"]) {
  delete process.env[name];
}
