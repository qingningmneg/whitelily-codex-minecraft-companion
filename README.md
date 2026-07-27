# WhiteLily Codex Minecraft Companion

WhiteLily is a local Windows companion for Minecraft Java Edition. It joins a local/LAN world as a Mineflayer bot and lets the owner talk with 白百合 in the normal Minecraft chat box. WhiteLily runs Codex locally in the background; it is not a Minecraft client mod and does not replace PCL2.

## Supported first release

- Windows 11
- Plain Craft Launcher 2 (PCL2)
- Minecraft Java Edition 1.21.5
- A disposable local or LAN test world first

Do not start in an irreplaceable save. Test every update in a disposable world before allowing WhiteLily near valued builds, inventories, or multiplayer players.

## Authentication and cost boundary

Run `codex login` on this PC and sign in with ChatGPT. WhiteLily deliberately uses that locally authenticated Codex session, so it consumes your applicable shared ChatGPT/Codex usage or credits. Platform API-key authentication is separately billed, and WhiteLily intentionally has **no API-key fallback**. Availability and limits depend on your account and current product rules; nothing here promises unlimited or fixed use. See the official [Codex pricing](https://learn.chatgpt.com/docs/pricing.md) and [authentication documentation](https://learn.chatgpt.com/docs/auth).

## Install and operate

For a complete Chinese walkthrough, see the [Windows 11 + PCL2 installation guide](docs/installation-windows.zh-CN.md).

1. Install Node.js 24 and the Codex CLI, then run `codex login`.
2. Clone or unpack WhiteLily, open PowerShell in its folder, and run `./scripts/setup.ps1`.
3. Copy `config.example.toml` to `config.toml`; set `minecraft.host`, `minecraft.port`, and `owner_username`. Keep `allow_api_key_fallback = false`.
4. On the same Windows PC as WhiteLily, use PCL2 to launch Java 1.21.5 and open the intended world to LAN. This first release connects only through `127.0.0.1`; cross-device deployment is not supported.
5. Run `./scripts/doctor.ps1`, then `./scripts/start.ps1`. Stop with `./scripts/stop.ps1`.

For an update, stop WhiteLily, replace/update the files, run setup and doctor again, then repeat the disposable-world smoke test. To uninstall, stop it, delete this installation folder and its local `data/` and `logs/` folders; preserve `config.toml` only if you deliberately want to keep it.

Use [the Windows smoke-test checklist](docs/windows-smoke-test.md) before a real play session.

Architecture: [runtime boundary](docs/runtime-architecture.md).

## Chat commands and modes

Talk normally in Minecraft chat. Owner commands are `!mode friend`, `!mode balanced`, `!mode autonomous`, `!pause`, `!resume`, `!stop`, `!status`, `!allow <confirmation-id>`, `!deny <confirmation-id>`, `!memory show`, `!memory clear`, `!memory search <words>`, and `!memory forget <id>`. Friend mode chats and only acts after confirmation. Balanced mode can observe and propose limited work. Autonomous mode may carry out the explicitly configured, bounded activities; permanent denials still win.

WhiteLily never performs permanently denied actions, and it asks for confirmation before consequential actions or budget thresholds. `!stop` immediately cancels active behavior.

## Memory and privacy

Memory, logs, and crash state remain on this PC under ignored local folders. Only bounded, redacted game context is sent to the locally authenticated Codex session. `!memory clear` removes local companion memory. Never commit `config.toml`, `data/`, `logs/`, authentication files, saves, or launcher credentials.

## Troubleshooting

- **LAN port unavailable:** confirm the world is open to LAN, use the shown port, and allow the Java process through Windows Firewall.
- **Codex login fails:** run `codex login`, then `./scripts/doctor.ps1`; API-key login is rejected by design.
- **Bot cannot connect:** verify Minecraft version, host, port, username, and that the world/server accepts the bot.
- **Quota pause:** wait for the account’s applicable ChatGPT/Codex limit to reset or reduce usage; WhiteLily will not switch to Platform API billing.

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.
