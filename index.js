'use strict';

/*
============================================================
        БАЗА ПРОКАТА — WHATSAPP DRIVER BOT
        Baileys 7.x
============================================================

ЛОГИКА:

1. Любой участник группы может создать заказ.
2. Заказ может состоять из нескольких сообщений.
3. Один заказ определяется по messageId.
4. Админ пересылает заказ водителю.
5. Бот запоминает ID отправленного сообщения.
6. Водитель свайпает:
      Оставил
      Оставил 12000
      Оставил 12000 наличка
      Оставил 10000 уд
   -> заказ = "В аренде"

7. В группе можно свайпнуть заказ:
      Забрать
      Забрать клиента
      Забрать резчик
      Забрать резчик сегодня
   -> заказ = "Нужно забрать"

8. Другой водитель получает заказ.
9. Водитель свайпает:
      Забрал
      Забрал 12000
   -> заказ = "Забрано"

10. Повторная пересылка не создаёт новый заказ.
11. Все изменения сохраняются в orders.json.
12. Панель читает тот же orders.json.

ИЗМЕНЕНО:
- Только номер телефона или только текст ("Трамбовка") больше НЕ создают заказ.
- Заказ создается, если есть и номер телефона, и инструмент/адрес (или гео-ссылка).
============================================================
*/

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const BASE_DIR = __dirname;

const DB_FILE = path.join(BASE_DIR, 'orders.json');
const BACKUP_FILE = path.join(BASE_DIR, 'orders_backup.json');
const AUTH_DIR = path.join(BASE_DIR, 'auth_info_baileys');

const DELETE_PASSWORD = '8989';

// ============================================================
// АДМИН
// ============================================================

const ADMIN_NUMBERS = new Set([
    '77763015076'
]);

// ============================================================
// ВОДИТЕЛИ
// ============================================================

const DRIVERS = [
    {
        id: 'sergey',
        name: 'Сергей',
        phone: '77054357734'
    },
    {
        id: 'nurassyl',
        name: 'Нурасыл',
        phone: '77052632250'
    },
    {
        id: 'maksat',
        name: 'Максат',
        phone: '77052902150'
    }
];

// ============================================================
// СТАТУСЫ
// ============================================================

const STATUS = {
    NEW: 'new',
    CLIENT: 'client',
    RETURN_QUEUE: 'return_queue',
    RETURNED: 'returned'
};

// ============================================================
// ПАМЯТЬ
// ============================================================

let sock = null;
let reconnectTimer = null;
let isStarting = false;
let isConnected = false;

let orders = [];

const messageToOrder = new Map();
const outgoingToOrder = new Map();
const outgoingToDriver = new Map();

const driverLids = new Map();
const driverPns = new Map();

const recentMessages = new Map();

let lastQR = null;

// ============================================================
// ФАЙЛЫ
// ============================================================

function ensureFiles() {

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, {
            recursive: true
        });
    }

    if (!fs.existsSync(DB_FILE)) {

        fs.writeFileSync(
            DB_FILE,
            JSON.stringify([], null, 2),
            'utf8'
        );

    }

    loadOrders();
}

// ============================================================
// ЗАГРУЗКА ЗАКАЗОВ
// ============================================================

function loadOrders() {

    try {

        const raw =
            fs.readFileSync(
                DB_FILE,
                'utf8'
            );

        if (!raw.trim()) {

            orders = [];

            return;
        }

        const data =
            JSON.parse(raw);

        if (Array.isArray(data)) {

            orders = data;

        } else {

            orders = [];

        }

        rebuildIndexes();

        console.log(
            `📂 Загружено заказов: ${orders.length}`
        );

    } catch (err) {

        console.log(
            '❌ Ошибка чтения orders.json:',
            err.message
        );

        orders = [];
    }
}

// ============================================================
// СОХРАНЕНИЕ
// ============================================================

function saveOrders() {

    try {

        const tempFile =
            DB_FILE + '.tmp';

        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                orders,
                null,
                2
            ),
            'utf8'
        );

        fs.renameSync(
            tempFile,
            DB_FILE
        );

        return true;

    } catch (err) {

        console.log(
            '❌ Ошибка сохранения orders.json:',
            err.message
        );

        return false;
    }
}

// ============================================================
// BACKUP
// ============================================================

function backupOrders() {

    try {

        fs.copyFileSync(
            DB_FILE,
            BACKUP_FILE
        );

    } catch (e) {

        // Не критично

    }
}

// ============================================================
// НОМЕРА
// ============================================================

function digits(value) {

    return String(value || '')
        .replace(/\D/g, '');

}

function normalizePhone(value) {

    let d =
        digits(value);

    if (!d) {
        return '';
    }

    if (
        d.length === 11 &&
        d.startsWith('8')
    ) {

        d =
            '7' +
            d.slice(1);

    }

    return d;
}

function phoneVariants(value) {

    const original =
        digits(value);

    const normalized =
        normalizePhone(value);

    const result =
        new Set();

    if (original) {
        result.add(original);
    }

    if (normalized) {
        result.add(normalized);
    }

    if (normalized.length >= 10) {

        result.add(
            normalized.slice(-10)
        );

    }

    if (original.length >= 10) {

        result.add(
            original.slice(-10)
        );

    }

    return [
        ...result
    ];
}

// ============================================================
// JID
// ============================================================

function bareJid(jid) {

    if (!jid) {
        return '';
    }

    return String(jid)
        .split(':')[0]
        .split('/')[0];
}

function jidNumber(jid) {

    if (!jid) {
        return '';
    }

    return digits(
        bareJid(jid)
            .replace(
                '@s.whatsapp.net',
                ''
            )
            .replace(
                '@lid',
                ''
            )
    );
}

function isGroupJid(jid) {

    return String(jid || '')
        .endsWith('@g.us');

}

function isLidJid(jid) {

    return String(jid || '')
        .includes('@lid');

}

function isPnJid(jid) {

    return String(jid || '')
        .includes('@s.whatsapp.net');

}

// ============================================================
// ТЕКСТ
// ============================================================

function getMessageText(message) {

    if (!message) {
        return '';
    }

    const m =
        message.message;

    if (!m) {
        return '';
    }

    if (m.conversation) {

        return m.conversation;

    }

    if (m.extendedTextMessage) {

        return (
            m.extendedTextMessage.text ||
            ''
        );

    }

    if (m.imageMessage) {

        return (
            m.imageMessage.caption ||
            ''
        );

    }

    if (m.videoMessage) {

        return (
            m.videoMessage.caption ||
            ''
        );

    }

    if (m.documentMessage) {

        return (
            m.documentMessage.caption ||
            ''
        );

    }

    if (m.documentWithCaptionMessage) {

        return (
            m.documentWithCaptionMessage
                ?.message
                ?.documentMessage
                ?.caption ||
            ''
        );

    }

    return '';
}

function normalizeText(text) {

    return String(text || '')
        .replace(/\r/g, '')
        .replace(
            /[ \t]+/g,
            ' '
        )
        .trim();

}

// ============================================================
// QUOTED / SWIPE
// ============================================================

function getQuotedMessage(message) {

    const m =
        message?.message;

    if (!m) {
        return null;
    }

    const ext =
        m.extendedTextMessage;

    if (ext?.contextInfo) {

        return (
            ext.contextInfo.quotedMessage ||
            null
        );

    }

    if (m.imageMessage?.contextInfo) {

        return (
            m.imageMessage
                .contextInfo
                .quotedMessage ||
            null
        );

    }

    if (m.videoMessage?.contextInfo) {

        return (
            m.videoMessage
                .contextInfo
                .quotedMessage ||
            null
        );

    }

    return null;
}

