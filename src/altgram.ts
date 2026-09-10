/**
 * AltGram Bot API client for Stars NFT Shop.
 */

const ALTGRAM_API_URL = process.env.ALTGRAM_API_URL || 'http://188.134.95.254:2610'
const BOT_TOKEN = process.env.BOT_TOKEN || ''

export type TgEntity = {
  type: string
  offset: number
  length: number
  url?: string
}

export type TgInlineKeyboardMarkup = {
  inline_keyboard: { text: string; callback_data?: string; url?: string; pay?: boolean }[][]
}

export interface TgResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
}

async function tgFetch<T>(method: string, body: Record<string, unknown>) {
  const url = `${ALTGRAM_API_URL}/bot${BOT_TOKEN}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as TgResponse<T>
  if (!data.ok) {
    console.error(`[altgram] ${method} failed:`, data.error_code, data.description)
  }
  return data
}

export function md(text: string): { text: string; entities: TgEntity[] } {
  const entities: TgEntity[] = []
  let plain = ''
  let i = 0
  const push = (type: string, raw: string) => {
    const start = plain.length
    plain += raw
    entities.push({ type, offset: start, length: raw.length })
  }
  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpMatchArray | null = null
    if ((m = rest.match(/^\*\*([^*]+)\*\*/))) { push('bold', m[1]); i += m[0].length }
    else if ((m = rest.match(/^`([^`]+)`/))) { push('code', m[1]); i += m[0].length }
    else if ((m = rest.match(/^\*([^*]+)\*/))) { push('italic', m[1]); i += m[0].length }
    else { plain += text[i]; i++ }
  }
  return { text: plain, entities }
}

export const altgram = {
  async getMe() {
    return tgFetch<{ id: number; username: string; first_name: string; is_bot: boolean }>('getMe', {})
  },

  async sendMessage(params: {
    chat_id: number | string
    text: string
    entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
    reply_to_message_id?: number
    disable_web_page_preview?: boolean
  }) {
    const body: Record<string, unknown> = { chat_id: params.chat_id, text: params.text }
    if (params.entities?.length) body.entities = params.entities
    if (params.reply_markup) body.reply_markup = params.reply_markup
    if (params.reply_to_message_id) body.reply_to_message_id = params.reply_to_message_id
    if (params.disable_web_page_preview) body.disable_web_page_preview = true
    return tgFetch<{ message_id: number }>('sendMessage', body)
  },

  async sendPhoto(params: {
    chat_id: number | string
    photo: string
    caption?: string
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    const body: Record<string, unknown> = { chat_id: params.chat_id, photo: params.photo }
    if (params.caption) body.caption = params.caption
    if (params.reply_markup) body.reply_markup = params.reply_markup
    return tgFetch<{ message_id: number }>('sendPhoto', body)
  },

  async sendInvoice(params: {
    chat_id: number | string
    title: string
    description: string
    payload: string
    currency: 'XTR'
    prices: { label: string; amount: number }[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    return tgFetch<{ message_id: number }>('sendInvoice', params)
  },

  async answerPreCheckoutQuery(params: { pre_checkout_query_id: string; ok: boolean; error_message?: string }) {
    return tgFetch<boolean>('answerPreCheckoutQuery', params)
  },

  async answerCallbackQuery(params: { callback_query_id: string; text?: string; show_alert?: boolean }) {
    return tgFetch<boolean>('answerCallbackQuery', params)
  },

  async setMyCommands(commands: { command: string; description: string }[]) {
    return tgFetch<boolean>('setMyCommands', { commands })
  },

  async deleteWebhook() {
    return tgFetch<boolean>('deleteWebhook', {})
  },

  async getUpdates(params: { offset: number; timeout: number; allowed_updates?: string[] }) {
    return tgFetch<unknown[]>('getUpdates', params)
  },

  async sendGift(params: { user_id: number; gift_id: string; text?: string }) {
    const body: Record<string, unknown> = { user_id: params.user_id, gift_id: params.gift_id }
    if (params.text) body.text = params.text
    return tgFetch<boolean>('sendGift', body)
  },

  async getAvailableGifts() {
    return tgFetch<{ count: number; gifts: Array<{ id: string; star_count: number; sticker: { emoji: string; file_id: string } }> }>('getAvailableGifts', {})
  },
}
