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
    environments: {
      client: {
        build: {
          rolldownOptions: {
            output: {
              // libav depends on filenames _not_ being content-hashed!!
              // to get around this, we put the hash in a directory instead
              assetFileNames: (asset) =>
                asset.names.some((name) => name.startsWith('libav-'))
                  ? '_astro/libav.[hash]/[name][extname]'
                  : '_astro/[name].[hash][extname]',
            },
          },
        },
      },
    },
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },
})
