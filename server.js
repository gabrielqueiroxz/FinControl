const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const pino = require('pino');
const QRCode = require('qrcode');

// Map em memória para armazenar as conexões ativas de cada usuário
const sessoesAtivas = new Map();
// Map para controlar o tempo do último QR Code enviado (evita atualizações desenfreadas)
const ultimosEnviosQR = new Map();

// Credenciais do Supabase
const SUPABASE_URL = 'https://ksgofitvvgzmytkoecpd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_uTIzL4oHLOR7SB9toR0Ugg_-DgsvrNe';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ID do usuário de testes principal
const TEST_USER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

// -----------------------------------------------------------------
// 1. GERENCIADOR DE SESSÃO INDIVIDUAL POR USUÁRIO
// -----------------------------------------------------------------
async function iniciarSessaoUsuario(userId, numeroTelefone = null) {
    if (sessoesAtivas.has(userId)) {
        console.log(`[${userId}] Sessão já está ativa em memória.`);
        return sessoesAtivas.get(userId);
    }

    const { state, saveCreds } = await useMultiFileAuthState(`sessoes_auth/auth_${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["FinControl App", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    // SUPORTE A CÓDIGO DE PAREAMENTO (Sem usar câmera/QR Code)
    if (numeroTelefone && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                // Limpa formatação do número
                const numeroLimpo = numeroTelefone.replace(/\D/g, '');
                const codigo = await sock.requestPairingCode(numeroLimpo);
                console.log(`[${userId}] 🔢 Código de Pareamento gerado: ${codigo}`);

                await supabase
                    .from('whatsapp_sessions')
                    .update({
                        qr_code_base64: codigo, // Armazena o código de 8 dígitos no Supabase
                        status_conexao: 'aguardando_codigo',
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId);
            } catch (err) {
                console.error(`[${userId}] Erro ao gerar Código de Pareamento:`, err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        // CONTROLE DE FREQUÊNCIA DO QR CODE (Debounce de 15 segundos)
        if (qr && !numeroTelefone) {
            const agora = Date.now();
            const ultimoEnvio = ultimosEnviosQR.get(userId) || 0;

            if (agora - ultimoEnvio > 15000) { // Só grava no banco a cada 15s
                ultimosEnviosQR.set(userId, agora);
                console.log(`[${userId}] 📌 QR Code estável gerado! Enviando ao Supabase...`);
                
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
                    console.error(`[${userId}] Erro ao converter QR Code para Base64:`, err);
                }
            }
        }

        if (connection === 'open') {
            console.log(`[${userId}] ✅ Conectado com sucesso!`);
            sessoesAtivas.set(userId, sock);
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

Seu WhatsApp foi vinculado ao seu *Gerenciador Financeiro FinControl*.

📅 *Horários dos Seus Lembretes Automáticos:*
• *Sexta-feira:* 09:00 e 19:00
• *Sábado:* 08:00, 13:00 e 15:00

🔔 *Alerta de Boletos:* Notificaremos você automaticamente assim que novos boletos forem emitidos no seu CPF.`;

            await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagemBoasVindas });
            console.log(`[${userId}] ✉️ Mensagem de confirmação enviada!`);
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

            // Reconecta automaticamente se não tiver sido Logout voluntário do celular
            if (deveReconectar) {
                console.log(`[${userId}] 🔄 Tentando reconectar sessão...`);
                setTimeout(() => iniciarSessaoUsuario(userId), 5000);
            }
        }
    });

    return sock;
}

// -----------------------------------------------------------------
// 2. AGENDADOR DE DISPAROS NOS HORÁRIOS DEFINIDOS
// -----------------------------------------------------------------
function iniciarAgendadorMultiusuario() {
    cron.schedule('0 9 * * 5', () => dispararLembrete('sexta_manha'));
    cron.schedule('0 19 * * 5', () => dispararLembrete('sexta_noite'));

    cron.schedule('0 8 * * 6', () => dispararLembrete('sabado_manha'));
    cron.schedule('0 13 * * 6', () => dispararLembrete('sabado_tarde1'));
    cron.schedule('0 15 * * 6', () => dispararLembrete('sabado_tarde2'));

    console.log('⏰ Agendador ativado: Lembretes configurados para Sextas e Sábados.');
}

