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
  // NFT
  { slug: 'scared-cat', name: 'Scared Cat', emoji: '🐱', priceStars: 25, giftIds: ['9000000000000030'], category: 'nft' },
]

const CATEGORIES = [
  { id: 'nft', name: '🖼️ NFT', desc: 'Уникальные NFT подарки' },
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
    // Pre-checkout — AltGram присылает ПЕРЕД оплатой
    // ВАЖНО: AltGram НЕ присылает successful_payment после оплаты!
    // Поэтому доставляем NFT СРАЗУ при pre_checkout (после ответа ok:true)
    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query
      console.log(`[pre_checkout] id=${pcq.id} user=${pcq.from.id} amount=${pcq.total_amount} payload=${pcq.invoice_payload}`)

      // Отвечаем ok:true — подтверждаем платёж
      let preCheckoutOk = false
      try {
        const res = await altgram.answerPreCheckoutQuery({ pre_checkout_query_id: pcq.id, ok: true })
        console.log(`[pre_checkout] answered:`, JSON.stringify(res).slice(0, 100))
        if (res.ok) preCheckoutOk = true
      } catch (e) {
        console.error('[pre_checkout] error:', e)
      }

      // Доставляем NFT ТОЛЬКО если pre_checkout успешно ответил ok:true
      // AltGram иногда возвращает QUERY_ID_INVALID (запрос уже истёк)
      // Но даже если истёк — проверяем что платёж действительно был
      const payload = pcq.invoice_payload
      if (payload?.startsWith('order:')) {
        const orderId = payload.slice(6)
        const order = await db.order.findUnique({ where: { id: orderId } })
        
        if (!order) {
          console.log(`[pre_checkout] order not found: ${orderId}`)
          // Ошибка — заказ не найден, отменяем
          try {
            await altgram.answerPreCheckoutQuery({ pre_checkout_query_id: pcq.id, ok: false, error_message: 'Заказ не найден' })
          } catch {}
          return
        }

        if (order.status === 'fulfilled' || order.status === 'partial') {
          console.log(`[pre_checkout] order already delivered: ${orderId}`)
          return
        }

        // Проверяем сумму — должна совпадать с ценой заказа
        if (pcq.total_amount !== order.totalStars) {
          console.log(`[pre_checkout] amount mismatch: ${pcq.total_amount} vs ${order.totalStars}`)
          try {
            await altgram.answerPreCheckoutQuery({ pre_checkout_query_id: pcq.id, ok: false, error_message: 'Неверная сумма' })
          } catch {}
          return
        }

        // Помечаем как оплаченный и доставляем
        await db.order.update({
          where: { id: orderId },
          data: { status: 'paid', paidAt: new Date() },
        })
        console.log(`[pre_checkout] delivering order ${orderId}`)
        await deliverOrder(orderId, String(pcq.from.id))
      }
      return
    }

    if (update.callback_query) {
      const cqData = update.callback_query.data ?? ''
      // AltGram присылает __invoice_pay:... когда юзер нажал ⭐ Pay
      // Это НЕ обычный callback — игнорируем его (AltGram сам обработает оплату)
      if (cqData.startsWith('__invoice_pay')) {
        console.log(`[invoice_pay] user=${update.callback_query.from.id} — AltGram обрабатывает`)
        try { await altgram.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: '' }) } catch {}
        return
      }
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
      await sendHelp(msg.chat.id, user)
      break
    case '/balance':
      await send(msg.chat.id, `💰 **Твой баланс: ${user.balance}⭐**`)
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
    case '/promo':
      await handlePromo(msg, user, text.split(/\s+/)[1])
      break
    // Админ-команды
    case '/give':
      await handleGive(msg, user, text.split(/\s+/)[1], text.split(/\s+/)[2])
      break
    case '/sendgift':
      await handleSendGift(msg, user, text.split(/\s+/).slice(1))
      break
    case '/addpromo':
      await handleAddPromo(msg, user, text.split(/\s+/).slice(1))
      break
    case '/admin':
      await sendAdminPanel(msg.chat.id, user)
      break
    case '/listusers':
      await handleListUsers(msg, user)
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
      'Выбери категорию:',
      '',
      '✅ Текущие доступные NFT:',
      ...NFT_CATALOG.map(n => `${n.emoji} ${n.name} — ${n.priceStars}⭐`),
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
      '✅ Доступные NFT:',
      ...nfts.map(n => `${n.emoji} ${n.name} — ${n.priceStars}⭐`),
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
      'Нажми «⭐ Pay» ниже для оплаты:',
    ].join('\n'))

  // Создаём инвойс — БЕЗ reply_markup! AltGram сам добавит кнопку «⭐ Pay»
  const res = await altgram.sendInvoice({
    chat_id: Number(userId),
    title: `${nft.emoji} ${nft.name} × ${qty}`,
    description: `Покупка ${qty} × ${nft.name} (${nft.priceStars}⭐ каждый). Всего: ${total}⭐`,
    payload: `order:${order.id}`,
    currency: 'XTR',
    prices: [{ label: `${nft.name} × ${qty}`, amount: total }],
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

// Доставка заказа (вызывается при pre_checkout_query — AltGram не присылает successful_payment)
async function deliverOrder(orderId: string, userTgId: string) {
  const order = await db.order.findUnique({ where: { id: orderId } })
  if (!order) {
    console.error('[deliver] order not found:', orderId)
    return
  }

  // Проверяем что заказ оплачен (status=paid) или ещё pending
  if (order.status === 'fulfilled' || order.status === 'partial') {
    console.log('[deliver] already delivered:', orderId)
    return
  }

  // НЕ меняем статус здесь — он уже 'paid' после pre_checkout
  await send(Number(userTgId), `✅ Оплата получена! Доставляю NFT...`)

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
        // Отправляем с подписью (text) — юзер увидит от кого
        const res = await altgram.sendGift({
          user_id: Number(order.userId),
          gift_id: giftId,
          text: `🎁 Покупка из NFT Shop`,
        })
        if (res.ok) {
          giftDelivered = true
          break
        }
        // Если с текстом не вышло — пробуем без (скрытно)
        if (!res.ok) {
          const res2 = await altgram.sendGift({
            user_id: Number(order.userId),
            gift_id: giftId,
          })
          if (res2.ok) {
            giftDelivered = true
            break
          }
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

  await send(Number(userTgId),
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

async function handlePayment(msg: TgMessage) {
  const sp = msg.successful_payment
  if (!sp) return

  const payload = sp.invoice_payload
  if (!payload || !payload.startsWith('order:')) return

  const orderId = payload.slice(6)
  // Если уже доставили через pre_checkout — игнорируем
  const order = await db.order.findUnique({ where: { id: orderId } })
  if (!order) return
  if (order.status === 'fulfilled' || order.status === 'partial') {
    console.log('[payment] already delivered via pre_checkout:', orderId)
    return
  }

  // Если successful_payment всё-таки пришёл — доставляем
  await deliverOrder(orderId, String(msg.from?.id ?? ''))
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

  // Создаём инвойс — БЕЗ reply_markup! AltGram сам добавит кнопку «⭐ Pay»
  await altgram.sendInvoice({
    chat_id: Number(userId),
    title: `🛍️ Заказ NFT (${itemCount} шт)`,
    description: summary.slice(0, 200),
    payload: `order:${order.id}`,
    currency: 'XTR',
    prices: [{ label: `NFT × ${itemCount}`, amount: total }],
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
/* Admin functions                                                     */
/* ------------------------------------------------------------------ */

async function sendHelp(chatId: number, user: { isAdmin: boolean }) {
  const lines = [
    '🛍️ **NFT Shop** — массовая покупка подарков',
    '',
    '**Покупка:**',
    '1. /start → каталог',
    '2. Выбери NFT → количество',
    '3. Оплати через Telegram Stars',
    '4. Получи gifts автоматически!',
    '',
    '**Команды:**',
    '• /start — каталог',
    '• /balance — баланс звёзд',
    '• /cart — корзина',
    '• /orders — история покупок',
    '• /promo <код> — активировать промокод',
  ]
  if (user.isAdmin) {
    lines.push('', '**👑 Админ:**', '• /give @user <N> — выдать звёзды', '• /sendgift @user <цена> <кол-во> — отправить gift', '• /addpromo stars <награда> <макс> — промокод на звёзды', '• /addpromo nft <slug> <макс> — промокод на NFT', '• /admin — админ-панель', '• /listusers — список юзеров')
  }
  await send(chatId, lines.join('\n'))
}

async function sendAdminPanel(chatId: number, user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    await send(chatId, '🚫 Только админ.')
    return
  }
  const userCount = await db.user.count()
  const orderCount = await db.order.count()
  const fulfilledOrders = await db.order.count({ where: { status: 'fulfilled' } })
  const totalStars = await db.user.aggregate({ _sum: { balance: true } })
  const promoCount = await db.promoCode.count({ where: { isActive: true } })

  await send(chatId,
    [
      '👑 **Админ-панель**',
      '',
      `👥 Юзеров: **${userCount}**`,
      `📦 Заказов: **${orderCount}** (${fulfilledOrders} выполнено)`,
      `💰 Общий баланс: **${totalStars._sum.balance || 0}⭐**`,
      `🎟️ Активных промокодов: **${promoCount}**`,
      '',
      '**Команды:**',
      '• `/give @user 1000` — выдать звёзды',
      '• `/sendgift @user 25 5` — отправить gifts',
      '• `/addpromo stars 100 10` — промокод на 100⭐ (10 шт)',
      '• `/addpromo nft scared-cat 5` — промокод на Scared Cat (5 шт)',
      '• `/listusers` — список юзеров',
    ].join('\n'))
}

async function handleGive(msg: TgMessage, user: { tgId: string; username: string | null; isAdmin: boolean }, targetArg?: string, amountArg?: string) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }
  if (!targetArg?.startsWith('@')) { await send(msg.chat.id, '⚠️ `/give @user 100`'); return }
  const targetUsername = targetArg.slice(1).toLowerCase()
  const amount = parseInt(amountArg ?? '')
  if (isNaN(amount) || amount <= 0) { await send(msg.chat.id, '⚠️ `/give @user 100`'); return }

  const target = await db.user.findFirst({ where: { username: targetUsername } })
  if (!target) { await send(msg.chat.id, `❌ @${targetUsername} не найден`); return }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: target.id }, data: { balance: { increment: amount } } })
    await tx.transaction.create({ data: { userId: target.tgId, type: 'give', amount, balanceAfter: u.balance, note: `От @${user.username ?? 'admin'}` } })
    return u
  })
  await send(msg.chat.id, `✅ @${targetUsername} +${amount}⭐. Баланс: ${updated.balance}⭐`)
  try { await send(target.tgId, `🎁 Админ начислил вам ${amount}⭐!\nБаланс: ${updated.balance}⭐`) } catch {}
}