function getQuotedStanzaId(message) {

    const m =
        message?.message;

    if (!m) {
        return '';
    }

    const contexts = [];

    if (
        m.extendedTextMessage
            ?.contextInfo
    ) {

        contexts.push(
            m.extendedTextMessage
                .contextInfo
        );

    }

    if (
        m.imageMessage
            ?.contextInfo
    ) {

        contexts.push(
            m.imageMessage
                .contextInfo
        );

    }

    if (
        m.videoMessage
            ?.contextInfo
    ) {

        contexts.push(
            m.videoMessage
                .contextInfo
        );

    }

    if (
        m.documentMessage
            ?.contextInfo
    ) {

        contexts.push(
            m.documentMessage
                .contextInfo
        );

    }

    for (
        const ctx of contexts
    ) {

        if (ctx?.stanzaId) {

            return ctx.stanzaId;

        }

    }

    return '';
}

function getQuotedText(message) {

    const quoted =
        getQuotedMessage(message);

    if (!quoted) {
        return '';
    }

    if (quoted.conversation) {

        return quoted.conversation;

    }

    if (
        quoted
            .extendedTextMessage
            ?.text
    ) {

        return (
            quoted
                .extendedTextMessage
                .text
        );

    }

    if (
        quoted
            .imageMessage
            ?.caption
    ) {

        return (
            quoted
                .imageMessage
                .caption
        );

    }

    if (
        quoted
            .videoMessage
            ?.caption
    ) {

        return (
            quoted
                .videoMessage
                .caption
        );

    }

    if (
        quoted
            .documentMessage
            ?.caption
    ) {

        return (
            quoted
                .documentMessage
                .caption
        );

    }

    return '';
}

// ============================================================
// LID ↔ PN
// ============================================================

async function resolveLidToPn(jid) {

    if (
        !jid ||
        !isLidJid(jid)
    ) {

        return '';

    }

    for (
        const [phone, lid]
        of driverLids.entries()
    ) {

        if (
            bareJid(lid) ===
            bareJid(jid)
        ) {

            return phone;

        }

    }

    try {

        const mapping =
            sock
                ?.signalRepository
                ?.lidMapping;

        if (mapping) {

            if (
                typeof mapping
                    .getPNForLID ===
                'function'
            ) {

                const pn =
                    await mapping
                        .getPNForLID(
                            bareJid(jid)
                        );

                if (pn) {

                    return bareJid(pn);

                }

            }

        }

    } catch (e) {

        // fallback

    }

    return '';
}

async function resolvePnToLid(phone) {

    const normalized =
        normalizePhone(phone);

    if (!normalized) {
        return '';
    }

    if (
        driverLids.has(normalized)
    ) {

        return driverLids.get(
            normalized
        );

    }

    try {

        const mapping =
            sock
                ?.signalRepository
                ?.lidMapping;

        if (mapping) {

            if (
                typeof mapping
                    .getLIDForPN ===
                'function'
            ) {

                const lid =
                    await mapping
                        .getLIDForPN(
                            normalized +
                            '@s.whatsapp.net'
                        );

                if (lid) {

                    const result =
                        bareJid(lid);

                    driverLids.set(
                        normalized,
                        result
                    );

                    return result;

                }

            }

        }

    } catch (e) {

        // fallback

    }

    return '';
}

// ============================================================
// ВОДИТЕЛИ
// ============================================================

function getDriverByPhone(phone) {

    const variants =
        phoneVariants(phone);

    for (
        const driver of DRIVERS
    ) {

        const driverVariants =
            phoneVariants(
                driver.phone
            );

        if (
            variants.some(
                v =>
                    driverVariants
                        .includes(v)
            )
        ) {

            return driver;

        }

    }

    return null;
}

function getDriverByJid(jid) {

    if (!jid) {
        return null;
    }

    const clean =
        bareJid(jid);

    for (
        const driver of DRIVERS
    ) {

        const lid =
            driverLids.get(
                normalizePhone(
                    driver.phone
                )
            );

        if (
            lid &&
            bareJid(lid) === clean
        ) {

            return driver;

        }

    }

    const phone =
        normalizePhone(
            jidNumber(jid)
        );

    if (phone) {

        const driver =
            getDriverByPhone(phone);

        if (driver) {

            return driver;

        }

    }

    return null;
}

async function rememberDriverJid(
    driver,
    jid
) {

    if (!driver || !jid) {
        return;
    }

    const clean =
        bareJid(jid);

    if (isLidJid(clean)) {

        driverLids.set(
            normalizePhone(
                driver.phone
            ),
            clean
        );

    }

    if (isPnJid(clean)) {

        driverPns.set(
            normalizePhone(
                driver.phone
            ),
            clean
        );

    }

    if (isPnJid(clean)) {

        const lid =
            await resolvePnToLid(
                driver.phone
            );

        if (lid) {

            driverLids.set(
                normalizePhone(
                    driver.phone
                ),
                lid
            );

        }

    }

}

async function identifyDriver(
    jid,
    message
) {

    const candidates = [];

    if (jid) {
        candidates.push(jid);
    }

    if (
        message?.key?.participant
    ) {

        candidates.push(
            message.key.participant
        );

    }

    if (
        message?.key?.participantPn
    ) {

        candidates.push(
            message.key.participantPn
        );

    }

    if (message?.participant) {

        candidates.push(
            message.participant
        );

    }

    for (
        const candidate of candidates
    ) {

        const driver =
            getDriverByJid(
                candidate
            );

        if (driver) {

            await rememberDriverJid(
                driver,
                candidate
            );

            return driver;

        }

    }

    for (
        const candidate of candidates
    ) {

        if (
            isLidJid(candidate)
        ) {

            const pn =
                await resolveLidToPn(
                    candidate
                );

            if (pn) {

                const driver =
                    getDriverByPhone(pn);

                if (driver) {

                    await rememberDriverJid(
                        driver,
                        candidate
                    );

                    driverPns.set(
                        normalizePhone(
                            driver.phone
                        ),
                        pn
                    );

                    return driver;

                }

            }

        }

    }

    return null;
}

// ============================================================
// КОМАНДЫ
// ============================================================

function isLeaveCommand(text) {

    const t =
        normalizeText(text)
            .toLowerCase();

    return /^оставил(?:\s|$)/i
        .test(t);
}

function isTakeCommand(text) {

    const t =
        normalizeText(text)
            .toLowerCase();

    return /^забрал(?:\s|$)/i
        .test(t);
}

function isReturnRequest(text) {

    const t =
        normalizeText(text)
            .toLowerCase();

    return /^забрать(?:\s|$)/i
        .test(t);
}

// ============================================================
// ОПЛАТА
// ============================================================

function extractPayment(text) {

    const t =
        normalizeText(text);

    if (!t) {
        return '';
    }

    const match =
        t.match(
            /(?:оставил|забрал)\s*[:\-]?\s*([\d\s.,]+(?:\s*(?:нал|наличка|наличными|уд|тг|тенге))?)/i
        );

    if (match) {

        return match[1].trim();

    }

    const number =
        t.match(
            /\b\d[\d\s.,]{2,}\b/
        );

    if (number) {

        return number[0].trim();

    }

    return '';
}

// ============================================================
// ЗАКАЗ
// ============================================================