async function dispararLembrete(momento) {
    console.log(`🗓️ Executando disparo agendado: [${momento}]`);

    const { data: sessoes, error } = await supabase
        .from('whatsapp_sessions')
        .select('user_id')
        .eq('status_conexao', 'conectado');

    if (error || !sessoes) return;

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

            const mensagem = 
`📊 *LEMBRETE DE FINANÇAS*

Você possui *R$ ${totalPendente.toFixed(2)}* em contas pendentes esta semana.

*Compromissos:*
${listaContas}

Acesse o aplicativo para registrar seus pagamentos!`;

            await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagem });
            console.log(`✉️ Lembrete enviado para o usuário ${user_id}`);
        }
    }
}

// -----------------------------------------------------------------
// 3. ESCUTA EM TEMPO REAL DE PEDIDOS DE QR CODE OU CÓDIGO DE PAREAMENTO
// -----------------------------------------------------------------
function escutarPedidosDeConexao() {
    supabase
        .channel('pedidos_whatsapp')
        .on(
            'postgres_changes', 
            { event: '*', schema: 'public', table: 'whatsapp_sessions' }, 
            (payload) => {
                const dados = payload.new;
                if (dados) {
                    if (dados.status_conexao === 'aguardando_qr') {
                        console.log(`📡 Pedido de QR Code detectado para o usuário: ${dados.user_id}`);
                        iniciarSessaoUsuario(dados.user_id);
                    } else if (dados.status_conexao === 'aguardando_codigo' && dados.qr_code_base64 && dados.qr_code_base64.startsWith('55')) {
                        console.log(`📡 Pedido de Código de Pareamento para o número: ${dados.qr_code_base64}`);
                        iniciarSessaoUsuario(dados.user_id, dados.qr_code_base64);
                    }
                }
            }
        )
        .subscribe();
}

// -----------------------------------------------------------------
// 4. ESCUTA EM TEMPO REAL DE NOVOS BOLETOS DDA (NOTIFICAÇÃO VIA CPF)
// -----------------------------------------------------------------
function escutarNovosBoletosDDA() {
    supabase
        .channel('novos_boletos_multiusuario')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'boletos_dda' },
            async (payload) => {
                const boleto = payload.new;
                console.log(`🔔 Novo boleto inserido para o user_id: ${boleto.user_id}`);

                // Busca o socket da sessão ativa do usuário dono do boleto
                const sock = sessoesAtivas.get(boleto.user_id);

                if (sock) {
                    const numeroUsuario = sock.user.id.split(':')[0];
                    const mensagem = 
`⚠️ *NOVO BOLETO DETECTADO NO SEU CPF!*

📄 *Beneficiário:* ${boleto.beneficiario}
💰 *Valor:* R$ ${Number(boleto.valor).toFixed(2)}
📅 *Vencimento:* ${new Date(boleto.vencimento).toLocaleDateString('pt-BR')}

📌 *Código de Barras / Copia e Cola:*
\`${boleto.codigo_barras || 'Consulte no aplicativo'}\`

O boleto já foi registrado no seu painel do FinControl.`;

                    await sock.sendMessage(`${numeroUsuario}@s.whatsapp.net`, { text: mensagem });
                    console.log(`✉️ Alerta de boleto DDA enviado com sucesso para ${numeroUsuario}`);
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

// Inicia sessão para o usuário de testes principal
iniciarSessaoUsuario(TEST_USER_ID);

console.log('🚀 Backend Multiusuário rodando com suporte a DDA e aguardando conexões...');