const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

// Configuração do Mercado Pago (Utiliza o Access Token de Produção vindo do Railway)
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || 'SEU_ACCESS_TOKEN_DE_PRODUCAO_AQUI';
const mpClient = new MercadoPagoConfig({ accessToken: MERCADO_PAGO_ACCESS_TOKEN });

// Maps em memória
const sessoesAtivas = new Map();
const ultimosEnviosQR = new Map();
const inicializandoSessao = new Map();

// Credenciais dinâmicas do Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ ERRO CRÍTICO: Variáveis SUPABASE_URL ou SUPABASE_KEY não foram encontradas!');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Função auxiliar para remover pasta de sessão corrompida
function limparPastaSessao(userId) {
    const pastaSessao = path.join(__dirname, `sessoes_auth/auth_${userId}`);
    if (fs.existsSync(pastaSessao)) {
        try {
            fs.rmSync(pastaSessao, { recursive: true, force: true });
            console.log(`[${userId}] 🧹 Pasta de sessão limpa com sucesso.`);
        } catch (err) {
            console.error(`[${userId}] ❌ Erro ao limpar pasta de sessão:`, err);
        }
    }
}

// -----------------------------------------------------------------
// 1. GERENCIADOR DE SESSÃO INDIVIDUAL POR USUÁRIO
// -----------------------------------------------------------------
async function iniciarSessaoUsuario(userId) {
    if (inicializandoSessao.get(userId)) {
        console.log(`[${userId}] ⏳ Inicialização já em andamento. Aguarde...`);
        return;
    }

    if (sessoesAtivas.has(userId)) {
        const socketExistente = sessoesAtivas.get(userId);
        if (socketExistente && socketExistente.authState?.creds?.registered) {
            console.log(`[${userId}] ✅ Sessão já ativa e registrada.`);
            return socketExistente;
        }
    }

    inicializandoSessao.set(userId, true);

    try {
        if (sessoesAtivas.has(userId)) {
            try {
                const oldSock = sessoesAtivas.get(userId);
                oldSock.ev.removeAllListeners();
                oldSock.end(undefined);
            } catch (e) {}
            sessoesAtivas.delete(userId);
        }

        const pastaAuth = `sessoes_auth/auth_${userId}`;
        const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["FinControl Web", "Chrome", "110.0.5481.177"]
        });

        sessoesAtivas.set(userId, sock);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr && !sock.authState.creds.registered) {
                const agora = Date.now();
                const ultimoEnvio = ultimosEnviosQR.get(userId) || 0;

                if (agora - ultimoEnvio > 3000) {
                    ultimosEnviosQR.set(userId, agora);
                    console.log(`[${userId}] 📌 Gerando nova imagem QR Code...`);

                    try {
                        const qrCodeDataUrl = await QRCode.toDataURL(qr);

                        await supabase
                            .from('whatsapp_sessions')
                            .update({
                                qr_code_base64: qrCodeDataUrl,
                                status_conexao: 'aguardando_qr',
                                updated_at: new Date().toISOString()
                            })
                            .eq('user_id', userId);
                    } catch (err) {
                        console.error(`[${userId}] Erro ao converter QR Code:`, err);
                    }
                }
            }

            if (connection === 'open') {
                console.log(`[${userId}] ✅ Conectado com sucesso!`);
                ultimosEnviosQR.delete(userId);

                await supabase
                    .from('whatsapp_sessions')
                    .update({
                        qr_code_base64: null,
                        status_conexao: 'conectado',
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId);

                const numeroUsuario = sock.user.id.split(':')[0];
                const mensagemBoasVindas = `🚀 *Conexão Realizada com Sucesso!*\n\nSeu WhatsApp foi vinculado ao *FinControl*.`;

                await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagemBoasVindas });
            }

            if (connection === 'close') {
                const motivo = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${userId}] ⚠️ Conexão encerrada. Motivo:`, motivo);

                sessoesAtivas.delete(userId);

                if (motivo === DisconnectReason.loggedOut || motivo === 401) {
                    console.log(`[${userId}] 🛑 Sessão encerrada/deslogada. Limpando credenciais...`);
                    ultimosEnviosQR.delete(userId);
                    limparPastaSessao(userId);

                    await supabase
                        .from('whatsapp_sessions')
                        .update({
                            qr_code_base64: null,
                            status_conexao: 'desconectado',
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userId);

                } else if (motivo === DisconnectReason.restartRequired || motivo === 515) {
                    console.log(`[${userId}] 🔄 Reinicialização necessária (Handshake do QR Code). Reconectando...`);
                    setTimeout(() => iniciarSessaoUsuario(userId), 1500);

                } else {
                    console.log(`[${userId}] ⚠️ Erro de rede temporário. Tentando reconectar sem resetar banco...`);
                    setTimeout(() => iniciarSessaoUsuario(userId), 3000);
                }
            }
        });

    } catch (error) {
        console.error(`[${userId}] Erro de execução na sessão:`, error);
    } finally {
        inicializandoSessao.set(userId, false);
    }
}

// -----------------------------------------------------------------
// 2. AGENDADOR DE DISPAROS
// -----------------------------------------------------------------
function iniciarAgendadorMultiusuario() {
    cron.schedule('0 9 * * 5', () => dispararLembrete('sexta_manha'));
    cron.schedule('0 19 * * 5', () => dispararLembrete('sexta_noite'));
    cron.schedule('0 8 * * 6', () => dispararLembrete('sabado_manha'));
    cron.schedule('0 13 * * 6', () => dispararLembrete('sabado_tarde1'));
    cron.schedule('0 15 * * 6', () => dispararLembrete('sabado_tarde2'));
}

async function dispararLembrete(momento) {
    const { data: sessoes } = await supabase
        .from('whatsapp_sessions')
        .select('user_id')
        .eq('status_conexao', 'conectado');

    if (!sessoes) return;

    const hoje = new Date();
    const diaDaSemana = hoje.getDay();
    const diffParaSegunda = hoje.getDate() - diaDaSemana + (diaDaSemana === 0 ? -6 : 1);
    
    const inicioSemana = new Date(hoje.setDate(diffParaSegunda));
    inicioSemana.setHours(0, 0, 0, 0);

    const fimSemana = new Date(inicioSemana);
    fimSemana.setDate(inicioSemana.getDate() + 6);
    fimSemana.setHours(23, 59, 59, 999);

    const fimSemanaStr = fimSemana.toISOString().split('T')[0];

    for (const sessao of sessoes) {
        const { user_id } = sessao;

        const { data: contas } = await supabase
            .from('contas')
            .select('nome, valor, vencimento')
            .eq('user_id', user_id)
            .eq('status', 'pendente')
            .lte('vencimento', fimSemanaStr)
            .order('vencimento', { ascending: true });

        if (!contas || contas.length === 0) continue;

        const totalPendente = contas.reduce((acc, item) => acc + Number(item.valor), 0);
        const sock = sessoesAtivas.get(user_id);

        if (sock && totalPendente > 0) {
            const numeroUsuario = sock.user.id.split(':')[0];
            let listaContas = contas.map(c => `• ${c.nome}: R$ ${Number(c.valor).toFixed(2)}`).join('\n');
            const mensagem = `📊 *LEMBRETE DE FINANÇAS*\n\nVocê possui *R$ ${totalPendente.toFixed(2)}* em contas pendentes esta semana.\n\n*Compromissos:*\n${listaContas}`;

            await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagem });
        }
    }
}

// -----------------------------------------------------------------
// 3. ESCUTA EM TEMPO REAL DE PEDIDOS DE CONEXÃO
// -----------------------------------------------------------------
function escutarPedidosDeConexao() {
    supabase
        .channel('pedidos_whatsapp')
        .on(
            'postgres_changes', 
            { event: 'UPDATE', schema: 'public', table: 'whatsapp_sessions' }, 
            (payload) => {
                const dados = payload.new;
                const antigos = payload.old;

                if (!dados) return;

                const valorAtual = dados.qr_code_base64 || '';
                const eImagemQR = valorAtual.startsWith('data:image');

                if (eImagemQR) return;

                if (dados.status_conexao === 'aguardando_qr' && antigos?.status_conexao !== 'aguardando_qr') {
                    console.log(`📡 Solicitando QR Code para: ${dados.user_id}`);
                    limparPastaSessao(dados.user_id);
                    iniciarSessaoUsuario(dados.user_id);
                } 
                else if (dados.status_conexao === 'desconectado' && antigos?.status_conexao !== 'desconectado') {
                    if (sessoesAtivas.has(dados.user_id)) {
                        console.log(`[${dados.user_id}] Encerrando sessão por comando do usuário...`);
                        try {
                            const sock = sessoesAtivas.get(dados.user_id);
                            sock.ev.removeAllListeners();
                            sock.end(undefined);
                        } catch (e) {}
                        sessoesAtivas.delete(dados.user_id);
                    }
                    limparPastaSessao(dados.user_id);
                }
            }
        )
        .subscribe();
}

// -----------------------------------------------------------------
// 4. ESCUTA DE BOLETOS DDA
// -----------------------------------------------------------------
function escutarNovosBoletosDDA() {
    supabase
        .channel('novos_boletos_multiusuario')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'boletos_dda' },
            async (payload) => {
                const boleto = payload.new;
                const sock = sessoesAtivas.get(boleto.user_id);

                if (sock) {
                    const numeroUsuario = sock.user.id.split(':')[0];
                    const mensagem = `⚠️ *NOVO BOLETO DETECTADO NO SEU CPF!*\n\n📄 *Beneficiário:* ${boleto.beneficiario}\n💰 *Valor:* R$ ${Number(boleto.valor).toFixed(2)}\n📅 *Vencimento:* ${new Date(boleto.vencimento).toLocaleDateString('pt-BR')}`;
                    await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagem });
                }
            }
        )
        .subscribe();
}

// -----------------------------------------------------------------
// 5. INICIALIZAÇÃO DO SERVIDOR HTTP (RAILWAY)
// -----------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/', (req, res) => {
    res.send('🚀 Backend FinControl WhatsApp Online!');
});

// Rota de criação de preferência de pagamento (Produção)
app.post('/criar-preferencia', async (req, res) => {
    try {
        const preference = new Preference(mpClient);

        const result = await preference.create({
            body: {
                items: [
                    {
                        title: 'Plano VIP FinControl',
                        quantity: 1,
                        unit_price: 29.90,
                        currency_id: 'BRL',
                    },
                ],
            },
        });

        // Retorna o init_point oficial de produção do Mercado Pago
        res.json({ init_point: result.init_point });
    } catch (error) {
        console.error('Erro ao criar preferência no Mercado Pago:', error);
        res.status(500).json({ error: 'Erro ao gerar link de pagamento.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor HTTP rodando na porta ${PORT}!`);
    
    iniciarAgendadorMultiusuario();
    escutarPedidosDeConexao();
    escutarNovosBoletosDDA();
    
    console.log('📡 Escutando solicitações do Supabase...');
});