import type { SmsMessage } from '../../shared/types'
import type { MessageStore } from '../store'
import { translateBatch, type TranslateItem, type TranslateOptions } from './claude'

export interface QueueDeps {
  store: MessageStore
  /** Resolved fresh on every batch so settings changes take effect immediately. */
  options: () => TranslateOptions & { batchSize: number; enabled: boolean }
  onChanged: (messages: SmsMessage[]) => void
  onProgress: (pending: number) => void
}

/**
 * Serial batch translator. One request at a time on purpose: SMS arrives slowly,
 * and a single in-flight request keeps rate-limit behaviour predictable and
 * makes a failed batch easy to attribute.
 */
export class TranslationQueue {
  private queue: string[] = []
  private queued = new Set<string>()
  private running = false
  private stopped = false

  constructor(private readonly deps: QueueDeps) {}

  get pending(): number {
    return this.queue.length
  }

  enqueue(ids: string[]): void {
    let added = false
    for (const id of ids) {
      if (this.queued.has(id)) continue
      this.queued.add(id)
      this.queue.push(id)
      added = true
    }
    if (added) {
      this.deps.onProgress(this.queue.length)
      void this.drain()
    }
  }

  /** Re-run translation for messages that already have one (or failed). */
  requeue(ids: string[]): void {
    const reset = ids
      .filter((id) => this.deps.store.get(id))
      .map((id) => ({
        id,
        partial: { translationState: 'pending' as const, translationError: undefined },
      }))
    if (reset.length) this.deps.onChanged(this.deps.store.patchMany(reset))
    this.enqueue(reset.map((r) => r.id))
  }

  stop(): void {
    this.stopped = true
    this.queue = []
    this.queued.clear()
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true

    try {
      while (this.queue.length && !this.stopped) {
        const opts = this.deps.options()
        if (!opts.enabled || !opts.apiKey) break

        const batchIds = this.queue.splice(0, Math.max(1, opts.batchSize))
        for (const id of batchIds) this.queued.delete(id)
        this.deps.onProgress(this.queue.length)

        const items: TranslateItem[] = []
        for (const id of batchIds) {
          const message = this.deps.store.get(id)
          if (!message || !message.body.trim()) continue
          items.push({
            id,
            body: message.body,
            direction: message.direction,
            sender: message.contact || message.address,
          })
        }
        if (!items.length) continue

        try {
          const results = await translateBatch(items, opts)
          const byId = new Map(results.map((r) => [r.id, r]))
          const now = Date.now()

          const updates = items.map((item) => {
            const result = byId.get(item.id)
            if (!result) {
              return {
                id: item.id,
                partial: {
                  translationState: 'error' as const,
                  translationError: 'Claude returned no result for this message.',
                },
              }
            }
            return {
              id: item.id,
              partial: {
                translationState: 'done' as const,
                translationError: undefined,
                translation: {
                  text: result.translation,
                  sourceLang: result.sourceLanguage,
                  targetLang: opts.targetLanguage,
                  model: opts.model,
                  at: now,
                },
                analysis: opts.classify
                  ? {
                      category: result.category,
                      risk: result.risk,
                      summary: result.summary,
                      at: now,
                    }
                  : undefined,
              },
            }
          })

          this.deps.onChanged(this.deps.store.patchMany(updates))
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err)
          this.deps.onChanged(
            this.deps.store.patchMany(
              items.map((item) => ({
                id: item.id,
                partial: {
                  translationState: 'error' as const,
                  translationError: messageText,
                },
              })),
            ),
          )
          // Back off before the next batch so a persistent failure (bad key,
          // rate limit) does not burn through the whole queue instantly.
          await new Promise((resolve) => setTimeout(resolve, 5_000))
        }
      }
    } finally {
      this.running = false
      this.deps.onProgress(this.queue.length)
    }
  }
}
