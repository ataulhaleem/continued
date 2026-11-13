import { defineCollection, defineContentConfig, z } from '@nuxt/content'

// One collection: every Markdown/MDC file under content/ is a page. Numeric prefixes on file
// and folder names (1.getting-started.md) order the navigation and are stripped from URLs.
export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: 'page',
      source: '**/*.md',
      schema: z.object({
        description: z.string().optional(),
        navigation: z.union([z.boolean(), z.object({ title: z.string().optional(), icon: z.string().optional() })]).optional()
      })
    })
  }
})
