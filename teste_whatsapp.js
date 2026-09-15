const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

// SUBSTiTUA PELO SEU NÚMERO (DDI 55 + DDD + Número + @s.whatsapp.net)
const MEU_NUMERO = '556781131229@s.whatsapp.net';

async function validarAutomacao() {
    console.log('Iniciando conexão com o WhatsApp...');

    // Salva as credenciais em uma pasta local para não pedir QR Code toda vez
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_teste');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;

        // 1. Exibe o QR Code no terminal do VS Code
        if (qr) {
            console.log('\n📲 Escaneie o QR Code abaixo no seu WhatsApp:\n');
            qrcode.generate(qr, { small: true });
        }

        // 2. Quando a conexão for estabelecida com sucesso
        if (connection === 'open') {
            console.log('\n✅ Conexão estabelecida com sucesso com o WhatsApp!\n');

            // --- TESTE 1: Envio Imediato ---
            try {
                await sock.sendMessage(MEU_NUMERO, { 
                    text: '🚀 *Teste de Automação:* Conexão efetuada com sucesso!' 
                });
                console.log('🟢 [TESTE 1] Mensagem imediata enviada com sucesso!');
            } catch (erro) {
                console.error('❌ [TESTE 1] Erro no envio imediato:', erro);
            }

            // --- TESTE 2: Envio Agendado (Daqui a 1 minuto) ---
            const agora = new Date();
            const minutoAgendado = (agora.getMinutes() + 1) % 60;
            const horaAgendada = agora.getHours();
            
            // Sintaxe do Cron: minuto hora * * *
            const cronExpressao = `${minutoAgendado} ${horaAgendada} * * *`;

            console.log(`⏱️ [TESTE 2] Agendando mensagem de teste para às ${horaAgendada}:${minutoAgendado < 10 ? '0' : ''}${minutoAgendado}...`);

            cron.schedule(cronExpressao, async () => {
                try {
                    await sock.sendMessage(MEU_NUMERO, { 
                        text: '⏰ *Teste de Agendamento:* O timer disparou corretamente!' 
                    });
                    console.log('🟢 [TESTE 2] Mensagem agendada enviada com sucesso!');
                    console.log('\n✨ Automação 100% Validada!');
                } catch (erro) {
                    console.error('❌ [TESTE 2] Erro no envio agendado:', erro);
                }
            });
        }

        if (connection === 'close') {
            console.log('⚠️ Conexão fechada. Tentando reconectar...');
            validarAutomacao();
        }
    });
}

validarAutomacao();