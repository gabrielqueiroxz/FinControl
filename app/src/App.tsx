import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import { QRCodeSVG } from 'qrcode.react';
import { MessageSquare, Wallet, Phone, QrCode, LogOut, CheckCircle2, Clock, CreditCard, ShieldCheck } from 'lucide-react';

export default function App() {
  const [userId] = useState<string>('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('desconectado');
  const [loading, setLoading] = useState<boolean>(false);
  
  // Conexão via Código
  const [modoConexao, setModoConexao] = useState<'qr' | 'codigo'>('qr');
  const [telefone, setTelefone] = useState<string>('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  // Módulo de CPF e Boletos DDA
  const [cpf, setCpf] = useState<string>('');
  const [cpfSalvo, setCpfSalvo] = useState<string | null>(null);
  const [boletos, setBoletos] = useState<any[]>([]);

  // Carrega dados da sessão e CPF
  const carregarDadosUsuario = async () => {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('qr_code_base64, status_conexao, cpf')
      .eq('user_id', userId)
      .maybeSingle();

    if (data) {
      if (data.status_conexao) setStatus(data.status_conexao);
      if (data.cpf) setCpfSalvo(data.cpf);
      
      if (data.qr_code_base64) {
        if (data.status_conexao === 'aguardando_codigo') {
          setPairingCode(data.qr_code_base64);
        } else {
          setQrCode(data.qr_code_base64);
        }
      }
    }
  };

  // Carrega boletos detectados para o usuário
  const carregarBoletos = async () => {
    const { data } = await supabase
      .from('boletos_dda')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (data) setBoletos(data);
  };

  useEffect(() => {
    if (!userId) return;
    carregarDadosUsuario();
    carregarBoletos();

    // Escuta Realtime do Status do WhatsApp
    const canalStatus = supabase
      .channel('whatsapp_status')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_sessions', filter: `user_id=eq.${userId}` },
        (payload: any) => {
          if (payload.new) {
            if (payload.new.status_conexao) setStatus(payload.new.status_conexao);
            if (payload.new.cpf) setCpfSalvo(payload.new.cpf);

            if (payload.new.status_conexao === 'aguardando_codigo') {
              setPairingCode(payload.new.qr_code_base64);
            } else if (payload.new.qr_code_base64) {
              setQrCode(payload.new.qr_code_base64);
            }

            if (payload.new.status_conexao === 'conectado') {
              setQrCode(null);
              setPairingCode(null);
            }
          }
        }
      )
      .subscribe();

    // Escuta Realtime de Novos Boletos Chegando
    const canalBoletos = supabase
      .channel('boletos_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'boletos_dda', filter: `user_id=eq.${userId}` },
        () => carregarBoletos()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(canalStatus);
      supabase.removeChannel(canalBoletos);
    };
  }, [userId]);

  // Salva ou atualiza o CPF no Supabase
  const handleSalvarCPF = async () => {
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      alert('Por favor, informe um CPF válido com 11 dígitos.');
      return;
    }

    setLoading(true);
    const { error } = await supabase
      .from('whatsapp_sessions')
      .update({ cpf: cpfLimpo, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (error) {
      alert('Erro ao salvar CPF.');
    } else {
      setCpfSalvo(cpfLimpo);
      setCpf('');
      alert('CPF cadastrado com sucesso! Boletos DDA emitidos no seu nome serão monitorados.');
    }
    setLoading(false);
  };

  const handleGerarQR = async () => {
    setLoading(true);
    await supabase
      .from('whatsapp_sessions')
      .update({ status_conexao: 'aguardando_qr', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  };

  const handleGerarCodigo = async () => {
    if (!telefone || telefone.length < 10) {
      alert('Digite um número com DDD válido (ex: 11999998888)');
      return;
    }

    setLoading(true);
    await supabase
      .from('whatsapp_sessions')
      .update({ 
        status_conexao: 'aguardando_codigo', 
        qr_code_base64: `55${telefone.replace(/\D/g, '')}`,
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);
  };

  const handleDesconectar = async () => {
    setLoading(true);
    await supabase
      .from('whatsapp_sessions')
      .update({ status_conexao: 'desconectado', qr_code_base64: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    
    setStatus('desconectado');
    setQrCode(null);
    setPairingCode(null);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6 flex flex-col items-center">
      <header className="flex items-center gap-2 mb-8">
        <Wallet className="text-emerald-500 w-8 h-8" />
        <h1 className="text-2xl font-bold">FinControl</h1>
      </header>

      <main className="w-full max-w-md space-y-6">
        
        {/* CARD 1: CONEXÃO COM WHATSAPP */}
        <div className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <MessageSquare className="text-emerald-400" /> Conexão WhatsApp
          </h2>

          <div className="bg-slate-900 p-4 rounded-xl border border-slate-700 mb-6 text-center">
            <span className="text-xs text-slate-400">Status do Bot:</span>
            <div className="text-lg font-bold mt-1 text-emerald-400">
              {status === 'conectado' ? '🟢 Conectado e Ativo' : '🔴 Desconectado'}
            </div>
          </div>

          {status === 'conectado' ? (
            <div className="space-y-4">
              <div className="bg-emerald-950/40 border border-emerald-500/30 p-4 rounded-xl flex items-start gap-3">
                <CheckCircle2 className="text-emerald-400 w-6 h-6 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-emerald-300">Notificações Ativas!</h3>
                  <p className="text-xs text-slate-300 mt-1">
                    Alertas de DDA/Boletos e lembretes de contas serão enviados automaticamente para o seu WhatsApp.
                  </p>
                </div>
              </div>

              <button
                onClick={handleDesconectar}
                disabled={loading}
                className="w-full bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 font-medium py-3 rounded-xl transition flex items-center justify-center gap-2 cursor-pointer"
              >
                <LogOut className="w-4 h-4" /> Desconectar Sessão
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-700">
                <button
                  onClick={() => setModoConexao('qr')}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition ${
                    modoConexao === 'qr' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <QrCode className="w-4 h-4" /> QR Code
                </button>
                <button
                  onClick={() => setModoConexao('codigo')}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition ${
                    modoConexao === 'codigo' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Phone className="w-4 h-4" /> Código de Pareamento
                </button>
              </div>

              {modoConexao === 'qr' && (
                <div className="flex flex-col items-center gap-4">
                  <button
                    onClick={handleGerarQR}
                    disabled={loading}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition cursor-pointer"
                  >
                    Gerar QR Code
                  </button>

                  {qrCode && (
                    <div className="bg-white p-4 rounded-xl mt-2 flex flex-col items-center">
                      {qrCode.startsWith('data:image') ? (
                        <img src={qrCode} alt="QR Code" className="w-52 h-52 object-contain" />
                      ) : (
                        <QRCodeSVG value={qrCode} size={200} />
                      )}
                    </div>
                  )}
                </div>
              )}

              {modoConexao === 'codigo' && (
                <div className="flex flex-col gap-3">
                  <input
                    type="text"
                    placeholder="Ex: 11999998888"
                    value={telefone}
                    onChange={(e) => setTelefone(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white focus:border-emerald-500"
                  />

                  <button
                    onClick={handleGerarCodigo}
                    disabled={loading}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition cursor-pointer"
                  >
                    Gerar Código Numérico
                  </button>

                  {pairingCode && (
                    <div className="bg-slate-900 border border-emerald-500/50 p-4 rounded-xl text-center mt-2">
                      <div className="text-3xl font-mono font-bold text-emerald-400 tracking-widest my-2">
                        {pairingCode}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* CARD 2: MONITORAÇÃO DE BOLETOS DDA VIA CPF */}
        <div className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <ShieldCheck className="text-emerald-400" /> Cadastro de CPF para DDA
          </h2>

          {cpfSalvo ? (
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-700/80 flex items-center justify-between mb-4">
              <div>
                <span className="text-xs text-slate-400">CPF Monitorado:</span>
                <p className="font-mono text-emerald-400 font-semibold">***.{cpfSalvo.slice(3, 6)}.{cpfSalvo.slice(6, 9)}-**</p>
              </div>
              <button 
                onClick={() => setCpfSalvo(null)} 
                className="text-xs text-slate-400 hover:text-white underline cursor-pointer"
              >
                Alterar
              </button>
            </div>
          ) : (
            <div className="space-y-3 mb-4">
              <label className="text-xs text-slate-300">Digite seu CPF para buscar boletos automaticamente:</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="000.000.000-00"
                  value={cpf}
                  onChange={(e) => setCpf(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                />
                <button
                  onClick={handleSalvarCPF}
                  disabled={loading}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 rounded-xl font-medium transition cursor-pointer"
                >
                  Salvar
                </button>
              </div>
            </div>
          )}

          {/* LISTA DE BOLETOS ENCONTRADOS */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <CreditCard className="w-4 h-4 text-emerald-400" /> Boletos Detectados ({boletos.length})
            </h3>

            {boletos.length === 0 ? (
              <p className="text-xs text-slate-500 italic py-2 text-center">Nenhum boleto recente encontrado para este CPF.</p>
            ) : (
              boletos.map((b) => (
                <div key={b.id} className="bg-slate-900/80 border border-slate-700/60 p-3 rounded-xl flex items-center justify-between">
                  <div>
                    <h4 className="font-medium text-sm text-slate-200">{b.beneficiario}</h4>
                    <p className="text-[11px] text-slate-400">Vence em: {new Date(b.vencimento).toLocaleDateString('pt-BR')}</p>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-emerald-400 text-sm">R$ {Number(b.valor).toFixed(2)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </main>
    </div>
  );
}