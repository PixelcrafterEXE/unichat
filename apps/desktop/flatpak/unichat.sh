#!/bin/sh
# zypak makes Chromium's sandbox work inside Flatpak (provided by the Electron BaseApp).
exec zypak-wrapper /app/unichat/unichat --ozone-platform-hint=auto "$@"