async function handleSendGift(msg: TgMessage, user: { tgId: string; username: string | null; isAdmin: boolean }, args: string[]) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }
  const targetArg = args[0] ?? ''
  const amountArg = args[1]
  const countArg = args[2] || '1'
  const rawTarget = targetArg.replace(/^@/, '').trim()
  if (!rawTarget) { await send(msg.chat.id, '⚠️ `/sendgift @user 25 5`'); return }

  const amount = parseInt(amountArg ?? '')
  const count = Math.min(Math.max(parseInt(countArg) || 1, 1), 50)
  if (isNaN(amount) || amount <= 0) { await send(msg.chat.id, '⚠️ `/sendgift @user 25 5`'); return }

  // Найти NFT по цене
  const nft = NFT_CATALOG.find(n => n.priceStars === amount)
  if (!nft) {
    await send(msg.chat.id, `❌ Нет NFT за ${amount}⭐. Доступные цены: 15, 25, 50, 100⭐`)
    return
  }

  // Найти юзера
  let target = null
  if (/^\d+$/.test(rawTarget)) {
    target = await db.user.findUnique({ where: { tgId: rawTarget }, select: { tgId: true, username: true } })
    if (!target) {
      target = await db.user.create({ data: { tgId: rawTarget, username: null } })
      await send(msg.chat.id, `ℹ️ Юзер ${rawTarget} добавлен в БД`)
    }
  } else {
    target = await db.user.findFirst({ where: { username: rawTarget.toLowerCase() }, select: { tgId: true, username: true } })
  }
  if (!target) { await send(msg.chat.id, `❌ @${rawTarget} не найден`); return }

  const displayName = target.username ? `@${target.username}` : `id:${target.tgId}`
  await send(msg.chat.id, `⏳ Отправляю ${count} × ${nft.emoji} ${nft.name} (${nft.priceStars}⭐) юзеру ${displayName}...`)

  let sent = 0, failed = 0
  for (let i = 0; i < count; i++) {
    let giftSent = false
    for (const giftId of nft.giftIds) {
      // С подписью
      const res = await altgram.sendGift({ user_id: Number(target.tgId), gift_id: giftId, text: '🎁 От NFT Shop' })
      if (res.ok) { giftSent = true; break }
      // Без подписи
      const res2 = await altgram.sendGift({ user_id: Number(target.tgId), gift_id: giftId })
      if (res2.ok) { giftSent = true; break }
    }
    if (giftSent) sent++; else failed++
  }

  await send(msg.chat.id,
    [
      `🎁 **Результат:**`,
      `👤 ${displayName}`,
      `💰 ${nft.emoji} ${nft.name} × ${count}`,
      `✅ Отправлено: ${sent}`,
      `❌ Не удалось: ${failed}`,
    ].join('\n'))

  if (sent > 0) {
    try { await send(target.tgId, `🎁 Вам отправлено ${sent} × ${nft.emoji} ${nft.name} от @nftshopbot!`) } catch {}
  }
}

