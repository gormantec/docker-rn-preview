# Docker RN Preview — Per-user Expo live preview container

FROM node:20-slim
WORKDIR /usr/src/app

# Pre-install Expo template with all deps (shared across users at build time)
RUN mkdir -p /expo-template
WORKDIR /expo-template
RUN npm init -y && npm install \
    expo@~52.0.0 \
    expo-asset@~11.0.0 \
    react@18.3.1 \
    react-native@0.76.7 \
    react-native-web@~0.19.13 \
    @expo/metro-runtime@~4.0.1 \
    react-native-safe-area-context@~5.0.0 \
    react-native-screens@~4.10.0 \
    @react-navigation/native@^7.1.0 \
    @react-navigation/native-stack@^7.3.0 \
    typescript@~5.3.3 \
    @types/react@~18.3.12

# Dereference all .bin/ symlinks
RUN cp -rL node_modules node_modules_nosym && rm -rf node_modules && mv node_modules_nosym node_modules

WORKDIR /usr/src/app
RUN mkdir -p /workspace/current

COPY src/ ./src/
COPY scripts/ /usr/src/app/scripts/
RUN chmod +x /usr/src/app/scripts/start-preview.sh

ENV PORT=19006
ENV FILE_API_PORT=9091
EXPOSE 19006 9091

CMD ["/usr/src/app/scripts/start-preview.sh"]
