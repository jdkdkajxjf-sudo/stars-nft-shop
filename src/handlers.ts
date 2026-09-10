/**
 * Stars NFT Shop — массовая покупка NFT (gifts) с оплатой через Telegram Stars.
 *
 * Flow:
 * 1. /start → каталог категорий NFT
 * 2. Выбор категории → список NFT
 * 3. Выбор NFT → выбор количества
 * 4. Подтверждение → инвойс
 * 5. Оплата → доставка gifts
 */

import { db } from './db'
import { altgram, md, type TgInlineKeyboardMarkup } from './altgram'
import type { TgCallbackQuery, TgMessage, TgUpdate, TgUser } from './types'

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'xyz').toLowerCase()

// NFT каталог — категории и продукты
interface NftItem {
  slug: string
  name: string
  emoji: string
  priceStars: number
  giftIds: string[]
  category: string
}

const NFT_CATALOG: NftItem[] = [
  // Обычные
  { slug: 'tg-gift-15', name: 'Подарок 15⭐', emoji: '🎁', priceStars: 15, giftIds: ['9000000000000001', '9000000000000006'], category: 'basic' },
  { slug: 'gift-75', name: 'Подарок 75⭐', emoji: '🎁', priceStars: 75, giftIds: ['9000000000000031', '9000000000000043'], category: 'basic' },
  { slug: 'tg-gift-100', name: 'Подарок 100⭐', emoji: '🎁', priceStars: 100, giftIds: ['9000000000000010', '9000000000000011', '9000000000000012', '9000000000000036', '9000000000000039', '9000000000000047'], category: 'basic' },
  // NFT
  { slug: 'scared-cat', name: 'Scared Cat', emoji: '🐱', priceStars: 25, giftIds: ['9000000000000007', '9000000000000028', '9000000000000030'], category: 'nft' },
  { slug: 'cake-50', name: 'Birthday Cake', emoji: '🎂', priceStars: 50, giftIds: ['9000000000000005', '9000000000000008', '9000000000000009', '9000000000000013', '9000000000000033'], category: 'nft' },
]

const CATEGORIES = [
  { id: 'basic', name: '🎁 Обычные', desc: 'Обычные TG подарки 15-100⭐' },
  { id: 'nft', name: '🖼️ NFT', desc: 'Уникальные NFT — коты, торты' },
]

function getNftBySlug(slug: string): NftItem | null {
  return NFT_CATALOG.find(n => n.slug === slug) ?? null
}

function getNftsByCategory(cat: string): NftItem[] {
  return NFT_CATALOG.filter(n => n.category === cat)
}

const QUANTITY_OPTIONS = [1, 5, 10, 25, 50, 100]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function send(chatId: number | string, text: string, kb?: TgInlineKeyboardMarkup, replyTo?: number) {
  const { text: plain, entities } = md(text)
  return altgram.sendMessage({ chat_id: chatId, text: plain, entities, reply_markup: kb, reply_to_message_id: replyTo })
}

async function upsertUser(from: TgUser) {
  const isAdmin = from.username?.toLowerCase() === ADMIN_USERNAME
  const existing = await db.user.findUnique({ where: { tgId: String(from.id) } })
  if (!existing) {
    return db.user.create({
      data: { tgId: String(from.id), username: from.username?.toLowerCase() ?? null, firstName: from.first_name ?? null, isAdmin }
    })
  }
  return db.user.update({
    where: { tgId: String(from.id) },
    data: { username: from.username?.toLowerCase() ?? null, firstName: from.first_name ?? null, ...(isAdmin || existing.isAdmin ? { isAdmin: true } : {}) }
  })
}

/* ------------------------------------------------------------------ */
/* Update dispatch                                                     */
/* ------------------------------------------------------------------ */

