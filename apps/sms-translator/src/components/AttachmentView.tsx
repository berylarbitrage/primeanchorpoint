import { useEffect, useState } from 'react'
import type { Attachment } from '../../shared/types'
import { errorText, sms } from '../lib/bridge'

interface Props {
  messageId: string
  attachment: Attachment
}

/** Cache data URLs per (message, part) so re-renders do not re-read from disk. */
const cache = new Map<string, string>()

/**
 * Renders one MMS attachment.
 *
 * Bytes are fetched on demand rather than stored with the message: keeping
 * base64 in the message log would bloat it enormously, and the page's CSP only
 * allows `data:` images, so a file path could not be used directly.
 */
export default function AttachmentView({ messageId, attachment }: Props) {
  const key = `${messageId}:${attachment.partId}`
  const [dataUrl, setDataUrl] = useState<string | null>(cache.get(key) ?? null)
  const [error, setError] = useState<string | null>(attachment.error ?? null)
  const isImage = attachment.contentType.startsWith('image/')

  useEffect(() => {
    if (!isImage || dataUrl || attachment.error || !attachment.file) return
    let cancelled = false
    void (async () => {
      try {
        const result = await sms.readAttachment(messageId, attachment.partId)
        if (cancelled) return
        if (result.dataUrl) {
          cache.set(key, result.dataUrl)
          setDataUrl(result.dataUrl)
        } else {
          setError(result.error ?? '无法读取附件。')
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, messageId, attachment.partId, attachment.file, attachment.error, dataUrl, isImage])

  if (error) {
    return <div className="attachment-note error">图片无法显示：{error}</div>
  }

  if (!isImage) {
    return (
      <div className="attachment-note">
        附件：{attachment.name || attachment.contentType}
        {attachment.bytes ? `（${Math.round(attachment.bytes / 1024)} KB）` : ''}
        <br />
        这个类型不在软件里显示，请到手机上查看。
      </div>
    )
  }

  if (!dataUrl) {
    return <div className="attachment-note">图片加载中…</div>
  }

  return (
    <figure className="attachment">
      <img src={dataUrl} alt={attachment.name || '短信图片'} />
      {attachment.description && (
        <figcaption>{attachment.description}</figcaption>
      )}
    </figure>
  )
}