async function handleAddPromo(msg: TgMessage, user: { tgId: string; isAdmin: boolean }, args: string[]) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }

  // /addpromo stars 100 10 → промокод на 100⭐, 10 использований
  // /addpromo nft scared-cat 5 → промокод на Scared Cat, 5 использований
  const type = args[0]?.toLowerCase()
  const rewardArg = args[1]
  const maxUses = parseInt(args[2] ?? '1') || 1

  if (type !== 'stars' && type !== 'nft') {
    await send(msg.chat.id,
      [
        '⚠️ Использование:',
        '`/addpromo stars 100 10` — промокод на 100⭐',
        '`/addpromo nft scared-cat 5` — промокод на Scared Cat',
        '',
        'Доступные NFT slugs:',
        ...NFT_CATALOG.map(n => `• ${n.slug} (${n.emoji} ${n.name} ${n.priceStars}⭐)`),
      ].join('\n'))
    return
  }

  let reward = 0
  let nftSlug: string | null = null

  if (type === 'stars') {
    reward = parseInt(rewardArg ?? '0')
    if (reward <= 0) { await send(msg.chat.id, '⚠️ Укажи кол-во звёзд: `/addpromo stars 100 10`'); return }
  } else if (type === 'nft') {
    nftSlug = rewardArg?.toLowerCase()
    const nft = getNftBySlug(nftSlug ?? '')
    if (!nft) { await send(msg.chat.id, `❌ NFT slug не найден. Доступные: ${NFT_CATALOG.map(n => n.slug).join(', ')}`); return }
    reward = 1  // 1 NFT
  }

  // Генерируем код
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]

  const promo = await db.promoCode.create({
    data: { code, type, reward, nftSlug, maxUses, createdById: user.tgId },
  })

  if (type === 'stars') {
    await send(msg.chat.id,
      [
        `✅ **Промокод создан!**`,
        '',
        `📝 Код: \`${code}\``,
        `💰 Награда: ${reward}⭐ на баланс`,
        `🔄 Лимит: ${maxUses} использ.`,
        '',
        `Поделись: \`/promo ${code}\``,
      ].join('\n'))
  } else {
    const nft = getNftBySlug(nftSlug!)
    await send(msg.chat.id,
      [
        `✅ **Промокод создан!**`,
        '',
        `📝 Код: \`${code}\``,
        `🖼️ Награда: ${nft!.emoji} ${nft!.name} (NFT)`,
        `🔄 Лимит: ${maxUses} использ.`,
        '',
        `Поделись: \`/promo ${code}\``,
      ].join('\n'))
  }
}

