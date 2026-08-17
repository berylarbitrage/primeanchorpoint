import Anthropic from '@anthropic-ai/sdk'
import { CATEGORIES, type Category } from '../../shared/types'

export interface TranslateItem {
  id: string
  body: string
  direction: 'in' | 'out'
  sender: string
}

export interface TranslateResult {
  id: string
  sourceLanguage: string
  translation: string
  category: Category
  risk: number
  summary: string
}

export interface TranslateOptions {
  apiKey: string
  model: string
  targetLanguage: string
  classify: boolean
}

export interface ImageInput {
  /** Base64 data with no prefix. */
  data: string
  /** One of the media types the API accepts. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    text_in_image: { type: 'string' },
    source_language: { type: 'string' },
    translation: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    risk: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    summary: { type: 'string' },
  },
  required: [
    'description',
    'text_in_image',
    'source_language',
    'translation',
    'category',
    'risk',
    'summary',
  ],
  additionalProperties: false,
} as const

/**
 * Structured-output schema. Note the constraints the API does NOT support:
 * no `minimum`/`maximum`, no `minLength`/`maxLength`. `risk` therefore uses an
 * enum instead of a numeric range.
 */
const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source_language: { type: 'string' },
          translation: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          risk: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
          summary: { type: 'string' },
        },
        required: ['id', 'source_language', 'translation', 'category', 'risk', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    translation: { type: 'string' },
    source_language: { type: 'string' },
  },
  required: ['translation', 'source_language'],
  additionalProperties: false,
} as const

function systemPrompt(targetLanguage: string, classify: boolean): string {
  return [
    'You translate and triage SMS messages for a desktop inbox.',
    '',
    `Translate every message into ${targetLanguage}.`,
    '',
    'Translation rules:',
    `- If a message is already in ${targetLanguage}, copy it through unchanged.`,
    '- SMS is informal and abbreviated. Translate what the sender meant, not word by word.',
    '- Keep verification codes, order numbers, amounts, URLs, and phone numbers exactly as written.',
    '- Preserve line breaks. Do not add commentary, quotes, or a preamble.',
    '- Truncated or garbled messages: translate the readable part and leave the rest as-is.',
    '',
    classify
      ? [
          'Also classify each message:',
          '- category: what kind of message it is.',
          '- risk: 0 when clearly legitimate, 5 when it is almost certainly a scam or phishing attempt.',
          `  Weigh urgency pressure, unexpected links, requests for codes or credentials, and mismatched sender identity.`,
          `- summary: one short line in ${targetLanguage} saying what the message wants. Keep it under 20 words.`,
        ].join('\n')
      : [
          'Classification is off for this run. Still fill the fields:',
          'set category to "other", risk to 0, and summary to an empty string.',
        ].join('\n'),
    '',
    'Return one result per input message, with the id copied through verbatim.',
  ].join('\n')
}

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 3 })
}

function firstJson(response: Anthropic.Message): unknown {
  if (response.stop_reason === 'refusal') {
    throw new Error(
      'Claude declined to process this batch. Skip the offending message or retry it on its own.',
    )
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('The response was cut off. Lower the batch size in settings and retry.')
  }
  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Claude returned no text content.')
  return JSON.parse(block.text)
}

/** Translate (and optionally triage) a batch of messages in one request. */
export async function translateBatch(
  items: TranslateItem[],
  opts: TranslateOptions,
): Promise<TranslateResult[]> {
  if (!items.length) return []
  if (!opts.apiKey) throw new Error('No Anthropic API key configured.')

  const payload = items.map((item) => ({
    id: item.id,
    direction: item.direction === 'in' ? 'received' : 'sent',
    from: item.sender,
    text: item.body,
  }))

  const params = {
    model: opts.model,
    max_tokens: 8000,
    system: systemPrompt(opts.targetLanguage, opts.classify),
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: BATCH_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Messages to process:\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  }

  const response = await client(opts.apiKey).messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming,
  )

  const parsed = firstJson(response) as { results?: unknown }
  const results = Array.isArray(parsed.results) ? parsed.results : []

  const known = new Set(items.map((i) => i.id))
  const out: TranslateResult[] = []
  for (const entry of results as Record<string, unknown>[]) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!known.has(id)) continue
    const category = CATEGORIES.includes(entry.category as Category)
      ? (entry.category as Category)
      : 'other'
    const risk = Number(entry.risk)
    out.push({
      id,
      sourceLanguage: String(entry.source_language ?? ''),
      translation: String(entry.translation ?? ''),
      category,
      risk: Number.isFinite(risk) ? Math.min(5, Math.max(0, Math.round(risk))) : 0,
      summary: String(entry.summary ?? ''),
    })
  }
  return out
}