function makeOrderId() {

    let id;

    do {

        id =
            String(
                Math.floor(
                    1000 +
                    Math.random() *
                    9000
                )
            );

    } while (
        orders.some(
            order =>
                order.id === id
        )
    );

    return id;
}

function looksLikePhone(text) {

    const d =
        digits(text);

    return d.length >= 10;
}

function looksLikeOrder(text) {

    const t =
        normalizeText(text);

    if (!t) {
        return false;
    }

    if (
        isLeaveCommand(t)
    ) {

        return false;

    }

    if (
        isTakeCommand(t)
    ) {

        return false;

    }

    if (
        isReturnRequest(t)
    ) {

        return false;

    }

    const hasPhone = looksLikePhone(t);
    const hasGeo = /2gis\.kz|maps\.google|yandex|geo:/i.test(t);
    const hasToolOrAddress = /(генератор|гильотин|резка|мойка|компрессор|дрель|перфоратор|свар|лестниц|бош|bosch|бетономеш|инструмент|трамбовка|ул\.|улица|дом|кв)/i.test(t);

    if (hasGeo) {
        return true;
    }

    // Заказ теперь засчитывается, только если есть и телефон, и инструмент/адрес
    if (hasPhone && hasToolOrAddress) {
        return true;
    }

    return false;
}

// ============================================================
// ИНДЕКСЫ
// ============================================================

function rebuildIndexes() {

    messageToOrder.clear();
    outgoingToOrder.clear();
    outgoingToDriver.clear();

    for (
        const order of orders
    ) {

        for (
            const id
            of order.messageIds || []
        ) {

            messageToOrder.set(
                id,
                order.id
            );

        }

        for (
            const id
            of order.whatsappMsgIds || []
        ) {

            messageToOrder.set(
                id,
                order.id
            );

        }

        for (
            const id
            of order.outgoingMessageIds || []
        ) {

            messageToOrder.set(
                id,
                order.id
            );

            outgoingToOrder.set(
                id,
                order.id
            );

            if (
                order.driverName
            ) {

                outgoingToDriver.set(
                    id,
                    order.driverName
                );

            }

        }

    }

}

// ============================================================
// ДОБАВИТЬ MESSAGE ID
// ============================================================

function addMessageToOrder(
    order,
    messageId
) {

    if (!order.messageIds) {

        order.messageIds = [];

    }

    if (!order.whatsappMsgIds) {

        order.whatsappMsgIds = [];

    }

    if (
        messageId &&
        !order.messageIds
            .includes(messageId)
    ) {

        order.messageIds.push(
            messageId
        );

    }

    if (
        messageId &&
        !order.whatsappMsgIds
            .includes(messageId)
    ) {

        order.whatsappMsgIds.push(
            messageId
        );

    }

    messageToOrder.set(
        messageId,
        order.id
    );
}

// ============================================================
// ПОИСК ПО MESSAGE ID
// ============================================================

function findOrderByMessageId(
    messageId
) {

    if (!messageId) {
        return null;
    }

    const id =
        messageToOrder.get(
            messageId
        );

    if (id) {

        return (
            orders.find(
                order =>
                    order.id === id
            ) || null
        );

    }

    for (
        const order of orders
    ) {

        if (
            (order.messageIds || [])
                .includes(messageId) ||

            (order.whatsappMsgIds || [])
                .includes(messageId) ||

            (order.outgoingMessageIds || [])
                .includes(messageId)
        ) {

            messageToOrder.set(
                messageId,
                order.id
            );

            return order;

        }

    }

    return null;
}

// ============================================================
// ПОИСК ПО ТЕКСТУ / ТЕЛЕФОНУ
// ============================================================

function findOrderByText(text) {

    const t =
        normalizeText(text);

    if (!t) {
        return null;
    }

    const phones =
        phoneVariants(t);

    if (!phones.length) {
        return null;
    }

    for (
        let i =
            orders.length - 1;
        i >= 0;
        i--
    ) {

        const order =
            orders[i];

        const orderPhones =
            phoneVariants(
                order.text || ''
            );

        if (
            phones.some(
                p =>
                    orderPhones
                        .includes(p)
            )
        ) {

            return order;

        }

    }

    return null;
}

// ============================================================
// ПОИСК ПО СВАЙПУ
// ============================================================

function findOrderFromReply(
    message,
    quotedStanzaId,
    quotedText
) {

    if (quotedStanzaId) {

        const order =
            findOrderByMessageId(
                quotedStanzaId
            );

        if (order) {

            return order;

        }

    }

    if (quotedText) {

        const order =
            findOrderByText(
                quotedText
            );

        if (order) {

            return order;

        }

    }

    return null;
}

// ============================================================
// СОЗДАНИЕ ЗАКАЗА
// ============================================================

function createOrder({
    text,
    messageId,
    remoteJid,
    senderJid,
    pushName
}) {

    const existing =
        findOrderByMessageId(
            messageId
        );

    if (existing) {

        addMessageToOrder(
            existing,
            messageId
        );

        return existing;

    }

    const normalized =
        normalizeText(text);

    const now =
        Date.now();

    for (
        const order of orders
    ) {

        const sameText =
            normalizeText(
                order.text || ''
            ) === normalized;

        const recent =
            now -
            Number(
                order.createdAtMs || 0
            ) < 120000;

        if (
            sameText &&
            recent
        ) {

            addMessageToOrder(
                order,
                messageId
            );

            console.log(
                `♻️ Дубликат. Используем заказ #${order.id}`
            );

            return order;

        }

    }

    const order = {

        id:
            makeOrderId(),

        text:
            normalized,

        status:
            STATUS.NEW,

        createdAt:
            new Date().toISOString(),

        createdAtMs:
            now,

        updatedAt:
            new Date().toISOString(),

        updatedAtMs:
            now,

        remoteJid:
            remoteJid || '',

        senderJid:
            senderJid || '',

        senderName:
            pushName || '',

        messageIds:
            [],

        whatsappMsgIds:
            [],

        outgoingMessageIds:
            [],

        deliveredBy:
            null,

        deliveredAt:
            null,

        deliveredAtMs:
            null,

        paymentInfo:
            '',

        returnRequestedAt:
            null,

        returnRequestedBy:
            null,

        returnedBy:
            null,

        returnedAt:
            null,

        returnedAtMs:
            null,

        returnPayment:
            '',

        lastDriver:
            null,

        history:
            []

    };

    addMessageToOrder(
        order,
        messageId
    );

    orders.push(order);

    saveOrders();

    console.log('');
    console.log(
        `📦 НОВЫЙ ЗАКАЗ #${order.id}`
    );

    console.log(
        order.text
    );

    return order;
}

// ============================================================
// ИЗМЕНЕНИЕ ЗАКАЗА
// ============================================================

function updateOrder(
    order,
    patch
) {

    if (!order) {
        return false;
    }

    Object.assign(
        order,
        patch,
        {
            updatedAt:
                new Date().toISOString(),

            updatedAtMs:
                Date.now()
        }
    );

    saveOrders();

    console.log(
        `💾 Заказ #${order.id} сохранён. Статус: ${order.status}`
    );

    return true;
}

// ============================================================
// ИСТОРИЯ
// ============================================================

function addHistory(
    order,
    type,
    data = {}
) {

    if (!order.history) {

        order.history = [];

    }

    order.history.push({

        type,

        time:
            new Date().toISOString(),

        ...data

    });

    if (
        order.history.length >
        100
    ) {

        order.history =
            order.history.slice(
                -100
            );

    }

}