export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    // Pre-checkout
    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query
      console.log(`[pre_checkout] id=${pcq.id} user=${pcq.from.id}`)
      try {
        await altgram.answerPreCheckoutQuery({ pre_checkout_query_id: pcq.id, ok: true })
      } catch (e) {
        console.error('[pre_checkout] error:', e)
      }
      return
    }

    if (update.callback_query) {
      await handleCallback(update.callback_query)
      return
    }

    const msg = update.message
    if (!msg) return

    if (msg.successful_payment) {
      await handlePayment(msg)
      return
    }

    if (msg.text) {
      await handleText(msg)
    }
  } catch (e) {
    console.error('[handler] error:', e)
  }
}

async function handleText(msg: TgMessage) {
  const from = msg.from
  if (!from || from.is_bot) return
  if (msg.chat.type !== 'private') return

  const user = await upsertUser(from)
  const text = (msg.text ?? '').trim()
  const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? ''

  console.log(`[msg] @${from.username ?? from.id}: ${text.slice(0, 80)}`)

  switch (cmd) {
    case '/start':
      await sendCatalog(msg.chat.id)
      break
    case '/help':
      await send(msg.chat.id,
        [
          '🛍️ **NFT Shop** — массовая покупка подарков',
          '',
          '**Как купить:**',
          '1. Выбери категорию NFT',
          '2. Выбери NFT',
          '3. Выбери количество (1-100)',
          '4. Оплати через Telegram Stars',
          '5. Получи gifts автоматически!',
          '',
          '**Команды:**',
          '• /start — каталог',
          '• /cart — корзина',
          '• /orders — история покупок',
          '• /clearcart — очистить корзину',
        ].join('\n'))
      break
    case '/cart':
      await showCart(msg.chat.id, user)
      break
    case '/orders':
      await showOrders(msg.chat.id, user)
      break
    case '/clearcart':
      await db.cartItem.deleteMany({ where: { userId: user.tgId } })
      await send(msg.chat.id, '🧹 Корзина очищена!')
      break
    default:
      if (cmd.startsWith('/')) {
        await send(msg.chat.id, '🤔 Используй /start для каталога')
      }
  }
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

async function sendCatalog(chatId: number) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: CATEGORIES.map(cat => [{
      text: cat.name,
      callback_data: `cat:${cat.id}`,
    }]),
  }
  await send(chatId,
    [
      '🛍️ **NFT Shop**',
      '',
      'Выбери категорию NFT:',
    ].join('\n'), kb)
}

async function showCategory(chatId: number, catId: string) {
  const cat = CATEGORIES.find(c => c.id === catId)
  if (!cat) return

  const nfts = getNftsByCategory(catId)
  if (nfts.length === 0) {
    await send(chatId, '❌ Нет NFT в этой категории')
    return
  }

  const lines = nfts.map(n => `${n.emoji} **${n.name}** — ${n.priceStars}⭐`)
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      ...nfts.map(n => [{ text: `${n.emoji} ${n.name} — ${n.priceStars}⭐`, callback_data: `nft:${n.slug}` }]),
      [{ text: '🔙 Назад', callback_data: 'catalog' }],
    ],
  }
  await send(chatId,
    [
      `${cat.name}`,
      cat.desc,
      '',
      ...lines,
    ].join('\n'), kb)
}

/* ------------------------------------------------------------------ */
/* NFT detail + quantity                                              */
/* ------------------------------------------------------------------ */

async function showNft(chatId: number, slug: string) {
  const nft = getNftBySlug(slug)
  if (!nft) {
    await send(chatId, '❌ NFT не найден')
    return
  }

  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      QUANTITY_OPTIONS.slice(0, 3).map(q => ({ text: `${q} шт`, callback_data: `qty:${slug}:${q}` })),
      QUANTITY_OPTIONS.slice(3).map(q => ({ text: `${q} шт`, callback_data: `qty:${slug}:${q}` })),
      [
        { text: '➕ В корзину', callback_data: `addcart:${slug}` },
        { text: '🔙 Назад', callback_data: `cat:${nft.category}` },
      ],
    ],
  }

  await send(chatId,
    [
      `${nft.emoji} **${nft.name}**`,
      '',
      `💰 Цена: ${nft.priceStars}⭐ за штуку`,
      `📊 Доступно: 100+ шт`,
      '',
      'Выбери количество для покупки:',
      'Или добавь в корзину и купи несколько разных NFT',
    ].join('\n'), kb)
}

