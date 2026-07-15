<script setup lang="ts">
import { onMounted, ref } from 'vue'

/**
 * The one gate in front of everything (ITLK-13). Single trusted user, single field.
 *
 * The `auth.global.ts` guard skips this route, so it renders for the logged-out — but a
 * *logged-in* visitor landing here (a stale bookmark) should bounce straight back in, which
 * the mount check below does. On success we honour `?redirect=` so a deep link that kicked
 * someone to login returns them where they were headed.
 */

const route = useRoute()

const password = ref('')
const error = ref<string | null>(null)
const submitting = ref(false)

function destination(): string {
  const redirect = route.query.redirect
  // Only ever an in-app path — an absolute/protocol-relative value would be an open-redirect.
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')) {
    return redirect
  }
  return '/'
}

onMounted(async () => {
  const { authenticated } = await $fetch<{ authenticated: boolean }>('/api/auth/session')
  if (authenticated) await navigateTo(destination())
})

async function submit() {
  if (submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { password: password.value } })
    await navigateTo(destination())
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode
    error.value =
      status === 500
        ? 'Authentication is not configured on this server.'
        : 'That password was not accepted.'
    password.value = ''
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login">
    <div class="card panel">
      <div class="label">Sign in</div>
      <h1>Interlock</h1>
      <p class="muted lede">Signal-grade tracking for city &amp; state legislation.</p>

      <form @submit.prevent="submit">
        <label class="label field-label" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          autofocus
          :disabled="submitting"
        />

        <p v-if="error" class="error">{{ error }}</p>

        <button class="primary" type="submit" :disabled="submitting || password.length === 0">
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
/* Centre the card in the viewport height the shell leaves us, and keep it narrow — a single
   field shouldn't stretch to the 1180px shell width. */
.login {
  display: flex;
  justify-content: center;
  padding-top: 12vh;
}
.panel {
  width: 100%;
  max-width: 380px;
}
.panel h1 {
  margin: 6px 0 4px;
  font-size: 30px;
}
.lede {
  margin: 0 0 22px;
  font-size: 14px;
}
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field-label {
  margin-bottom: -2px;
}
input {
  width: 100%;
}
button {
  margin-top: 6px;
}
</style>