async function handlePromo(msg: TgMessage, user: { tgId: string; balance: number }, code?: string) {
  if (!code) {
    await send(msg.chat.id, '⚠️ `/promo <код>` — введи промокод')
    return
  }

  const promo = await db.promoCode.findUnique({ where: { code: code.toUpperCase() } })
  if (!promo || !promo.isActive) {
    await send(msg.chat.id, '❌ Промокод не найден или неактивен')
    return
  }

  if (promo.usedCount >= promo.maxUses) {
    await send(msg.chat.id, '❌ Промокод уже использован максимальное число раз')
    return
  }

  // Проверяем не использовал ли уже юзер
  const existing = await db.promoRedemption.findUnique({
    where: { promoId_userId: { promoId: promo.id, userId: user.tgId } },
  })
  if (existing) {
    await send(msg.chat.id, '❌ Ты уже использовал этот промокод')
    return
  }

  // Редим
  await db.promoRedemption.create({ data: { promoId: promo.id, userId: user.tgId } })
  await db.promoCode.update({
    where: { id: promo.id },
    data: { usedCount: { increment: 1 }, isActive: promo.usedCount + 1 >= promo.maxUses ? false : true },
  })

  if (promo.type === 'stars') {
    // Начисляем звёзды
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { tgId: user.tgId }, data: { balance: { increment: promo.reward } } })
      await tx.transaction.create({ data: { userId: user.tgId, type: 'promo', amount: promo.reward, balanceAfter: u.balance, note: `Промокод ${code}` } })
      return u
    })
    await send(msg.chat.id, `🎉 Промокод активирован! +${promo.reward}⭐\nБаланс: ${updated.balance}⭐`)
  } else if (promo.type === 'nft' && promo.nftSlug) {
    // Отправляем NFT
    const nft = getNftBySlug(promo.nftSlug)
    if (!nft) {
      await send(msg.chat.id, '❌ NFT не найден, возможно каталог изменился')
      return
    }

    await send(msg.chat.id, `🎉 Промокод активирован! Отправляю ${nft.emoji} ${nft.name}...`)

    let giftSent = false
    for (const giftId of nft.giftIds) {
      const res = await altgram.sendGift({ user_id: Number(user.tgId), gift_id: giftId, text: '🎁 Промокод NFT Shop' })
      if (res.ok) { giftSent = true; break }
      const res2 = await altgram.sendGift({ user_id: Number(user.tgId), gift_id: giftId })
      if (res2.ok) { giftSent = true; break }
    }

    if (giftSent) {
      await send(msg.chat.id, `✅ ${nft.emoji} ${nft.name} отправлен!`)
    } else {
      // Не удалось → начисляем звёзды вместо NFT
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.user.update({ where: { tgId: user.tgId }, data: { balance: { increment: nft.priceStars } } })
        await tx.transaction.create({ data: { userId: user.tgId, type: 'promo', amount: nft.priceStars, balanceAfter: u.balance, note: `Промокод ${code} → звёзды (NFT недоступен)` } })
        return u
      })
      await send(msg.chat.id, `⚠️ NFT временно недоступен. Начислено ${nft.priceStars}⭐ на баланс.\nБаланс: ${updated.balance}⭐`)
    }
  }
}

async function handleListUsers(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }
  const users = await db.user.findMany({
    select: { username: true, tgId: true, balance: true, isAdmin: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  const lines = users.map(u => {
    const name = u.username ? `@${u.username}` : `id:${u.tgId}`
    const tag = u.isAdmin ? ' 👑' : ''
    return `• ${name} — ${u.balance}⭐${tag}`
  })
  await send(msg.chat.id, `📋 **Юзеры (${users.length}):**\n\n${lines.join('\n')}`)
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