/* ------------------------------------------------------------------ */
/* Buy directly (without cart)                                        */
/* ------------------------------------------------------------------ */

async function buyNow(chatId: number, userId: string, slug: string, qty: number) {
  const nft = getNftBySlug(slug)
  if (!nft) return

  const total = nft.priceStars * qty
  const orderId = Math.random().toString(36).slice(2, 12)

  // Создаём заказ
  const order = await db.order.create({
    data: {
      userId,
      totalStars: total,
      itemsJson: JSON.stringify([{ slug: nft.slug, name: nft.name, emoji: nft.emoji, price: nft.priceStars, qty }]),
      status: 'pending',
    },
  })

  await send(chatId,
    [
      `🧾 **Заказ #${order.id.slice(-8)}**`,
      '',
      `${nft.emoji} ${nft.name} × ${qty}`,
      `💰 Итого: **${total}⭐**`,
      '',
      'Нажми «Оплатить» для оплаты через Telegram Stars:',
    ].join('\n'))

  // Создаём инвойс
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: `💳 Оплатить ${total}⭐`, pay: true, callback_data: `pay:${order.id}` }]],
  }

  const res = await altgram.sendInvoice({
    chat_id: Number(userId),
    title: `${nft.emoji} ${nft.name} × ${qty}`,
    description: `Покупка ${qty} × ${nft.name} (${nft.priceStars}⭐ каждый). Всего: ${total}⭐`,
    payload: `order:${order.id}`,
    currency: 'XTR',
    prices: [{ label: `${nft.name} × ${qty}`, amount: total }],
    reply_markup: kb,
  })

  if (res.ok && res.result) {
    await db.order.update({ where: { id: order.id }, data: { invoiceMsgId: String(res.result.message_id) } })
  } else {
    await send(chatId, '❌ Не удалось создать инвойс. Попробуй позже.')
  }
}

/* ------------------------------------------------------------------ */
/* Payment handler                                                     */
/* ------------------------------------------------------------------ */

async function handlePayment(msg: TgMessage) {
  const sp = msg.successful_payment
  if (!sp) return

  const payload = sp.invoice_payload
  if (!payload || !payload.startsWith('order:')) return

  const orderId = payload.slice(6)
  const order = await db.order.findUnique({ where: { id: orderId } })
  if (!order) {
    console.error('[payment] order not found:', orderId)
    return
  }

  if (order.status === 'fulfilled') {
    await send(msg.chat.id, '✅ Этот заказ уже выполнен!')
    return
  }

  // Обновляем статус
  await db.order.update({
    where: { id: order.id },
    data: {
      status: 'paid',
      paymentChargeId: sp.telegram_payment_charge_id ?? null,
      paidAt: new Date(),
    },
  })

  await send(msg.chat.id, `✅ Оплата получена! Доставляю NFT...`)

  // Доставляем gifts
  const items = JSON.parse(order.itemsJson) as Array<{ slug: string; name: string; emoji: string; price: number; qty: number }>
  let totalSent = 0
  let totalFailed = 0
  const details: string[] = []

  for (const item of items) {
    const nft = getNftBySlug(item.slug)
    if (!nft) {
      details.push(`❌ ${item.emoji} ${item.name} — не найден`)
      totalFailed += item.qty
      continue
    }

    let sent = 0
    let failed = 0

    for (let i = 0; i < item.qty; i++) {
      let giftDelivered = false
      for (const giftId of nft.giftIds) {
        const res = await altgram.sendGift({
          user_id: Number(order.userId),
          gift_id: giftId,
        })
        if (res.ok) {
          giftDelivered = true
          break
        }
      }
      if (giftDelivered) sent++
      else failed++
    }

    totalSent += sent
    totalFailed += failed
    if (sent > 0) details.push(`✅ ${item.emoji} ${item.name} × ${sent}`)
    if (failed > 0) details.push(`❌ ${item.emoji} ${item.name} × ${failed} (не доставлено)`)
  }

  // Обновляем заказ
  await db.order.update({
    where: { id: order.id },
    data: {
      status: totalFailed === 0 ? 'fulfilled' : 'partial',
      fulfilledAt: new Date(),
    },
  })

  await send(msg.chat.id,
    [
      `📦 **Заказ #${order.id.slice(-8)} выполнен!**`,
      '',
      ...details,
      '',
      `✅ Доставлено: ${totalSent}`,
      totalFailed > 0 ? `❌ Не удалось: ${totalFailed}` : '',
      '',
      'Спасибо за покупку! 🎉',
    ].filter(Boolean).join('\n'))
}

