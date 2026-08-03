import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt', not 'autoUpdate' — a new service worker must wait for
      // PwaUpdatePrompt's explicit tap-to-reload instead of silently taking
      // over in the background. Registration is done manually via the
      // virtual:pwa-register/react hook (injectRegister: false below), so
      // there's a component in control of exactly when that happens.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'NovaCore',
        short_name: 'NovaCore',
        description: 'NovaCore — field data and finance tracking for Keywest Asphalt, by Vektor Systems',
        theme_color: '#0D1F3C',
        background_color: '#F8FAFC',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // clientsClaim, NOT skipWaiting — skipWaiting:true would make a new
        // worker activate the instant it installs, defeating the prompt
        // flow entirely. clientsClaim only changes what happens once a
        // worker DOES activate (still gated on the user's tap sending
        // SKIP_WAITING, see PwaUpdatePrompt.tsx): without it, an activated
        // worker never takes control of an already-open tab, so
        // navigator.serviceWorker.oncontrollerchange — what both this tab's
        // own reload listener and vite-plugin-pwa's internal one wait for —
        // never fires. That's the actual reason "tap to reload" did nothing:
        // not a wiring bug in the prompt, a missing activation step in the
        // generated worker. Confirmed by reading the built dist/sw.js: the
        // SKIP_WAITING message listener was already correctly injected, but
        // there was no clients.claim() anywhere in it.
        clientsClaim: true,
      },
    }),
  ],
})
