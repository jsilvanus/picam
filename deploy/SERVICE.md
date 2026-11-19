# systemd user unit

`picam.service` runs picam as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/picam`
- environment file: `~/apps/picam.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/picam.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now picam
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status picam`, `journalctl --user -u picam -f`.