/* ------------------------------------------------------------------ */
/* Cart                                                                */
/* ------------------------------------------------------------------ */

async function showCart(chatId: number, user: { tgId: string }) {
  const items = await db.cartItem.findMany({ where: { userId: user.tgId } })
  if (items.length === 0) {
    await send(chatId, '🛒 Корзина пуста. Выбери NFT через /start')
    return
  }

  let total = 0
  const lines: string[] = []
  for (const item of items) {
    const nft = getNftBySlug(item.productSlug)
    if (!nft) continue
    const subtotal = nft.priceStars * item.quantity
    total += subtotal
    lines.push(`${nft.emoji} ${nft.name} × ${item.quantity} = ${subtotal}⭐`)
  }

  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: `💳 Оплатить всё (${total}⭐)`, callback_data: `checkout` }],
      [{ text: '🧹 Очистить', callback_data: `clearcart` }],
    ],
  }

  await send(chatId,
    [
      '🛒 **Корзина**',
      '',
      ...lines,
      '',
      `💰 **Итого: ${total}⭐**`,
    ].join('\n'), kb)
}

async function addToCart(userId: string, slug: string) {
  const existing = await db.cartItem.findUnique({
    where: { userId_productSlug: { userId, productSlug: slug } },
  })
  if (existing) {
    await db.cartItem.update({
      where: { id: existing.id },
      data: { quantity: { increment: 1 } },
    })
  } else {
    await db.cartItem.create({
      data: { userId, productSlug: slug, quantity: 1 },
    })
  }
}

async function checkout(chatId: number, userId: string) {
  const cartItems = await db.cartItem.findMany({ where: { userId } })
  if (cartItems.length === 0) {
    await send(chatId, '🛒 Корзина пуста')
    return
  }

  const itemsJson: Array<{ slug: string; name: string; emoji: string; price: number; qty: number }> = []
  let total = 0
  let firstNftName = ''
  let firstEmoji = ''

  for (const ci of cartItems) {
    const nft = getNftBySlug(ci.productSlug)
    if (!nft) continue
    itemsJson.push({ slug: nft.slug, name: nft.name, emoji: nft.emoji, price: nft.priceStars, qty: ci.quantity })
    total += nft.priceStars * ci.quantity
    if (!firstNftName) {
      firstNftName = nft.name
      firstEmoji = nft.emoji
    }
  }

  if (itemsJson.length === 0) {
    await send(chatId, '❌ Корзина пуста или NFT не найдены')
    return
  }

  const order = await db.order.create({
    data: {
      userId,
      totalStars: total,
      itemsJson: JSON.stringify(itemsJson),
      status: 'pending',
    },
  })

  // Очищаем корзину
  await db.cartItem.deleteMany({ where: { userId } })

  const itemCount = itemsJson.reduce((s, i) => s + i.qty, 0)
  const summary = itemsJson.map(i => `${i.emoji} ${i.name} ×${i.qty}`).join(', ')

  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: `💳 Оплатить ${total}⭐`, pay: true, callback_data: `pay:${order.id}` }]],
  }

  await altgram.sendInvoice({
    chat_id: Number(userId),
    title: `🛍️ Заказ NFT (${itemCount} шт)`,
    description: summary.slice(0, 200),
    payload: `order:${order.id}`,
    currency: 'XTR',
    prices: [{ label: `NFT × ${itemCount}`, amount: total }],
    reply_markup: kb,
  })
}