// ============================================================
// "ОСТАВИЛ"
// ============================================================

async function processLeave(
    message,
    order,
    driver,
    text
) {

    if (!order) {
        return false;
    }

    if (!driver) {

        console.log(
            '❌ Оставил: водитель не определён'
        );

        return false;
    }

    order.status =
        STATUS.CLIENT;

    order.deliveredBy =
        driver.name;

    order.deliveredAt =
        new Date().toISOString();

    order.deliveredAtMs =
        Date.now();

    order.paymentInfo =
        extractPayment(text);

    order.lastDriver =
        driver.name;

    addHistory(
        order,
        'delivered',
        {
            driver:
                driver.name,

            driverPhone:
                driver.phone,

            text
        }
    );

    updateOrder(
        order,
        {}
    );

    console.log('');
    console.log(
        `✅ ЗАКАЗ #${order.id} — У КЛИЕНТА`
    );

    console.log(
        `👤 Оставил: ${driver.name}`
    );

    if (
        order.paymentInfo
    ) {

        console.log(
            `💰 Оплата: ${order.paymentInfo}`
        );

    }

    return true;
}

// ============================================================
// "ЗАБРАТЬ"
// ============================================================

async function processReturnRequest(
    message,
    order,
    requester,
    text
) {

    if (!order) {
        return false;
    }

    order.status =
        STATUS.RETURN_QUEUE;

    order.returnRequestedAt =
        new Date().toISOString();

    order.returnRequestedBy =
        requester?.name ||
        message?.pushName ||
        'Участник группы';

    addHistory(
        order,
        'return_request',
        {
            requester:
                requester?.name ||
                message?.pushName ||
                '',

            text
        }
    );

    updateOrder(
        order,
        {}
    );

    console.log('');
    console.log(
        `🚚 ЗАКАЗ #${order.id} → НУЖНО ЗАБРАТЬ`
    );

    return true;
}

// ============================================================
// "ЗАБРАЛ"
// ============================================================

async function processTake(
    message,
    order,
    driver,
    text
) {

    if (!order) {
        return false;
    }

    if (!driver) {

        console.log(
            '❌ Забрал: водитель не определён'
        );

        return false;
    }

    order.status =
        STATUS.RETURNED;

    order.returnedBy =
        driver.name;

    order.returnedAt =
        new Date().toISOString();

    order.returnedAtMs =
        Date.now();

    order.returnPayment =
        extractPayment(text);

    order.lastDriver =
        driver.name;

    addHistory(
        order,
        'returned',
        {
            driver:
                driver.name,

            driverPhone:
                driver.phone,

            text
        }
    );

    updateOrder(
        order,
        {}
    );

    console.log('');
    console.log(
        `🏁 ЗАКАЗ #${order.id} → ЗАБРАНО`
    );

    console.log(
        `👤 Забрал: ${driver.name}`
    );

    if (
        order.returnPayment
    ) {

        console.log(
            `💰 Доплата: ${order.returnPayment}`
        );

    }

    return true;
}

// ============================================================
// OUTGOING
// ============================================================

function rememberOutgoing(
    order,
    messageId,
    destination,
    driver
) {

    if (!order || !messageId) {
        return;
    }

    if (!order.outgoingMessageIds) {

        order.outgoingMessageIds =
            [];

    }

    if (
        !order.outgoingMessageIds
            .includes(messageId)
    ) {

        order.outgoingMessageIds.push(
            messageId
        );

    }

    messageToOrder.set(
        messageId,
        order.id
    );

    outgoingToOrder.set(
        messageId,
        order.id
    );

    if (driver) {

        outgoingToDriver.set(
            messageId,
            driver.name
        );

    }

    addHistory(
        order,
        'sent_to_driver',
        {
            messageId,

            destination,

            driver:
                driver?.name || null
        }
    );

    saveOrders();

    console.log('');
    console.log(
        `📤 ЗАКАЗ #${order.id}`
    );

    console.log(
        `📱 ОТПРАВЛЕН В: ${destination}`
    );

    console.log(
        `🆔 outgoing ID: ${messageId}`
    );

    console.log(
        `👤 Водитель: ${
            driver?.name ||
            'не определён'
        }`
    );
}

// ============================================================
// ОТПРАВИТЬ ВОДИТЕЛЮ
// ============================================================

async function sendOrderToDriver(
    order,
    driver
) {

    if (!sock) {

        throw new Error(
            'WhatsApp ещё не подключён'
        );

    }

    if (!order) {

        throw new Error(
            'Заказ не найден'
        );

    }

    if (!driver) {

        throw new Error(
            'Водитель не найден'
        );

    }

    let destination = '';

    destination =
        driverLids.get(
            normalizePhone(
                driver.phone
            )
        ) || '';

    if (!destination) {

        destination =
            await resolvePnToLid(
                driver.phone
            );

    }

    if (!destination) {

        destination =
            normalizePhone(
                driver.phone
            ) +
            '@s.whatsapp.net';

    }

    const sent =
        await sock.sendMessage(
            destination,
            {
                text:
                    order.text
            }
        );

    const messageId =
        sent?.key?.id;

    if (!messageId) {

        throw new Error(
            'WhatsApp не вернул ID отправленного сообщения'
        );

    }

    await rememberDriverJid(
        driver,
        destination
    );

    rememberOutgoing(
        order,
        messageId,
        destination,
        driver
    );

    return sent;
}

// ============================================================
// УВЕДОМЛЕНИЯ В ГРУППУ ОТКЛЮЧЕНЫ
// ============================================================

async function notifyGroup(
    order,
    text
) {

    return;
}

// ============================================================
// ОБРАБОТКА СООБЩЕНИЯ
// ============================================================

