# Docker RN Preview — Per-user Expo live preview container
# Default project pre-built at /workspace/my-project with all deps installed.
# npx create-expo-app is tried at runtime for new projects but falls back to
# copying the pre-built template if it times out.

FROM node:20-slim
WORKDIR /usr/src/app

# Pre-build the default "my-project" at build time (fast, no runtime npm needed)
RUN mkdir -p /workspace/my-project
WORKDIR /workspace/my-project
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
# Fix package.json for Expo — must point to expo/AppEntry.js
RUN node -e "const p=require('./package.json');p.main='node_modules/expo/AppEntry.js';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2))"
RUN echo '{"expo":{"name":"Preview","slug":"preview","version":"0.0.1","platforms":["web"],"web":{"bundler":"metro"}}}' > app.json
RUN echo '{"extends":"expo/tsconfig.base","compilerOptions":{"strict":true}}' > tsconfig.json
RUN echo "import React from 'react'; import { View, Text, SafeAreaView, StyleSheet } from 'react-native'; export default function App() { return <SafeAreaView style={s.container}><View style={s.content}><Text style={s.title}>Preview Ready</Text><Text style={s.sub}>Build on the canvas to see your app here.</Text></View></SafeAreaView>; } const s = StyleSheet.create({ container: { flex:1, backgroundColor:'#fff' }, content: { flex:1, alignItems:'center', justifyContent:'center', padding:24 }, title: { fontSize:20, fontWeight:'600', color:'#16191f', marginBottom:8 }, sub: { fontSize:14, color:'#8d99a8', textAlign:'center' } });" > App.tsx

WORKDIR /usr/src/app
COPY src/ ./src/
COPY scripts/ /usr/src/app/scripts/
RUN chmod +x /usr/src/app/scripts/start-preview.sh

ENV PORT=19006
ENV FILE_API_PORT=9091
ENV WORKSPACE_BASE=/workspace
EXPOSE 19006 9091

CMD ["/usr/src/app/scripts/start-preview.sh"]