/* ------------------------------------------------------------------ */
/* Orders history                                                      */
/* ------------------------------------------------------------------ */

async function showOrders(chatId: number, user: { tgId: string }) {
  const orders = await db.order.findMany({
    where: { userId: user.tgId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  if (orders.length === 0) {
    await send(chatId, '📭 Нет заказов. Купи первый через /start!')
    return
  }

  const lines = orders.map(o => {
    const items = JSON.parse(o.itemsJson) as Array<{ emoji: string; name: string; qty: number }>
    const itemsStr = items.map(i => `${i.emoji}×${i.qty}`).join(' ')
    const status = o.status === 'fulfilled' ? '✅' : o.status === 'paid' ? '⏳' : o.status === 'partial' ? '⚠️' : '❌'
    const date = o.createdAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    return `${status} ${date} — ${o.totalStars}⭐ — ${itemsStr}`
  })

  await send(chatId, `📋 **Последние заказы:**\n\n${lines.join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* Callback handler                                                    */
/* ------------------------------------------------------------------ */

async function handleCallback(cq: TgCallbackQuery) {
  const data = cq.data ?? ''
  const from = cq.from
  if (!from) return

  let act = data
  let arg1 = ''
  let arg2 = ''
  if (data.includes(':')) {
    const parts = data.split(':')
    act = parts[0] ?? ''
    arg1 = parts[1] ?? ''
    arg2 = parts[2] ?? ''
  }

  const user = await upsertUser(from)
  const chatId = cq.message?.chat.id ?? from.id

  console.log(`[callback] data="${data}" → act="${act}" arg1="${arg1}" arg2="${arg2}"`)

  try { await altgram.answerCallbackQuery({ callback_query_id: cq.id }) } catch {}

  const fakeMsg: TgMessage = {
    message_id: 0,
    from,
    chat: { id: chatId, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text: '',
  }

  if (act === 'catalog') {
    await sendCatalog(chatId)
  } else if (act === 'cat') {
    await showCategory(chatId, arg1)
  } else if (act === 'nft') {
    await showNft(chatId, arg1)
  } else if (act === 'qty') {
    const qty = parseInt(arg2)
    if (!isNaN(qty) && qty > 0) {
      await buyNow(chatId, user.tgId, arg1, qty)
    }
  } else if (act === 'addcart') {
    await addToCart(user.tgId, arg1)
    await send(chatId, `✅ Добавлено в корзину! /cart — посмотреть`)
  } else if (act === 'cart') {
    await showCart(chatId, user)
  } else if (act === 'checkout') {
    await checkout(chatId, user.tgId)
  } else if (act === 'clearcart') {
    await db.cartItem.deleteMany({ where: { userId: user.tgId } })
    await send(chatId, '🧹 Корзина очищена!')
  } else if (act === 'orders') {
    await showOrders(chatId, user)
  }
}

/* ------------------------------------------------------------------ */
/* Seed NFT products to DB                                             */
/* ------------------------------------------------------------------ */

export async function seedProducts() {
  for (const nft of NFT_CATALOG) {
    await db.nftProduct.upsert({
      where: { slug: nft.slug },
      create: {
        slug: nft.slug,
        name: nft.name,
        category: nft.category,
        emoji: nft.emoji,
        priceStars: nft.priceStars,
        giftIds: JSON.stringify(nft.giftIds),
      },
      update: {
        name: nft.name,
        category: nft.category,
        emoji: nft.emoji,
        priceStars: nft.priceStars,
        giftIds: JSON.stringify(nft.giftIds),
      },
    })
  }
  console.log(`[seed] ${NFT_CATALOG.length} NFT products synced`)
}
