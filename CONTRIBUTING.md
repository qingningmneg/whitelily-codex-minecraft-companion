# Contributing

Use a disposable Minecraft world for all behavior changes. Do not add API keys, launcher credentials, personal paths, save files, `config.toml`, `data/`, or `logs/` to Git. Run `npm ci`, format, typecheck, tests, build, and `./scripts/release-check.ps1 -SkipInstall` before proposing a change. Keep API-key fallback disabled and preserve confirmation and permanent-deny behavior.
