import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

let client: Client | null = null;
let isReady = false;

export function initWhatsApp(): void {
    if (process.env.WHATSAPP_ENABLED !== 'true') return;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: {
            // Required for running inside Docker / Render containers
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        },
    });

    client.on('qr', (qr) => {
        console.log('\n========= WhatsApp QR Code — scan with your phone =========');
        qrcode.generate(qr, { small: true });
        console.log('============================================================\n');
    });

    client.on('ready', () => {
        console.log('WhatsApp client ready ✓');
        isReady = true;
    });

    client.on('authenticated', () => {
        console.log('WhatsApp authenticated ✓');
    });

    client.on('auth_failure', (msg) => {
        console.error('WhatsApp auth failure:', msg);
        isReady = false;
    });

    client.on('disconnected', (reason) => {
        console.warn('WhatsApp disconnected:', reason);
        isReady = false;
    });

    client.initialize().catch((err) => {
        console.error('WhatsApp init error:', err);
    });
}

export async function sendWhatsAppMessage(groupId: string, message: string): Promise<boolean> {
    if (!client || !isReady) {
        console.warn('WhatsApp: client not ready, skipping send');
        return false;
    }
    try {
        await client.sendMessage(groupId, message);
        return true;
    } catch (err) {
        console.error('WhatsApp send error:', err);
        return false;
    }
}
