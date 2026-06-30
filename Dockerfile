# Docker RN Preview — Per-user Expo live preview container

FROM node:20-slim
WORKDIR /usr/src/app

# Pre-install Expo template with all deps (shared across users at build time)
RUN mkdir -p /expo-template
WORKDIR /expo-template
RUN npm init -y && npm install \
    expo@~52.0.0 \
    react@18.3.1 \
    react-native@0.76.7 \
    react-native-web@~0.19.13 \
    react-native-safe-area-context@~5.0.0 \
    react-native-screens@~4.10.0 \
    @react-navigation/native@^7.1.0 \
    @react-navigation/native-stack@^7.3.0

# Dereference all .bin/ symlinks in node_modules so they survive a copy to CIFS/SMB volumes.
# CIFS doesn't support symlinks, so npx expo breaks when .bin/expo is a dangling symlink.
# cp -rL copies actual file content instead of symlinks. We deref in a temp dir
# and swap back to keep a single clean copy.
RUN cp -rL node_modules node_modules_nosym && rm -rf node_modules && mv node_modules_nosym node_modules

# Workspace will be mounted at runtime: /workspace → NAS per-user dir
WORKDIR /usr/src/app
RUN mkdir -p /workspace

COPY scripts/ /usr/src/app/scripts/
RUN chmod +x /usr/src/app/scripts/start-preview.sh

ENV PORT=19006
EXPOSE 19006

# Start Expo web dev server, watching /workspace for changes
CMD ["/usr/src/app/scripts/start-preview.sh"]
