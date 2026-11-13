<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'
defineProps<{ items: ContentNavigationItem[]; depth?: number }>()
const route = useRoute()
const active = (p: string) => route.path === p || route.path === p + '/'
</script>

<template>
  <ul class="nav" :class="`d${depth ?? 0}`">
    <li v-for="item in items" :key="item.path">
      <NuxtLink v-if="item.page !== false" :to="item.path" :class="{ active: active(item.path) }">{{ item.title }}</NuxtLink>
      <span v-else class="group">{{ item.title }}</span>
      <NavTree v-if="item.children?.length && !(item.children.length === 1 && item.children[0].path === item.path)" :items="item.children.filter(c => c.path !== item.path)" :depth="(depth ?? 0) + 1" />
    </li>
  </ul>
</template>
