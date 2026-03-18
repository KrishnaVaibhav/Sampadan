const RECENTS_KEY = 'sampadan.recentPaths'

export function loadRecentPaths(): string[] {
  try {
    const stored = localStorage.getItem(RECENTS_KEY)
    if (!stored) {
      return []
    }

    return JSON.parse(stored) as string[]
  } catch {
    return []
  }
}

export function rememberRecentPath(existing: string[], path: string): string[] {
  const next = [path, ...existing.filter((entry) => entry !== path)].slice(0, 7)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  return next
}
