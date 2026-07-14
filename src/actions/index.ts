import { ActionError, defineAction } from 'astro:actions'
import { z } from 'astro/zod'

const tenorViewUrl = z.url().refine((urlString) => {
  try {
    const u = new URL(urlString)
    return u.hostname === 'tenor.com' && u.pathname.startsWith('/view/')
  } catch {
    return false
  }
})

export const server = {
  tenorToMediaUrl: defineAction({
    input: z.object({
      url: tenorViewUrl,
    }),
    handler: async ({ url }) => {
      let tenorPageResponse: Response
      let tenorPageHtml: string

      try {
        tenorPageResponse = await fetch(url)
      } catch (e) {
        console.log('Backend request to Tenor failed', e)
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Backend request to Tenor failed`,
        })
      }

      if (!tenorPageResponse.ok) {
        if (tenorPageResponse.status === 404) {
          throw new ActionError({
            code: 'NOT_FOUND',
            message: 'Tenor returned 404 for given URL',
          })
        } else {
          throw new ActionError({
            code: 'SERVICE_UNAVAILABLE',
            message: `Request to Tenor returned bad response code: ${tenorPageResponse.status} (${tenorPageResponse.statusText})`,
          })
        }
      }

      try {
        tenorPageHtml = await tenorPageResponse.text()
      } catch (e) {
        console.error('Getting Tenor response body failed', e)
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Getting Tenor response body failed',
        })
      }

      const jsonTag = tenorPageHtml.match(
        /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/is,
      )
      if (jsonTag) {
        let j: { video: { contentUrl: string } }
        try {
          j = JSON.parse(jsonTag[1])
        } catch {
          throw new ActionError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Parsing JSON-LD data failed',
          })
        }

        const videoContentUrl = j?.video?.contentUrl
        if (videoContentUrl) {
          return videoContentUrl
        } else {
          throw new ActionError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'JSON-LD returned by Tenor was in an unexpected format',
          })
        }
      } else {
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Extracting data from Tenor URL failed',
        })
      }
    },
  }),
}
