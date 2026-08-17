import type { SmsMessage } from '../../shared/types'
import type { MessageStore } from '../store'
import {
  describeImageMessage,
  translateBatch,
  type ImageInput,
  type TranslateItem,
  type TranslateOptions,
} from './claude'

/** Media types the Messages API accepts for image blocks. */
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

export interface QueueDeps {
  store: MessageStore
  /** Resolved fresh on every batch so settings changes take effect immediately. */
  options: () => TranslateOptions & {
    batchSize: number
    enabled: boolean
    describeImages: boolean
  }
  /** Reads a downloaded attachment for the image path. Null when unavailable. */
  readImage: (file: string) => Buffer | null
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

  /** Downloaded, API-supported images attached to a message. */
  private imagesFor(message: SmsMessage): { input: ImageInput; partId: number }[] {
    const out: { input: ImageInput; partId: number }[] = []
    for (const attachment of message.attachments ?? []) {
      if (!attachment.file || attachment.error) continue
      if (!SUPPORTED_IMAGE_TYPES.has(attachment.contentType)) continue
      const bytes = this.deps.readImage(attachment.file)
      if (!bytes) continue
      out.push({
        partId: attachment.partId,
        input: {
          data: bytes.toString('base64'),
          mediaType: attachment.contentType as ImageInput['mediaType'],
        },
      })
    }
    return out
  }

  /** One request per picture message: describe, transcribe, translate, classify. */
  private async processPicture(
    id: string,
    opts: TranslateOptions & { describeImages: boolean },
  ): Promise<void> {
    const message = this.deps.store.get(id)
    if (!message) return
    const images = this.imagesFor(message)
    if (!images.length) return

    try {
      const result = await describeImageMessage(
        images.map((i) => i.input),
        message.body,
        opts,
      )
      const now = Date.now()
      const described = new Set(images.map((i) => i.partId))
      this.deps.onChanged(
        this.deps.store.patchMany([
          {
            id,
            partial: {
              translationState: 'done',
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
              attachments: (message.attachments ?? []).map((a) =>
                described.has(a.partId)
                  ? {
                      ...a,
                      description: [result.description, result.textInImage]
                        .filter((part) => part.trim())
                        .join('\n\n'),
                    }
                  : a,
              ),
            },
          },
        ]),
      )
    } catch (err) {
      this.deps.onChanged(
        this.deps.store.patchMany([
          {
            id,
            partial: {
              translationState: 'error',
              translationError: err instanceof Error ? err.message : String(err),
            },
          },
        ]),
      )
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
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
        const pictureIds: string[] = []
        for (const id of batchIds) {
          const message = this.deps.store.get(id)
          if (!message) continue

          // A picture message needs the image itself, so it takes its own
          // request instead of joining the text batch.
          if (opts.describeImages && this.imagesFor(message).length) {
            pictureIds.push(id)
            continue
          }
          if (!message.body.trim()) {
            // Nothing to translate and no picture to look at.
            this.deps.onChanged(
              this.deps.store.patchMany([
                { id, partial: { translationState: 'skipped' as const } },
              ]),
            )
            continue
          }
          items.push({
            id,
            body: message.body,
            direction: message.direction,
            sender: message.contact || message.address,
          })
        }

        for (const id of pictureIds) await this.processPicture(id, opts)
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