export interface DescribeResult {
  description: string
  textInImage: string
  sourceLanguage: string
  translation: string
  category: Category
  risk: number
  summary: string
}

/**
 * Handle a picture message: describe the image, transcribe any text in it, and
 * translate both that and the message body.
 *
 * Scam SMS is often just a screenshot, so reading the text out of the image is
 * the part that actually matters for screening — a description alone would miss
 * it. Runs one request per message rather than batching, because images are big.
 */
export async function describeImageMessage(
  images: ImageInput[],
  body: string,
  opts: TranslateOptions,
): Promise<DescribeResult> {
  if (!opts.apiKey) throw new Error('No Anthropic API key configured.')
  if (!images.length) throw new Error('No image supplied.')

  const system = [
    `You are triaging a picture message (MMS) for a desktop inbox. Answer in ${opts.targetLanguage}.`,
    '',
    '- description: one or two sentences on what the picture shows.',
    '- text_in_image: transcribe ALL text visible in the picture, verbatim, in its',
    '  original language. Keep codes, amounts, URLs, and phone numbers exact.',
    '  Empty string if there is no text.',
    `- translation: translate the message text and any text in the picture into`,
    `  ${opts.targetLanguage}. If both exist, put the message text first.`,
    '- source_language: the language of the text you translated.',
    opts.classify
      ? '- category / risk / summary: as for a text message. Screenshots of fake ' +
        'invoices, payment demands, login pages, and prize claims are common scam ' +
        'formats — weigh what the picture shows, not just the message text.'
      : '- set category to "other", risk to 0, and summary to an empty string.',
    '',
    'Return only the fields in the schema.',
  ].join('\n')

  const content: unknown[] = images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }))
  content.push({
    type: 'text',
    text: body.trim()
      ? `Message text sent with the picture:\n${body}`
      : 'The message has no text, only the picture.',
  })

  const params = {
    model: opts.model,
    max_tokens: 4000,
    system,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: DESCRIBE_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  }

  const response = await client(opts.apiKey).messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming,
  )

  const parsed = firstJson(response) as Record<string, unknown>
  const category = CATEGORIES.includes(parsed.category as Category)
    ? (parsed.category as Category)
    : 'other'
  const risk = Number(parsed.risk)
  return {
    description: String(parsed.description ?? ''),
    textInImage: String(parsed.text_in_image ?? ''),
    sourceLanguage: String(parsed.source_language ?? ''),
    translation: String(parsed.translation ?? ''),
    category,
    risk: Number.isFinite(risk) ? Math.min(5, Math.max(0, Math.round(risk))) : 0,
    summary: String(parsed.summary ?? ''),
  }
}

/** Translate an outgoing draft into the recipient's language. */
export async function translateDraft(
  text: string,
  opts: { apiKey: string; model: string; targetLanguage: string },
): Promise<{ text: string; sourceLanguage: string }> {
  if (!opts.apiKey) throw new Error('No Anthropic API key configured.')

  const params = {
    model: opts.model,
    max_tokens: 2000,
    system: [
      `Translate the user's SMS draft into ${opts.targetLanguage}.`,
      'Keep it natural for a text message: same tone, same level of formality, same length.',
      'Keep codes, numbers, names, and URLs exactly as written.',
      'Return only the translation — no notes, no alternatives, no quotes.',
    ].join('\n'),
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: DRAFT_SCHEMA },
    },
    messages: [{ role: 'user', content: text }],
  }

  const response = await client(opts.apiKey).messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming,
  )

  const parsed = firstJson(response) as { translation?: unknown; source_language?: unknown }
  return {
    text: String(parsed.translation ?? ''),
    sourceLanguage: String(parsed.source_language ?? ''),
  }
}
