import cloudflare from '@astrojs/cloudflare'
import svelte from '@astrojs/svelte'
import { defineConfig } from 'astro/config'

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),

  integrations: [svelte()],

  vite: {
    optimizeDeps: {
      exclude: ['libav.js'],
    },
  },
})
