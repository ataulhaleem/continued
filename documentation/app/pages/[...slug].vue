<script setup lang="ts">
const route = useRoute()
const { data: page } = await useAsyncData(`page:${route.path}`, () => queryCollection('docs').path(route.path).first())
if (!page.value) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
}
useSeoMeta({ title: `${page.value.title} · Enclave`, description: page.value.description })
const { data: surround } = await useAsyncData(`surround:${route.path}`, () => queryCollectionItemSurroundings('docs', route.path, { fields: ['title', 'description'] }))
</script>

<template>
  <article class="page">
    <ContentRenderer v-if="page" :value="page" class="prose" />
    <nav v-if="surround" class="surround">
      <NuxtLink v-if="surround[0]" :to="surround[0].path" class="prev">← {{ surround[0].title }}</NuxtLink>
      <span v-else />
      <NuxtLink v-if="surround[1]" :to="surround[1].path" class="next">{{ surround[1].title }} →</NuxtLink>
    </nav>
  </article>
</template>