async function handleIncomingMessage(
    msg
) {

    if (!msg?.message) {
        return;
    }

    if (
        msg.key?.fromMe &&
        !isGroupJid(
            msg.key.remoteJid
        )
    ) {

        return;

    }

    const remoteJid =
        msg.key?.remoteJid ||
        '';

    const messageId =
        msg.key?.id ||
        '';

    if (!messageId) {
        return;
    }

    const senderJid =
        msg.key?.participant ||
        msg.participant ||
        remoteJid;

    const pushName =
        msg.pushName ||
        msg.verifiedBizName ||
        '';

    const text =
        normalizeText(
            getMessageText(msg)
        );

    if (!text) {
        return;
    }

    const duplicateKey =
        remoteJid +
        ':' +
        messageId;

    if (
        recentMessages.has(
            duplicateKey
        )
    ) {

        return;

    }

    recentMessages.set(
        duplicateKey,
        Date.now()
    );

    setTimeout(
        () => {

            recentMessages.delete(
                duplicateKey
            );

        },
        5 * 60 * 1000
    );

    console.log('');
    console.log(
        '============================='
    );

    console.log(
        '📩 НОВОЕ СООБЩЕНИЕ'
    );

    console.log(
        `📱 remoteJid: ${remoteJid}`
    );

    console.log(
        `👤 senderJid: ${senderJid}`
    );

    console.log(
        `🏷 pushName: ${pushName}`
    );

    console.log(
        `📝 text: ${text}`
    );

    console.log(
        `🆔 messageId: ${messageId}`
    );

    // ========================================================
    // ВОДИТЕЛЬ
    // ========================================================

    const driver =
        await identifyDriver(
            senderJid,
            msg
        );

    if (driver) {

        console.log(
            `👤 ВОДИТЕЛЬ: ${driver.name}`
        );

    } else {

        console.log(
            '👤 ВОДИТЕЛЬ: не водитель'
        );

    }

    // ========================================================
    // СВАЙП
    // ========================================================

    const quotedStanzaId =
        getQuotedStanzaId(msg);

    const quotedText =
        getQuotedText(msg);

    if (quotedStanzaId) {

        console.log(
            `↩️ quotedStanzaId: ${quotedStanzaId}`
        );

    }

    if (quotedText) {

        console.log(
            `↩️ quotedText: ${quotedText}`
        );

    }

    // ========================================================
    // КОМАНДЫ
    // ========================================================

    const isLeave =
        isLeaveCommand(text);

    const isTake =
        isTakeCommand(text);

    const isReturn =
        isReturnRequest(text);

    if (
        isLeave ||
        isTake ||
        isReturn
    ) {

        let order =
            findOrderFromReply(
                msg,
                quotedStanzaId,
                quotedText
            );

        if (
            !order &&
            quotedText
        ) {

            order =
                findOrderByText(
                    quotedText
                );

        }

        if (order) {

            console.log(
                `🎯 ЗАКАЗ НАЙДЕН: #${order.id}`
            );

            // =================================================
            // ОСТАВИЛ
            // =================================================

            if (isLeave) {

                if (!driver) {

                    console.log(
                        '⛔ Оставил отклонён: отправитель не водитель'
                    );

                    return;

                }

                await processLeave(
                    msg,
                    order,
                    driver,
                    text
                );

                return;
            }

            // =================================================
            // ЗАБРАЛ
            // =================================================

            if (isTake) {

                if (!driver) {

                    console.log(
                        '⛔ Забрал отклонён: отправитель не водитель'
                    );

                    return;

                }

                await processTake(
                    msg,
                    order,
                    driver,
                    text
                );

                return;
            }

            // =================================================
            // ЗАБРАТЬ
            // =================================================

            if (isReturn) {

                await processReturnRequest(
                    msg,
                    order,
                    driver,
                    text
                );

                return;
            }

        } else {

            console.log(
                '❌ Не удалось найти заказ по свайпу'
            );

            return;
        }
    }

    // ========================================================
    // СУЩЕСТВУЮЩЕЕ СООБЩЕНИЕ
    // ========================================================

    const knownOrder =
        findOrderByMessageId(
            messageId
        );

    if (knownOrder) {

        console.log(
            `ℹ️ Сообщение уже относится к заказу #${knownOrder.id}`
        );

        return;
    }

    // ========================================================
    // ЛИЧНЫЙ ЧАТ
    // ========================================================

    if (
        !isGroupJid(remoteJid)
    ) {

        console.log(
            '💬 ЛИЧНЫЙ ЧАТ'
        );

        if (driver) {

            console.log(
                `👤 Водитель: ${driver.name}`
            );

        }

        return;
    }

    // ========================================================
    // НОВЫЙ ЗАКАЗ
    // ========================================================

    if (
        looksLikeOrder(text)
    ) {

        const order =
            createOrder({
                text,
                messageId,
                remoteJid,
                senderJid,
                pushName
            });

        console.log(
            `🔗 ${messageId} → #${order.id}`
        );

        return;
    }

    console.log(
        'ℹ️ Обычное сообщение группы'
    );
}

// ============================================================
// WHATSAPP EVENTS
// ============================================================

function attachEvents() {

    sock.ev.on(
        'connection.update',
        async update => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            if (qr) {

                lastQR = qr;

                console.log('');
                console.log(
                    '📲 ОТСКАНИРУЙ QR-КОД'
                );

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );

            }

            if (
                connection === 'open'
            ) {

                isConnected =
                    true;

                lastQR = null;

                console.log('');
                console.log(
                    '================================'
                );

                console.log(
                    '✅ WHATSAPP БОТ ПОДКЛЮЧЕН'
                );

                console.log(
                    '================================'
                );

                console.log('');
                console.log(
                    '🤖 Админ/бот:'
                );

                console.log(
                    '   +7 776 301 5076'
                );

                console.log('');
                console.log(
                    '👥 Водители:'
                );

                for (
                    const driver
                    of DRIVERS
                ) {

                    console.log(
                        `   ${driver.name} : +${driver.phone}`
                    );

                }

                console.log('');
                console.log(
                    `🌐 Веб-панель: http://localhost:${PORT}`
                );

                for (
                    const driver
                    of DRIVERS
                ) {

                    try {

                        const lid =
                            await resolvePnToLid(
                                driver.phone
                            );

                        if (lid) {

                            driverLids.set(
                                normalizePhone(
                                    driver.phone
                                ),
                                lid
                            );

                            console.log(
                                `🔗 ${driver.name}: ${lid}`
                            );

                        }

                    } catch (e) {}

                }

            }

            if (
                connection === 'close'
            ) {

                isConnected =
                    false;

                const code =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                console.log('');
                console.log(
                    `❌ WhatsApp отключён. Код: ${code || 'неизвестно'}`
                );

                if (
                    code ===
                    DisconnectReason.loggedOut
                ) {

                    lastQR = null;

                    console.log(
                        '🚪 Сессия вышла из аккаунта.'
                    );

                    return;
                }

                if (!reconnectTimer) {

                    console.log(
                        '🔄 Переподключение через 5 секунд...'
                    );

                    reconnectTimer =
                        setTimeout(
                            () => {

                                reconnectTimer =
                                    null;

                                startWhatsApp();

                            },
                            5000
                        );

                }

            }

        }
    );

    sock.ev.on(
        'messages.upsert',
        async event => {

            if (
                event.type !== 'notify' &&
                event.type !== 'append'
            ) {

                return;

            }

            for (
                const msg
                of event.messages || []
            ) {

                try {

                    await handleIncomingMessage(
                        msg
                    );

                } catch (err) {

                    console.log('');
                    console.log(
                        '❌ ОШИБКА ОБРАБОТКИ СООБЩЕНИЯ'
                    );

                    console.log(
                        err?.stack ||
                        err?.message ||
                        err
                    );

                }

            }

        }
    );

    sock.ev.on(
        'messages.update',
        updates => {}
    );
}

// ============================================================
// START WHATSAPP
// ============================================================

async function startWhatsApp() {

    if (isStarting) {
        return;
    }

    isStarting =
        true;

    try {

        console.log('');
        console.log(
            '================================'
        );

        console.log(
            '🚀 ЗАПУСК WHATSAPP DRIVER BOT'
        );

        console.log(
            '================================'
        );

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            );

        let version;

        try {

            const latest =
                await fetchLatestBaileysVersion();

            version =
                latest?.version;

        } catch (e) {

            version =
                undefined;

        }

        const options = {

            auth:
                state,

            printQRInTerminal:
                false,

            browser: [
                'Mac OS',
                'Chrome',
                '14.4.1'
            ],

            markOnlineOnConnect:
                true,

            syncFullHistory:
                false,

            generateHighQualityLinkPreview:
                false

        };

        if (version) {

            options.version =
                version;

        }

        sock =
            makeWASocket(
                options
            );

        sock.ev.on(
            'creds.update',
            saveCreds
        );

        attachEvents();

    } catch (err) {

        console.log('');
        console.log(
            '❌ ОШИБКА ЗАПУСКА:',
            err?.stack ||
            err?.message ||
            err
        );

        isStarting =
            false;

        if (!reconnectTimer) {

            reconnectTimer =
                setTimeout(
                    () => {

                        reconnectTimer =
                            null;

                        startWhatsApp();

                    },
                    5000
                );

        }

        return;
    }

    isStarting =
        false;
}

