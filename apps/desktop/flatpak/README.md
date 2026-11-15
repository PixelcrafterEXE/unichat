# UniChat Flatpak

Built by the `flatpak` job of `.github/workflows/release.yml` and attached to every GitHub release as `unichat-desktop-<version>.flatpak`.

Install the latest release:
```
gh release download --pattern '*.flatpak' --dir /tmp/unichat-fp && \
flatpak install --user -y --bundle /tmp/unichat-fp/unichat-desktop-*.flatpak && flatpak run org.unichat.desktop
```
(The bundle needs the `org.freedesktop.Platform//25.08` runtime; `flatpak install --user flathub org.freedesktop.Platform//25.08` if missing.)

- Packages the unpacked Electron app (`apps/desktop/dist/linux-unpacked`) on the Electron BaseApp; started through `zypak-wrapper`.
- Data lives in `~/.var/app/org.unichat.desktop/config/unimsg` (the app uses `$XDG_CONFIG_HOME/unimsg`).
- Permissions: network, Wayland/X11, GPU, audio, notifications, tray, Secret Service (archive key; otherwise the app uses its 0600 key file), `xdg-download`.
- Local build (optional): `./build.sh`.
