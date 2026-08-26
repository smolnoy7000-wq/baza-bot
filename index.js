const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Настройка путей для постоянного хранилища (Volume /data)
const DATA_DIR = process.env.PERSISTENT_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const DB_FILE = path.join(DATA_DIR, 'orders.json');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = '123'; // Пароль для удаления заказов в веб-панели

let sock;
let qrCodeData = null;
let connectionStatus = 'disconnected';

// Загрузка заказов из файла
function loadOrders() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Ошибка чтения базы заказов:', e);
    }
    return [];
}

// Сохранение заказов в файл
function saveOrders(orders) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (e) {
        console.error('Ошибка записи базы заказов:', e);
    }
}

// Инициализация WhatsApp бота (Baileys)
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr_ready';
            console.log('📱 Получен новый QR-код для авторизации в WhatsApp.');
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            qrCodeData = null;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('⚠️ Сессия завершена (Logged out). Удалите папку auth и переподключитесь.');
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeData = null;
            console.log('✅ WhatsApp успешно подключен!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Обработка входящих сообщений
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            if (!text) continue;

            // Пример простой команды /заказ
            if (text.toLowerCase().startsWith('/заказ')) {
                const orderText = text.replace('/заказ', '').trim();
                if (orderText) {
                    const orders = loadOrders();
                    const newOrder = {
                        id: Date.now(),
                        phone: sender.replace('@s.whatsapp.net', ''),
                        text: orderText,
                        date: new Date().toLocaleString()
                    };
                    orders.push(newOrder);
                    saveOrders(orders);

                    await sock.sendMessage(sender, { text: '✅ Ваш заказ успешно принят и добавлен в базу проката!' });
                } else {
                    await sock.sendMessage(sender, { text: '⚠️ Напишите текст заказа после команды /заказ (например: /заказ Перфоратор на сутки)' });
                }
            }
        }
    });
}

// === ВЕБ-ПАНЕЛЬ УПРАВЛЕНИЯ ===

app.get('/', (req, res) => {
    const orders = loadOrders();
    
    let statusHtml = '';
    if (connectionStatus === 'connected') {
        statusHtml = '<p style="color: green; font-weight: bold;">● WhatsApp подключен</p>';
    } else if (qrCodeData) {
        statusHtml = `
            <p style="color: orange; font-weight: bold;">● Ожидает сканирования QR-кода</p>
            <p>Откройте WhatsApp на телефоне ➔ Связанные устройства ➔ Связать устройство и отсканируйте этот QR-код:</p>
            <div id="qrcode"></div>
            <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
            <script>
                new QRCode(document.getElementById("qrcode"), "${qrCodeData}");
            </script>
        `;
    } else {
        statusHtml = '<p style="color: gray;">⟳ Инициализация подключения...</p>';
    }

    let ordersHtml = orders.map(o => `
        <tr>
            <td>${o.date}</td>
            <td>${o.phone}</td>
            <td>${o.text}</td>
            <td>
                <form action="/delete" method="POST" style="display:inline;">
                    <input type="hidden" name="id" value="${o.id}">
                    <input type="password" name="password" placeholder="Пароль" style="width: 80px;" required>
                    <button type="submit" style="background: red; color: white; border: none; padding: 3px 6px; cursor: pointer;">Удалить</button>
                </form>
            </td>
        </tr>
    `).reverse().join('');

    if (orders.length === 0) {
        ordersHtml = '<tr><td colspan="4" style="text-align: center;">Пока нет ни одного заказа</td></tr>';
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>🧰 База проката</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f4f4f9; }
                h1 { color: #333; }
                .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                th { background-color: #007bff; color: white; }
            </style>
        </head>
        <body>
            <h1>🧰 Панель управления прокатом</h1>
            
            <div class="card">
                <h3>Статус бота</h3>
                ${statusHtml}
            </div>

            <div class="card">
                <h3>Список заказов</h3>
                <table>
                    <tr>
                        <th>Дата</th>
                        <th>Телефон клиента</th>
                        <th>Описание заказа</th>
                        <th>Действие</th>
                    </tr>
                    ${ordersHtml}
                </table>
            </div>
        </body>
        </html>
    `);
});

// Маршрут для удаления заказа с проверкой пароля
app.post('/delete', (req, res) => {
    const { id, password } = req.body;
    if (password === ADMIN_PASSWORD) {
        let orders = loadOrders();
        orders = orders.filter(o => o.id != id);
        saveOrders(orders);
    }
    res.redirect('/');
});

// Health check для облачных хостингов
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsappConnected: connectionStatus === 'connected',
        qrAvailable: !!qrCodeData
    });
});

// Запуск сервера и бота
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Сервер запущен на порту ${PORT}`);
    connectToWhatsApp();
});