// ============================================================
// EXPRESS
// ============================================================

const app =
    express();

app.use(
    express.json({
        limit: '2mb'
    })
);

app.use(
    express.urlencoded({
        extended: true
    })
);

// ============================================================
// STATUS
// ============================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json({

            ok:
                true,

            connected:
                isConnected,

            bot:
                '77763015076',

            admin:
                '+7 776 301 5076',

            drivers:
                DRIVERS.map(
                    driver => ({

                        id:
                            driver.id,

                        name:
                            driver.name,

                        phone:
                            driver.phone,

                        lid:
                            driverLids.get(
                                normalizePhone(
                                    driver.phone
                                )
                            ) || null

                    })
                ),

            total:
                orders.length,

            qr:
                lastQR || null,

            time:
                new Date()
                    .toISOString()

        });

    }
);

// ============================================================
// QR
// ============================================================

app.get(
    '/api/qr',
    (req, res) => {

        res.json({

            ok:
                true,

            connected:
                isConnected,

            qr:
                lastQR || null

        });

    }
);

// ============================================================
// ORDERS
// ============================================================

app.get(
    '/api/orders',
    (req, res) => {

        const result =
            [...orders]
                .sort(
                    (a, b) =>
                        Number(
                            b.createdAtMs ||
                            0
                        ) -
                        Number(
                            a.createdAtMs ||
                            0
                        )
                );

        res.json({

            ok:
                true,

            orders:
                result

        });

    }
);

// ============================================================
// ONE ORDER
// ============================================================

app.get(
    '/api/orders/:id',
    (req, res) => {

        const order =
            orders.find(
                x =>
                    String(x.id) ===
                    String(
                        req.params.id
                    )
            );

        if (!order) {

            return res
                .status(404)
                .json({

                    ok:
                        false,

                    error:
                        'Заказ не найден'

                });

        }

        res.json({

            ok:
                true,

            order

        });

    }
);

// ============================================================
// SEND ORDER TO DRIVER
// ============================================================

app.post(
    '/api/orders/:id/send',
    async (req, res) => {

        try {

            const order =
                orders.find(
                    x =>
                        String(x.id) ===
                        String(
                            req.params.id
                        )
                );

            if (!order) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            'Заказ не найден'

                    });

            }

            const driverId =
                req.body?.driverId;

            const driver =
                DRIVERS.find(
                    x =>
                        x.id ===
                        driverId
                );

            if (!driver) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            'Водитель не найден'

                    });

            }

            const sent =
                await sendOrderToDriver(
                    order,
                    driver
                );

            res.json({

                ok:
                    true,

                orderId:
                    order.id,

                driver:
                    driver.name,

                messageId:
                    sent?.key?.id ||
                    null

            });

        } catch (err) {

            console.log(
                '❌ API send error:',
                err.message
            );

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        err.message

                });

        }

    }
);

// ============================================================
// УДАЛЕНИЕ ЗАКАЗА
// ============================================================

app.post(
    '/api/orders/:id/delete',
    (req, res) => {

        const password =
            String(
                req.body?.password ||
                ''
            );

        if (
            password !==
            DELETE_PASSWORD
        ) {

            return res
                .status(403)
                .json({

                    ok:
                        false,

                    error:
                        'Неверный пароль'

                });

        }

        const index =
            orders.findIndex(
                x =>
                    String(x.id) ===
                    String(
                        req.params.id
                    )
            );

        if (index === -1) {

            return res
                .status(404)
                .json({

                    ok:
                        false,

                    error:
                        'Заказ не найден'

                });

        }

        const order =
            orders[index];

        backupOrders();

        orders.splice(
            index,
            1
        );

        rebuildIndexes();

        saveOrders();

        console.log(
            `🗑 Заказ #${order.id} удалён`
        );

        res.json({

            ok:
                true,

            message:
                `Заказ #${order.id} удалён`

        });

    }
);

// ============================================================
// ВЕБ-ПАНЕЛЬ
// ============================================================

