import { defineMiddleware } from 'astro:middleware'

export const onRequest = defineMiddleware(async (_, next) => {
  const response = await next()

  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp')

  return response
})
