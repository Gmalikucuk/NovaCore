import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
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
        theme_color: '#0D1B2A',
        background_color: '#F4F7FA',
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
      },
    }),
  ],
})