app.get(
    '/',
    (req, res) => {

        res.send(`
<!DOCTYPE html>

<html lang="ru">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
/>

<title>База проката</title>

<!-- QR БИБЛИОТЕКА -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>

<style>

* {
    box-sizing: border-box;
}

body {

    margin: 0;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

    background:
        #f3f4f6;

    color:
        #111827;

}

header {

    background:
        #111827;

    color:
        white;

    padding:
        20px;

    position:
        sticky;

    top:
        0;

    z-index:
        10;

    box-shadow:
        0 2px 10px
        rgba(0,0,0,.15);

}

.header-row {

    display:
        flex;

    align-items:
        center;

    justify-content:
        space-between;

    gap:
        10px;

}

.logo {

    font-size:
        22px;

    font-weight:
        800;

}

.connection {

    font-size:
        13px;

    font-weight:
        700;

}

.online {

    color:
        #4ade80;

}

.offline {

    color:
        #f87171;

}

/* =========================================================
   QR
========================================================= */

.qr-panel {

    background:
        white;

    margin:
        18px;

    border-radius:
        20px;

    padding:
        22px;

    text-align:
        center;

    box-shadow:
        0 4px 15px
        rgba(0,0,0,.08);

}

.qr-title {

    font-size:
        21px;

    font-weight:
        900;

    margin-bottom:
        8px;

}

.qr-description {

    color:
        #6b7280;

    font-size:
        14px;

    line-height:
        1.5;

    margin-bottom:
        18px;

}

#qrcode {

    width:
        260px;

    min-height:
        260px;

    margin:
        0 auto;

    display:
        flex;

    align-items:
        center;

    justify-content:
        center;

}

#qrcode img,
#qrcode canvas {

    width:
        250px !important;

    height:
        250px !important;

    max-width:
        100%;

}

.qr-hidden {

    display:
        none;

}

.qr-wait {

    color:
        #6b7280;

    padding:
        40px 10px;

}

.qr-connected {

    color:
        #166534;

    background:
        #dcfce7;

    border-radius:
        12px;

    padding:
        12px;

    font-weight:
        700;

}

/* =========================================================
   ПАПКИ
========================================================= */

.folders {

    display:
        grid;

    grid-template-columns:
        repeat(4, 1fr);

    gap:
        14px;

    padding:
        18px;

}

.folder {

    border:
        0;

    border-radius:
        18px;

    min-height:
        135px;

    padding:
        18px;

    background:
        white;

    box-shadow:
        0 4px 15px
        rgba(0,0,0,.08);

    cursor:
        pointer;

    text-align:
        left;

    transition:
        transform .15s,
        box-shadow .15s;

}

.folder:hover {

    transform:
        translateY(-2px);

    box-shadow:
        0 7px 20px
        rgba(0,0,0,.12);

}

.folder-icon {

    font-size:
        38px;

    margin-bottom:
        12px;

}

.folder-title {

    font-size:
        16px;

    font-weight:
        800;

}

.folder-count {

    font-size:
        30px;

    font-weight:
        900;

    margin-top:
        5px;

}

.folder-new {

    background:
        #eff6ff;

}

.folder-take {

    background:
        #fff7ed;

}

.folder-returned {

    background:
        #eff6ff;

}

.folder-client {

    background:
        #ecfdf5;

}

/* =========================================================
   СПИСОК
========================================================= */

.content {

    padding:
        0 18px 30px;

}

.list-header {

    display:
        flex;

    align-items:
        center;

    justify-content:
        space-between;

    margin:
        5px 0 15px;

}

.list-title {

    font-size:
        21px;

    font-weight:
        900;

}

.back {

    display:
        none;

    border:
        0;

    background:
        #111827;

    color:
        white;

    padding:
        10px 14px;

    border-radius:
        10px;

    cursor:
        pointer;

}

/* =========================================================
   ЗАКАЗ
========================================================= */

.order {

    background:
        white;

    border-radius:
        16px;

    padding:
        16px;

    margin-bottom:
        12px;

    box-shadow:
        0 3px 12px
        rgba(0,0,0,.07);

}

.order-top {

    display:
        flex;

    align-items:
        center;

    justify-content:
        space-between;

    gap:
        10px;

}

.order-id {

    font-size:
        19px;

    font-weight:
        900;

}

.status {

    padding:
        6px 10px;

    border-radius:
        9px;

    font-size:
        12px;

    font-weight:
        800;

    background:
        #e5e7eb;

}

.status.new {

    background:
        #dbeafe;

    color:
        #1d4ed8;

}

.status.client {

    background:
        #dcfce7;

    color:
        #166534;

}

.status.return_queue {

    background:
        #ffedd5;

    color:
        #9a3412;

}

.status.returned {

    background:
        #dbeafe;

    color:
        #1e40af;

}

.order-text {

    white-space:
        pre-wrap;

    background:
        #f9fafb;

    border-radius:
        11px;

    padding:
        12px;

    margin:
        12px 0;

    line-height:
        1.5;

    color:
        #1f2937;

}

.info {

    color:
        #4b5563;

    font-size:
        14px;

    line-height:
        1.7;

}

.order-actions {

    display:
        flex;

    justify-content:
        flex-end;

    margin-top:
        12px;

}

.delete {

    border:
        0;

    background:
        #fee2e2;

    color:
        #b91c1c;

    padding:
        9px 12px;

    border-radius:
        9px;

    cursor:
        pointer;

    font-weight:
        700;

}

/* =========================================================
   ПУСТО
========================================================= */

.empty {

    background:
        white;

    border-radius:
        16px;

    padding:
        45px 20px;

    text-align:
        center;

    color:
        #6b7280;

}

/* =========================================================
   МОБИЛЬНЫЙ
========================================================= */

@media(max-width:700px) {

    .folders {

        grid-template-columns:
            repeat(2, 1fr);

        gap:
            10px;

        padding:
            12px;

    }

    .folder {

        min-height:
            125px;

        padding:
            14px;

    }

    .folder-icon {

        font-size:
            32px;

    }

    .folder-count {

        font-size:
            26px;

    }

    .content {

        padding:
            0 12px 25px;

    }

    header {

        padding:
            16px;

    }

    .qr-panel {

        margin:
            12px;

        padding:
            16px;

    }

    #qrcode {

        width:
            240px;

        min-height:
            240px;

    }

    #qrcode img,
    #qrcode canvas {

        width:
            230px !important;

        height:
            230px !important;

    }

}

</style>

</head>

<body>

<header>

<div class="header-row">

<div class="logo">
    🧰 База проката
</div>

<div
    id="connection"
    class="connection"
>
    Проверка...
</div>

</div>

</header>


<!-- ======================================================
     QR WHATSAPP
====================================================== -->

<div
    id="qrPanel"
    class="qr-panel"
>

<div class="qr-title">
    📱 Подключение WhatsApp
</div>

<div class="qr-description">
    Открой WhatsApp на телефоне,<br>
    который нужно подключить к боту,<br>
    и отсканируй этот QR-код.
</div>

<div id="qrcode">

<div class="qr-wait">
    Ожидание QR-кода...
</div>

</div>

<div
    id="qrStatus"
    class="qr-wait"
>
    Получение QR-кода...
</div>

</div>


<!-- ======================================================
     ПАПКИ
====================================================== -->

<div
    id="folders"
    class="folders"
>

<button
    class="folder folder-new"
    onclick="openFolder('new')"
>

<div class="folder-icon">
    📂
</div>

<div class="folder-title">
    Новый заказ
</div>

<div
    id="count-new"
    class="folder-count"
>
0
</div>

</button>


<button
    class="folder folder-take"
    onclick="openFolder('return_queue')"
>

<div class="folder-icon">
    📂
</div>

<div class="folder-title">
    Нужно забрать
</div>

<div
    id="count-return_queue"
    class="folder-count"
>
0
</div>

</button>


<button
    class="folder folder-returned"
    onclick="openFolder('returned')"
>

<div class="folder-icon">
    📂
</div>

<div class="folder-title">
    Забрано
</div>

<div
    id="count-returned"
    class="folder-count"
>
0
</div>

</button>


<button
    class="folder folder-client"
    onclick="openFolder('client')"
>

<div class="folder-icon">
    📂
</div>

<div class="folder-title">
    В аренде
</div>

<div
    id="count-client"
    class="folder-count"
>
0
</div>

</button>

</div>


<!-- ======================================================
     СПИСОК
====================================================== -->

<div
    id="content"
    class="content"
    style="display:none"
>

<div class="list-header">

<div
    id="listTitle"
    class="list-title"
>
</div>

<button
    id="backButton"
    class="back"
    onclick="closeFolder()"
>
← Назад
</button>

</div>

<div id="orders"></div>

</div>


<script>

let allOrders = [];

let currentFolder = null;

let lastDisplayedQR = '';

let qrObject = null;

const statusNames = {

    new:
        'Новый заказ',

    client:
        'В аренде',

    return_queue:
        'Нужно забрать',

    returned:
        'Забрано'

};

function escapeHtml(value) {

    return String(value || '')

        .replaceAll(
            '&',
            '&amp;'
        )

        .replaceAll(
            '<',
            '&lt;'
        )

        .replaceAll(
            '>',
            '&gt;'
        )

        .replaceAll(
            '"',
            '&quot;'
        )

        .replaceAll(
            "'",
            '&#039;'
        );

}

function updateCounts() {

    const newCount =
        allOrders.filter(
            x =>
                x.status === 'new'
        ).length;

    const takeCount =
        allOrders.filter(
            x =>
                x.status ===
                'return_queue'
        ).length;

    const returnedCount =
        allOrders.filter(
            x =>
                x.status ===
                'returned'
        ).length;

    const clientCount =
        allOrders.filter(
            x =>
                x.status ===
                'client'
        ).length;

    document
        .getElementById(
            'count-new'
        )
        .textContent =
            newCount;

    document
        .getElementById(
            'count-return_queue'
        )
        .textContent =
            takeCount;

    document
        .getElementById(
            'count-returned'
        )
        .textContent =
            returnedCount;

    document
        .getElementById(
            'count-client'
        )
        .textContent =
            clientCount;

}

function openFolder(status) {

    currentFolder =
        status;

    document
        .getElementById(
            'folders'
        )
        .style.display =
            'none';

    document
        .getElementById(
            'content'
        )
        .style.display =
            'block';

    document
        .getElementById(
            'backButton'
        )
        .style.display =
            'block';

    document
        .getElementById(
            'listTitle'
        )
        .textContent =
            statusNames[status];

    render();

}

function closeFolder() {

    currentFolder =
        null;

    document
        .getElementById(
            'content'
        )
        .style.display =
            'none';

    document
        .getElementById(
            'folders'
        )
        .style.display =
            'grid';

}

function render() {

    const container =
        document.getElementById(
            'orders'
        );

    if (!currentFolder) {

        container.innerHTML =
            '';

        return;

    }

    const list =
        allOrders.filter(
            x =>
                x.status ===
                currentFolder
        );

    if (!list.length) {

        container.innerHTML =

            '<div class="empty">' +

            '📂<br><br>' +

            'Здесь пока ничего нет' +

            '</div>';

        return;

    }

    container.innerHTML =
        list
            .map(
                renderOrder
            )
            .join('');

}

function renderOrder(order) {

    return \`
<div class="order">

<div class="order-top">

<div class="order-id">
    #\${escapeHtml(order.id)}
</div>

<div class="status \${escapeHtml(order.status)}">
    \${escapeHtml(
        statusNames[
            order.status
        ] ||
        order.status
    )}
</div>

</div>

<div class="order-text">
\${escapeHtml(order.text)}
</div>

<div class="info">

\${order.deliveredBy
    ? '👤 Оставил: ' +
      escapeHtml(
          order.deliveredBy
      ) +
      '<br>'
    : ''}

\${order.paymentInfo
    ? '💰 Оплата: ' +
      escapeHtml(
          order.paymentInfo
      ) +
      '<br>'
    : ''}

\${order.returnRequestedAt
    ? '🚚 Запрошен забор<br>'
    : ''}

\${order.returnedBy
    ? '🏁 Забрал: ' +
      escapeHtml(
          order.returnedBy
      ) +
      '<br>'
    : ''}

\${order.returnPayment
    ? '💰 Доплата: ' +
      escapeHtml(
          order.returnPayment
      ) +
      '<br>'
    : ''}

</div>

<div class="order-actions">

<button
    class="delete"
    onclick="deleteOrder('\${escapeHtml(order.id)}')"
>
🗑 Удалить
</button>

</div>

</div>
\`;

}

function showQR(qr) {

    const panel =
        document.getElementById(
            'qrPanel'
        );

    const container =
        document.getElementById(
            'qrcode'
        );

    const status =
        document.getElementById(
            'qrStatus'
        );

    if (!qr) {

        return;

    }

    if (
        qr ===
        lastDisplayedQR
    ) {

        return;

    }

    lastDisplayedQR =
        qr;

    container.innerHTML =
        '';

    try {

        qrObject =
            new QRCode(
                container,
                {
                    text:
                        qr,

                    width:
                        250,

                    height:
                        250,

                    correctLevel:
                        QRCode.CorrectLevel.M
                }
            );

        status.className =
            'qr-connected';

        status.textContent =
            '📷 Наведи камеру WhatsApp на QR-код';

        panel.classList.remove(
            'qr-hidden'
        );

    } catch (e) {

        container.innerHTML =
            '<div class="qr-wait">Ошибка создания QR-кода</div>';

        status.className =
            'qr-wait';

        status.textContent =
            'Ошибка QR';

    }

}

function hideQR() {

    const panel =
        document.getElementById(
            'qrPanel'
        );

    const status =
        document.getElementById(
            'qrStatus'
        );

    panel.classList.add(
        'qr-hidden'
    );

    status.className =
        'qr-wait';

    status.textContent =
        'WhatsApp подключён';

    lastDisplayedQR =
        '';

}

async function loadStatus() {

    try {

        const response =
            await fetch(
                '/api/status',
                {
                    cache:
                        'no-store'
                }
            );

        const data =
            await response.json();

        const element =
            document.getElementById(
                'connection'
            );

        if (
            data.connected
        ) {

            element.innerHTML =
                '<span class="online">● ONLINE</span>';

            hideQR();

        } else {

            element.innerHTML =
                '<span class="offline">● OFFLINE</span>';

            if (data.qr) {

                showQR(
                    data.qr
                );

            } else {

                const status =
                    document.getElementById(
                        'qrStatus'
                    );

                status.className =
                    'qr-wait';

                status.textContent =
                    'Ожидание нового QR-кода...';

                document
                    .getElementById(
                        'qrPanel'
                    )
                    .classList.remove(
                        'qr-hidden'
                    );

            }

        }

    } catch (e) {

        document
            .getElementById(
                'connection'
            )
            .innerHTML =
                '<span class="offline">● OFFLINE</span>';

    }

}

async function loadQR() {

    try {

        const response =
            await fetch(
                '/api/qr',
                {
                    cache:
                        'no-store'
                }
            );

        const data =
            await response.json();

        if (
            data.connected
        ) {

            hideQR();

            return;

        }

        if (data.qr) {

            showQR(
                data.qr
            );

        }

    } catch (e) {}

}

async function deleteOrder(id) {

    const password =
        prompt(
            'Введите пароль для удаления заказа:'
        );

    if (
        password === null
    ) {

        return;

    }

    if (!password) {

        alert(
            'Пароль не введён'
        );

        return;

    }

    if (
        password !== '8989'
    ) {

        alert(
            '❌ Неверный пароль'
        );

        return;

    }

    const confirmed =
        confirm(
            'Удалить заказ #' +
            id +
            '?'
        );

    if (!confirmed) {

        return;

    }

    try {

        const response =
            await fetch(
                '/api/orders/' +
                encodeURIComponent(id) +
                '/delete',
                {

                    method:
                        'POST',

                    headers: {

                        'Content-Type':
                            'application/json'

                    },

                    body:
                        JSON.stringify({
                            password
                        })

                }
            );

        const data =
            await response.json();

        if (!data.ok) {

            alert(
                data.error ||
                'Ошибка удаления'
            );

            return;

        }

        await loadOrders();

    } catch (e) {

        alert(
            e.message
        );

    }

}

async function loadOrders() {

    try {

        const response =
            await fetch(
                '/api/orders',
                {
                    cache:
                        'no-store'
                }
            );

        const data =
            await response.json();

        allOrders =
            data.orders || [];

        updateCounts();

        render();

    } catch (e) {}

}

loadOrders();

loadStatus();

loadQR();

setInterval(
    loadOrders,
    3000
);

setInterval(
    loadStatus,
    2000
);

setInterval(
    loadQR,
    2000
);

</script>

</body>

</html>
        `);

    }
);

// ============================================================
// HTTP
// ============================================================

const server =
    http.createServer(
        app
    );

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log(
            `🌐 Веб-панель: http://localhost:${PORT}`
        );

        console.log(
            `📁 База: ${DB_FILE}`
        );

        console.log(
            `📁 Авторизация: ${AUTH_DIR}`
        );

        console.log('');
        console.log(
            '🤖 АДМИН/БОТ: +7 776 301 5076'
        );

        console.log(
            '👤 СЕРГЕЙ: +7 705 435 7734'
        );

        console.log(
            '👤 НУРАСЫЛ: +7 705 263 2250'
        );

        console.log(
            '👤 МАКСАТ: +7 705 290 2150'
        );

    }
);

// ============================================================
// START
// ============================================================

ensureFiles();

startWhatsApp();

// ============================================================
// ЗАВЕРШЕНИЕ
// ============================================================

process.on(
    'SIGINT',
    () => {

        console.log('');
        console.log(
            '🛑 Остановка бота...'
        );

        saveOrders();

        process.exit(0);

    }
);

process.on(
    'SIGTERM',
    () => {

        saveOrders();

        process.exit(0);

    }
);
