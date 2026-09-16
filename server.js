const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const pino = require('pino');
const QRCode = require('qrcode');

// Maps em memória
const sessoesAtivas = new Map();
const ultimosEnviosQR = new Map();
const inicializandoSessao = new Map();

// Credenciais do Supabase
const SUPABASE_URL = 'https://ksgofitvvgzmytkoecpd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_uTIzL4oHLOR7SB9toR0Ugg_-DgsvrNe';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// -----------------------------------------------------------------
// 1. GERENCIADOR DE SESSÃO INDIVIDUAL POR USUÁRIO
// -----------------------------------------------------------------
async function iniciarSessaoUsuario(userId, numeroTelefone = null) {
    if (inicializandoSessao.get(userId)) {
        console.log(`[${userId}] ⏳ Inicialização em andamento. Aguarde...`);
        return;
    }

    if (sessoesAtivas.has(userId)) {
        const socketExistente = sessoesAtivas.get(userId);
        if (socketExistente && socketExistente.authState?.creds?.registered) {
            console.log(`[${userId}] ✅ Sessão já ativa.`);
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

        const { state, saveCreds } = await useMultiFileAuthState(`sessoes_auth/auth_${userId}`);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Chrome (Linux)", "Chrome", "110.0.5481.177"]
        });

        sessoesAtivas.set(userId, sock);
        sock.ev.on('creds.update', saveCreds);

        // SOLICITAÇÃO DO CÓDIGO DE PAREAMENTO (8 DÍGITOS)
        if (numeroTelefone && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let numeroLimpo = numeroTelefone.replace(/\D/g, '');
                    if (!numeroLimpo.startsWith('55')) {
                        numeroLimpo = '55' + numeroLimpo;
                    }
                    
                    console.log(`[${userId}] 📱 Solicitando Pairing Code para o número: ${numeroLimpo}`);
                    
                    const codigo = await sock.requestPairingCode(numeroLimpo);
                    console.log(`[${userId}] 🔢 Código de Pareamento Gerado com Sucesso: ${codigo}`);

                    await supabase
                        .from('whatsapp_sessions')
                        .update({
                            qr_code_base64: codigo,
                            status_conexao: 'aguardando_codigo',
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userId);
                } catch (err) {
                    console.error(`[${userId}] ❌ Erro ao solicitar Código de Pareamento:`, err);
                }
            }, 3000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            // EMISSÃO DE QR CODE
            if (qr && !numeroTelefone && !sock.authState.creds.registered) {
                const agora = Date.now();
                const ultimoEnvio = ultimosEnviosQR.get(userId) || 0;

                if (agora - ultimoEnvio > 5000) {
                    ultimosEnviosQR.set(userId, agora);
                    console.log(`[${userId}] 📌 Gerando imagem QR Code para o Supabase...`);
                    
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
                const mensagemBoasVindas = 
`🚀 *Conexão Realizada com Sucesso!*

Seu WhatsApp foi vinculado ao seu *Gerenciador Financeiro FinControl*.`;

                await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagemBoasVindas });
            }

            if (connection === 'close') {
                const motivo = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${userId}] ⚠️ Conexão encerrada. Motivo:`, motivo);
                
                sessoesAtivas.delete(userId);
                ultimosEnviosQR.delete(userId);

                const deveReconectar = motivo !== DisconnectReason.loggedOut;

                await supabase
                    .from('whatsapp_sessions')
                    .update({
                        status_conexao: 'desconectado',
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId);

                if (deveReconectar) {
                    setTimeout(() => iniciarSessaoUsuario(userId), 5000);
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

    for (const sessao of sessoes) {
        const { user_id } = sessao;
        const { data: contas } = await supabase
            .from('contas')
            .select('nome, valor')
            .eq('user_id', user_id)
            .eq('status', 'pendente');

        const totalPendente = contas ? contas.reduce((acc, item) => acc + item.valor, 0) : 0;
        const sock = sessoesAtivas.get(user_id);

        if (sock && totalPendente > 0) {
            const numeroUsuario = sock.user.id.split(':')[0];
            let listaContas = contas.map(c => `• ${c.nome}: R$ ${c.valor.toFixed(2)}`).join('\n');
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

                // FILTRO ANTI-LOOP: Ignora o evento se for a gravação do QR (DataURL) ou do Código de 8 dígitos (Regex)
                const valorAtual = dados.qr_code_base64 || '';
                const eCodigoPar = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(valorAtual) || valorAtual.length === 8;
                const eImagemQR = valorAtual.startsWith('data:image');

                if (eCodigoPar || eImagemQR) {
                    return;
                }

                // PEDIDO DE QR CODE
                if (dados.status_conexao === 'aguardando_qr' && antigos?.status_conexao !== 'aguardando_qr') {
                    console.log(`📡 Solicitando QR Code para: ${dados.user_id}`);
                    iniciarSessaoUsuario(dados.user_id);
                } 
                // PEDIDO DE CÓDIGO DE PAREAMENTO (Exige entre 10 e 13 dígitos numéricos)
                else if (dados.status_conexao === 'aguardando_codigo') {
                    const numeroApenasDigitos = valorAtual.replace(/\D/g, '');
                    const eNumeroValido = numeroApenasDigitos.length >= 10 && numeroApenasDigitos.length <= 13;
                    const numeroMudou = antigos?.qr_code_base64 !== dados.qr_code_base64;

                    if (eNumeroValido && numeroMudou) {
                        console.log(`📡 Solicitando Pairing Code para número: ${numeroApenasDigitos}`);
                        iniciarSessaoUsuario(dados.user_id, numeroApenasDigitos);
                    }
                }
                // DESCONEXÃO SOLICITADA
                else if (dados.status_conexao === 'desconectado' && antigos?.status_conexao !== 'desconectado') {
                    if (sessoesAtivas.has(dados.user_id)) {
                        console.log(`[${dados.user_id}] Encerrando sessão...`);
                        try {
                            const sock = sessoesAtivas.get(dados.user_id);
                            sock.ev.removeAllListeners();
                            sock.end(undefined);
                        } catch (e) {}
                        sessoesAtivas.delete(dados.user_id);
                    }
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
// 5. INICIALIZAÇÃO DO SERVIDOR
// -----------------------------------------------------------------
iniciarAgendadorMultiusuario();
escutarPedidosDeConexao();
escutarNovosBoletosDDA();

console.log('🚀 Backend Multiusuário rodando e pronto para receber solicitações do React!');