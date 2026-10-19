import { ref } from 'vue'

const pendingPaths = ref<string[]>([])

export function useTagWorkshopLaunch() {
  function requestLaunch(filePaths: readonly string[]): void {
    const unique = [...new Set(filePaths.filter((filePath) => Boolean(filePath)))]
    if (unique.length === 0) return
    pendingPaths.value = unique
  }

  function consumePendingPaths(): string[] {
    const paths = pendingPaths.value
    pendingPaths.value = []
    return paths
  }

  return { pendingPaths, requestLaunch, consumePendingPaths }
}
