// Sala de Reuniões — Pâmela Pissutti
// Orquestra as telas: início (anfitriã), antes de entrar, espera, chamada e fim.
import {
  $, $$, mostrar, texto, inicial, formatarTempo, gerarChave, copiar, navegadorEmbutido, ehCelular, ehIOS,
  suporteCompleto, suportaCompartilharTela, liberarSom, contextoDeSom, bip, aviso, janela, melhorGrade,
} from './util.js';
import { icone } from './icons.js';
import { api, sessao, urlWs, linkDaSala, mensagemDeErro } from './api.js';
import { Sinalizacao } from './signaling.js';
import { Malha } from './mesh.js';
import { Gravador, suporteGravacao } from './recorder.js';

const cfg = window.SALA_CONFIG;
const TELAS = ['boot', 'home', 'lobby', 'espera', 'call', 'fim'];

function ir(nome) {
  TELAS.forEach((t) => {
    const el = $('#v-' + t);
    if (el) el.hidden = t !== nome;
  });
  window.scrollTo(0, 0);
}

function ao(seletor, evento, fn) {
  const el = typeof seletor === 'string' ? $(seletor) : seletor;
  if (el) el.addEventListener(evento, fn);
}

// ======================================================================
// Estado
// ======================================================================
const S = {
  salaId: null,
  titulo: 'Reunião',
  info: null,
  nome: '',
  chave: null,
  ice: [],
  // mídia
  fluxoLocal: null, // câmera + microfone
  tela: null, // compartilhamento de tela (meu)
  micLigado: true,
  camLigada: true,
  // conexão
  sig: null,
  malha: null,
  meuId: null,
  papel: 'guest',
  pares: new Map(), // id -> { id, name, role, mic, cam, screenStreamId }
  espera: new Map(), // id -> nome (anfitriã)
  avisosEspera: new Map(),
  gravando: false,
  trancada: false,
  anfitriaPresente: true,
  gravador: null,
  // interface
  tiles: new Map(),
  pausado: false,
  fila: [],
  inicioChamada: 0,
  relogio: null,
  desenhoAgendado: false,
  reconectando: false,
  encerrando: false,
  wakeLock: null,
  shareResolve: null,
  pool: [], // elementos <video> "destravados" no toque de entrar (iPhone só toca som se houve toque)
  eventos: [], // últimos acontecimentos, para o relatório de suporte
  erroMidia: null,
  somBloqueado: 0,
};

const eAnfitria = () => S.papel === 'host';

// Anota o que acontece (só na memória deste aparelho) para o botão "Copiar relatório".
function registrar(txt) {
  const t = new Date();
  const dois = (n) => (n < 10 ? '0' + n : '' + n);
  S.eventos.push(dois(t.getHours()) + ':' + dois(t.getMinutes()) + ':' + dois(t.getSeconds()) + ' ' + txt);
  if (S.eventos.length > 80) S.eventos.shift();
}

// Texto curto, em português, que a pessoa pode colar numa conversa com a Pâmela.
async function montarRelatorio() {
  const linhas = [];
  const add = (k, v) => linhas.push(k + ': ' + v);
  add('Relatório da Sala de Reuniões', new Date().toLocaleString('pt-BR'));
  add('Sala', S.salaId || '(início)');
  add('Aparelho', navigator.userAgent);
  add('Idioma / tela', (navigator.language || '?') + ' / ' + window.screen.width + 'x' + window.screen.height + ' (janela ' + window.innerWidth + 'x' + window.innerHeight + ')');
  add('Site seguro (https)', window.isSecureContext);
  add('Navegador embutido em outro app', navegadorEmbutido());
  add('Recursos', 'WebRTC=' + !!window.RTCPeerConnection + ' câmera=' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) + ' WebSocket=' + !!window.WebSocket);
  add('Erro ao abrir a câmera/microfone', S.erroMidia || 'nenhum');
  const trilhas = S.fluxoLocal ? S.fluxoLocal.getTracks().map((t) => t.kind + ':' + t.readyState + (t.enabled ? '' : ':desligada')).join(', ') : 'sem câmera/microfone';
  add('Câmera/microfone locais', trilhas);
  add('Papel / meu id', S.papel + ' / ' + (S.meuId || '-'));
  add('Sinalizador', S.sig && S.sig.ws ? 'estado ' + S.sig.ws.readyState + (S.reconectando ? ' (reconectando)' : '') : 'sem conexão');
  add('Som bloqueado pelo aparelho (vezes)', S.somBloqueado);
  const vids = Array.from(document.querySelectorAll('#grid video, #stage video')).map((v, i) => i + ': pausado=' + v.paused + ' mudo=' + v.muted + ' pronto=' + v.readyState + ' largura=' + v.videoWidth);
  add('Vídeos na tela', vids.length ? vids.join(' | ') : 'nenhum');
  if (S.malha) {
    try {
      add('Conexões', JSON.stringify(await S.malha.relatorio()));
    } catch (e) {
      add('Conexões', 'erro ao ler');
    }
  } else {
    add('Conexões', 'ainda não entrou na chamada');
  }
  linhas.push('--- últimos acontecimentos ---');
  return linhas.concat(S.eventos).join('\n');
}

async function copiarRelatorio() {
  const relatorio = await montarRelatorio();
  if (await copiar(relatorio)) {
    aviso('Relatório copiado. Cole numa conversa com a Pâmela.', { tipo: 'bom', ms: 6000 });
  } else {
    await janela('Relatório para o suporte', [relatorio.slice(0, 1800)], [{ rotulo: 'Fechar', valor: true, primario: true }]);
  }
}

// iPhone: o som e o vídeo da outra pessoa só tocam em elementos que já foram "tocados" por um toque.
// Criamos alguns agora (dentro do toque em "Entrar") e os usamos depois nos quadros da chamada.
function prepararElementosDeMidia() {
  try {
    const ctx = contextoDeSom();
    const destino = ctx && ctx.createMediaStreamDestination ? ctx.createMediaStreamDestination() : null;
    S.pool = [];
    for (let i = 0; i < 8; i++) {
      const v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      if (destino) v.srcObject = destino.stream;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      S.pool.push(v);
    }
    registrar('elementos de mídia preparados: ' + S.pool.length);
  } catch (e) {
    registrar('não consegui preparar os elementos de mídia: ' + e.message);
  }
}

function linkBase() {
  return linkDaSala('').replace(/\?sala=$/, '');
}

// ======================================================================
// Início: anfitriã cria reuniões
// ======================================================================
async function iniciarHome() {
  ir('home');
  texto($('#criar-prefixo'), linkBase().replace(/^https?:\/\//, '') + '?sala=');
  if (sessao.token()) await mostrarPainel();
  else mostrarLogin();
}

function mostrarLogin() {
  mostrar($('#home-login'), true);
  mostrar($('#home-painel'), false);
}

async function mostrarPainel() {
  try {
    const r = await api.salas();
    mostrar($('#home-login'), false);
    mostrar($('#home-painel'), true);
    desenharSalas(r.rooms || []);
  } catch (e) {
    mostrarLogin();
    if (e.codigo !== 'nao-autorizada') mostrarErro($('#login-erro'), mensagemDeErro(e));
  }
}

function mostrarErro(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function desenharSalas(salas) {
  const ul = $('#lista-salas');
  ul.textContent = '';
  mostrar($('#lista-vazia'), salas.length === 0);
  salas.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'sala';
    const t = document.createElement('strong');
    t.textContent = s.title || (s.permanent ? s.id : 'Reunião sem nome');
    const et = document.createElement('span');
    et.className = 'etiqueta';
    et.textContent = s.permanent ? 'link fixo' : 'avulsa';
    t.appendChild(et);
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = linkDaSala(s.id);
    const acoes = document.createElement('div');
    acoes.className = 'acoes';
    const bCopiar = botaoPequeno('Copiar link', async () => {
      aviso((await copiar(linkDaSala(s.id))) ? 'Link copiado.' : 'Não consegui copiar. Selecione e copie manualmente.', { tipo: 'bom' });
    });
    const bEntrar = botaoPequeno('Entrar como anfitriã', () => {
      location.href = linkDaSala(s.id);
    }, true);
    const bApagar = botaoPequeno('Excluir', async () => {
      const ok = await janela('Excluir esta reunião?', ['O link deixa de funcionar. Quem tiver o link não conseguirá mais entrar.'], [
        { rotulo: 'Cancelar', valor: false },
        { rotulo: 'Excluir', valor: true, perigo: true },
      ]);
      if (!ok) return;
      try {
        await api.apagar(s.id);
        await mostrarPainel();
      } catch (e) {
        aviso(mensagemDeErro(e));
      }
    });
    acoes.append(bEntrar, bCopiar, bApagar);
    li.append(t, url, acoes);
    ul.appendChild(li);
  });
}

function botaoPequeno(rotulo, acao, primario) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'botao pequeno' + (primario ? ' primario' : '');
  b.textContent = rotulo;
  b.addEventListener('click', acao);
  return b;
}

function ligarHome() {
  ao('#form-login', 'submit', async (ev) => {
    ev.preventDefault();
    mostrarErro($('#login-erro'), '');
    try {
      await api.entrar($('#login-senha').value);
      $('#login-senha').value = '';
      await mostrarPainel();
    } catch (e) {
      mostrarErro($('#login-erro'), mensagemDeErro(e));
    }
  });
  ao('#criar-fixa', 'change', () => {
    const marcada = $('#criar-fixa').checked;
    mostrar($('#criar-slug-campo'), marcada);
    if (marcada) $('#criar-slug').focus();
  });
  ao('#form-criar', 'submit', async (ev) => {
    ev.preventDefault();
    mostrarErro($('#criar-erro'), '');
    const fixa = $('#criar-fixa').checked;
    const slug = fixa ? $('#criar-slug').value.trim().toLowerCase() : '';
    if (fixa && !slug) return mostrarErro($('#criar-erro'), 'Escolha o nome do link fixo.');
    try {
      const r = await api.criar($('#criar-titulo').value.trim(), slug);
      $('#criar-titulo').value = '';
      $('#criar-slug').value = '';
      $('#criar-fixa').checked = false;
      mostrar($('#criar-slug-campo'), false);
      await mostrarPainel();
      const link = linkDaSala(r.id);
      const ok = await janela('Reunião criada', [
        'Envie este link para as pessoas:',
        link,
        'Na hora da reunião, abra o mesmo link e toque em “Sou a anfitriã”. Quem chegar ficará esperando até você permitir a entrada.',
      ], [
        { rotulo: 'Copiar link', valor: 'copiar' },
        { rotulo: 'Entrar agora', valor: 'entrar', primario: true },
        { rotulo: 'Fechar', valor: 'fechar' },
      ]);
      if (ok === 'copiar') aviso((await copiar(link)) ? 'Link copiado.' : 'Não consegui copiar.', { tipo: 'bom' });
      if (ok === 'entrar') location.href = link;
    } catch (e) {
      if (e.codigo === 'nao-autorizada') mostrarLogin();
      mostrarErro($('#criar-erro'), mensagemDeErro(e));
    }
  });
  ao('#btn-sair-conta', 'click', () => {
    sessao.limpar();
    mostrarLogin();
  });
}

// ======================================================================
// Antes de entrar (pré-visualização)
// ======================================================================
async function iniciarSala(id) {
  S.salaId = id;
  S.encerrando = false;
  try {
    S.info = await api.info(id);
  } catch (e) {
    if (e.status === 404) return fim('Sala não encontrada', 'Confira o link ou peça um novo para a anfitriã. Se a reunião era antiga, a sala pode ter sido removida.');
    return fim('Não foi possível abrir a sala', mensagemDeErro(e));
  }
  S.titulo = S.info.title || 'Reunião';
  document.title = S.titulo + ' · Sala de Reuniões';
  texto($('#lobby-titulo'), S.titulo);
  mostrar($('#lobby-aviso-app'), navegadorEmbutido());
  mostrar($('#lobby-gravacao'), !!S.info.recording);
  mostrar($('#lobby-ausente'), !S.info.hostPresent);

  const guardado = lerNome();
  $('#lobby-nome').value = guardado || (sessao.token() ? cfg.nomePadraoAnfitria : '');
  atualizarBotaoEntrar();
  ir('lobby');

  // confere se a sessão de anfitriã ainda vale
  if (sessao.token()) {
    api.salas().then(atualizarBotaoEntrar).catch(atualizarBotaoEntrar);
  }
  await abrirPrevia();
}

function lerNome() {
  try { return localStorage.getItem('sala.nome') || ''; } catch (e) { return ''; }
}

function atualizarBotaoEntrar() {
  const host = !!sessao.token();
  texto($('#lobby-entrar'), host ? 'Entrar como anfitriã' : 'Pedir para entrar');
  texto($('#lobby-explica'), host
    ? 'Você vai receber os pedidos de entrada e decidir quem participa.'
    : 'A anfitriã vai receber o seu pedido e permitir a sua entrada.');
  mostrar($('#lobby-anfitria'), !host);
}

async function pegarMidia(pedido) {
  try {
    return { fluxo: await navigator.mediaDevices.getUserMedia(pedido), erro: null };
  } catch (e) {
    return { fluxo: null, erro: e };
  }
}

function pedidoDeMidia(camId, micId) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (micId) audio.deviceId = { exact: micId };
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  if (camId) video.deviceId = { exact: camId };
  else video.facingMode = 'user';
  return { audio, video };
}

// Abre câmera e microfone; se um deles faltar, continua com o que tiver.
async function abrirMidia(camId, micId) {
  const ped = pedidoDeMidia(camId, micId);
  let r = await pegarMidia(ped);
  if (r.fluxo) return { fluxo: r.fluxo, erro: null };
  if (r.erro && (r.erro.name === 'NotAllowedError' || r.erro.name === 'SecurityError')) return { fluxo: null, erro: r.erro };
  const a = await pegarMidia({ audio: ped.audio });
  const v = await pegarMidia({ video: ped.video });
  const trilhas = [];
  if (a.fluxo) trilhas.push(...a.fluxo.getTracks());
  if (v.fluxo) trilhas.push(...v.fluxo.getTracks());
  if (trilhas.length) return { fluxo: new MediaStream(trilhas), erro: null, parcial: true };
  return { fluxo: null, erro: r.erro };
}

function pararFluxo(f) {
  if (f) f.getTracks().forEach((t) => t.stop());
}

// Guarda a promessa para o "Entrar" poder esperar a câmera terminar de abrir.
function abrirPrevia(camId, micId) {
  S.previaPromessa = abrirPreviaInterno(camId, micId);
  return S.previaPromessa;
}

async function abrirPreviaInterno(camId, micId) {
  pararFluxo(S.fluxoLocal);
  S.fluxoLocal = null;
  mostrar($('#lobby-midia-erro'), false);
  mostrar($('.previa-botoes'), false); // só aparecem depois que a câmera termina de abrir
  const r = await abrirMidia(camId, micId);
  if (r.fluxo) {
    S.fluxoLocal = r.fluxo;
    S.micLigado = r.fluxo.getAudioTracks().length > 0 && S.micLigado !== false;
    S.camLigada = r.fluxo.getVideoTracks().length > 0 && S.camLigada !== false;
    aplicarHabilitado();
    if (!r.fluxo.getVideoTracks().length) avisoMidia('Não encontramos uma câmera. Você poderá participar só com o áudio.');
    else if (!r.fluxo.getAudioTracks().length) avisoMidia('Não encontramos um microfone. Você poderá ouvir e ver, mas não falar.');
  } else {
    const nome = r.erro && r.erro.name;
    S.erroMidia = nome ? nome + (r.erro.message ? ' — ' + r.erro.message : '') : 'desconhecido';
    registrar('erro ao abrir câmera/microfone: ' + S.erroMidia);
    if (nome === 'NotAllowedError' || nome === 'SecurityError') {
      if (ehIOS()) {
        avisoMidia('A câmera e o microfone não foram liberados. No iPhone, o Safari só pergunta de novo se você abrir a página outra vez: toque em “Recarregar” e, quando aparecer o pedido, escolha “Permitir”. Se não aparecer, toque em “aA” na barra de endereço, depois em “Ajustes do site” e libere a Câmera e o Microfone. Você também pode entrar só para assistir e ouvir.', 'recarregar');
      } else {
        avisoMidia('A câmera e o microfone estão bloqueados. Toque no ícone de cadeado ou de câmera ao lado do endereço do site, permita o acesso e toque em “Tentar de novo”. Você também pode entrar só para assistir e ouvir.', true);
      }
    } else if (nome === 'NotReadableError') {
      avisoMidia('A câmera ou o microfone estão sendo usados por outro programa. Feche-o e toque em “Tentar de novo”.', true);
    } else {
      avisoMidia('Não encontramos câmera nem microfone. Você ainda pode entrar para assistir e ouvir.', true);
    }
  }
  $('#lobby-video').srcObject = S.fluxoLocal;
  desenharPrevia();
  mostrar($('.previa-botoes'), true);
  await listarDispositivos();
  // a câmera só ficou pronta depois de a pessoa já ter entrado: liga na chamada
  if (S.malha) {
    S.malha.atualizarLocal();
    enviarEstado();
    forcarTiles();
    atualizarBotoes();
    agendarRender();
  }
}

function avisoMidia(msg, comBotao) {
  const el = $('#lobby-midia-erro');
  el.textContent = msg + ' ';
  if (comBotao === 'recarregar') {
    el.appendChild(botaoPequeno('Recarregar', () => location.reload(), true));
  } else if (comBotao) {
    const b = botaoPequeno('Tentar de novo', () => abrirPrevia($('#sel-cam').value || undefined, $('#sel-mic').value || undefined));
    el.appendChild(b);
  }
  el.hidden = false;
}

function aplicarHabilitado() {
  if (!S.fluxoLocal) return;
  S.fluxoLocal.getAudioTracks().forEach((t) => (t.enabled = S.micLigado));
  S.fluxoLocal.getVideoTracks().forEach((t) => (t.enabled = S.camLigada));
}

function temAudio() { return !!(S.fluxoLocal && S.fluxoLocal.getAudioTracks().length); }
function temVideo() { return !!(S.fluxoLocal && S.fluxoLocal.getVideoTracks().length); }

function desenharPrevia() {
  const mic = $('#lobby-mic');
  const cam = $('#lobby-cam');
  mic.innerHTML = icone(S.micLigado && temAudio() ? 'mic' : 'micOff');
  cam.innerHTML = icone(S.camLigada && temVideo() ? 'video' : 'videoOff');
  mic.classList.toggle('off', !(S.micLigado && temAudio()));
  cam.classList.toggle('off', !(S.camLigada && temVideo()));
  const semImagem = !(S.camLigada && temVideo());
  mostrar($('#lobby-avatar'), semImagem);
  $('#lobby-avatar').innerHTML = '<span></span>';
  $('#lobby-avatar').firstChild.textContent = inicial($('#lobby-nome').value || '?');
}

async function listarDispositivos() {
  try {
    const todos = await navigator.mediaDevices.enumerateDevices();
    const cams = todos.filter((d) => d.kind === 'videoinput');
    const mics = todos.filter((d) => d.kind === 'audioinput');
    S.camerasDisponiveis = cams;
    const atualCam = S.fluxoLocal && S.fluxoLocal.getVideoTracks()[0] ? S.fluxoLocal.getVideoTracks()[0].getSettings().deviceId : '';
    const atualMic = S.fluxoLocal && S.fluxoLocal.getAudioTracks()[0] ? S.fluxoLocal.getAudioTracks()[0].getSettings().deviceId : '';
    preencherSelect($('#sel-cam'), cams, atualCam, 'Câmera');
    preencherSelect($('#sel-mic'), mics, atualMic, 'Microfone');
  } catch (e) {}
}

function preencherSelect(sel, lista, atual, padrao) {
  sel.textContent = '';
  if (!lista.length) {
    const o = document.createElement('option');
    o.textContent = 'Nenhum encontrado';
    o.value = '';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  lista.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || padrao + ' ' + (i + 1);
    if (d.deviceId === atual) o.selected = true;
    sel.appendChild(o);
  });
}

function ligarLobby() {
  // no computador os seletores já ficam abertos; no celular ficam recolhidos
  const det = $('#dispositivos');
  if (det) det.open = !!(window.matchMedia && window.matchMedia('(min-width: 820px)').matches);
  ao('#lobby-mic', 'click', () => {
    if (!temAudio()) return abrirPrevia();
    S.micLigado = !S.micLigado;
    aplicarHabilitado();
    desenharPrevia();
  });
  ao('#lobby-cam', 'click', () => {
    if (!temVideo()) return abrirPrevia();
    S.camLigada = !S.camLigada;
    aplicarHabilitado();
    desenharPrevia();
  });
  ao('#sel-cam', 'change', () => abrirPrevia($('#sel-cam').value || undefined, $('#sel-mic').value || undefined));
  ao('#sel-mic', 'change', () => abrirPrevia($('#sel-cam').value || undefined, $('#sel-mic').value || undefined));
  ao('#lobby-nome', 'input', desenharPrevia);
  ao('#lobby-entrar', 'click', entrar);
  ao('#lobby-nome', 'keydown', (ev) => { if (ev.key === 'Enter') entrar(); });
  ao('#lobby-copiar-link', 'click', async () => {
    aviso((await copiar(location.href)) ? 'Link copiado. Cole no Safari ou no Chrome.' : 'Não consegui copiar.', { tipo: 'bom' });
  });
  ao('#lobby-anfitria-link', 'click', () => {
    const f = $('#lobby-login');
    f.hidden = !f.hidden;
    if (!f.hidden) $('#lobby-senha').focus();
  });
  ao('#lobby-login', 'submit', async (ev) => {
    ev.preventDefault();
    mostrarErro($('#lobby-login-erro'), '');
    try {
      await api.entrar($('#lobby-senha').value);
      $('#lobby-senha').value = '';
      mostrar($('#lobby-login'), false);
      if (!$('#lobby-nome').value.trim()) $('#lobby-nome').value = cfg.nomePadraoAnfitria;
      atualizarBotaoEntrar();
      desenharPrevia();
    } catch (e) {
      mostrarErro($('#lobby-login-erro'), mensagemDeErro(e));
    }
  });
}

// ======================================================================
// Entrar na sala
// ======================================================================
async function entrar() {
  const nome = $('#lobby-nome').value.trim();
  if (!nome) {
    mostrarErro($('#lobby-erro'), 'Digite o seu nome para a anfitriã saber quem está chegando.');
    $('#lobby-nome').focus();
    return;
  }
  mostrarErro($('#lobby-erro'), '');
  S.nome = nome.slice(0, 40);
  try { localStorage.setItem('sala.nome', S.nome); } catch (e) {}
  liberarSom();
  prepararElementosDeMidia(); // precisa acontecer aqui, dentro do toque (iPhone)
  registrar('toque em entrar');
  $('#lobby-entrar').disabled = true;

  // espera a câmera/microfone terminarem de abrir (até 6 s; se a pessoa ainda estiver
  // respondendo ao pedido de permissão, entra assim mesmo e a mídia é ligada depois)
  if (S.previaPromessa) {
    await Promise.race([S.previaPromessa, new Promise((ok) => setTimeout(ok, 6000))]);
  }

  try {
    const r = await api.ice(S.salaId);
    S.ice = r.iceServers;
  } catch (e) {
    S.ice = [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
  S.chave = chaveDaAba();
  S.pausado = false;
  S.fila = [];
  S.sig = new Sinalizacao({
    url: urlWs(S.salaId),
    montarEntrada: () => ({
      t: 'join',
      name: S.nome,
      key: S.chave,
      hostSession: sessao.token() || undefined,
    }),
    aoMensagem: receber,
    aoEstado: aoEstadoDoSinal,
  });
  S.sig.conectar();
}

function chaveDaAba() {
  const k = 'sala.chave.' + S.salaId;
  try {
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = gerarChave();
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch (e) {
    return gerarChave();
  }
}

function aoEstadoDoSinal(estado, codigo) {
  registrar('sinalizador: ' + estado + (codigo ? ' (' + codigo + ')' : ''));
  if (estado === 'reconectando') {
    S.reconectando = true;
    atualizarFaixa();
  } else if (estado === 'aberta') {
    S.reconectando = false;
    atualizarFaixa();
  } else if (estado === 'falhou') {
    limparChamada();
    fim('Não conseguimos conectar', 'Verifique a sua internet e abra o link da reunião de novo.');
  }
}

// ======================================================================
// Mensagens do sinalizador
// ======================================================================
function receber(m) {
  if (S.pausado && m.t !== 'ended' && m.t !== 'removed' && m.t !== 'denied') {
    S.fila.push(m);
    return;
  }
  tratar(m);
}

function tratar(m) {
  if (m.t !== 'signal' && m.t !== 'state') registrar('servidor: ' + m.t);
  switch (m.t) {
    case 'waiting': return aoEsperar(m);
    case 'welcome': return aoBoasVindas(m);
    case 'denied': return terminar('Entrada não permitida', 'A anfitriã não permitiu a sua entrada agora. Se foi engano, fale com ela e abra o link de novo.');
    case 'removed': return terminar('Você saiu da reunião', 'A anfitriã removeu você da reunião.');
    case 'ended': return aoEncerrada(m);
    case 'error':
      if (m.code === 'locked') return terminar('Reunião trancada', 'A anfitriã trancou a sala e não está recebendo novas pessoas agora.');
      if (m.code === 'busy') return terminar('Sala cheia de pedidos', 'Há muitas pessoas esperando. Tente de novo em alguns minutos.');
      return;
    case 'peer-joined': return aoEntrar(m.peer);
    case 'peer-left': return aoSair(m.id);
    case 'signal': if (S.malha) S.malha.sinal(m.from, m.data); return;
    case 'state': return aoEstado(m);
    case 'knock': return aoBater(m);
    case 'knock-cancel': return aoDesistir(m.id);
    case 'waiting-list': return aoListaEspera(m.list || []);
    case 'recording': return aoGravacao(m);
    case 'locked': S.trancada = !!m.value; renderPainel(); return;
    case 'host-present': S.anfitriaPresente = !!m.value; atualizarFaixa(); atualizarEsperaTexto(); return;
    case 'share-result': if (S.shareResolve) { S.shareResolve(m); S.shareResolve = null; } return;
    case 'stop-share': pararCompartilhar(); aviso('A anfitriã encerrou o seu compartilhamento de tela.'); return;
    case 'consent': aviso(m.name + ' está ciente de que a reunião é gravada.', { ms: 3500 }); return;
    case 'full': aviso('A sala está cheia (' + m.max + ' pessoas). Não é possível aceitar mais ninguém agora.'); return;
  }
}

// ---------- espera ----------
function aoEsperar(m) {
  S.anfitriaPresente = !!m.hostPresent;
  if (!$('#v-espera').hidden) return atualizarEsperaTexto();
  ir('espera');
  atualizarEsperaTexto();
  mostrar($('#espera-gravacao'), !!(S.info && S.info.recording));
}

function atualizarEsperaTexto() {
  texto($('#espera-texto'), S.anfitriaPresente
    ? 'A anfitriã foi avisada e vai permitir a sua entrada em instantes.'
    : 'A anfitriã ainda não abriu a sala. Deixe esta tela aberta: você entra assim que ela permitir.');
}

// ---------- boas-vindas ----------
async function aoBoasVindas(m) {
  const mesmoId = S.meuId === m.id;
  if (!mesmoId && S.malha) limparChamada(true); // o servidor não nos reconheceu: recomeça limpo
  S.meuId = m.id;
  S.papel = m.role;
  S.titulo = m.title || S.titulo;
  S.gravando = !!m.recording;
  S.trancada = !!m.locked;
  S.anfitriaPresente = !!m.hostPresent;
  S.pares = new Map((m.peers || []).map((p) => [p.id, p]));

  if (S.malha) {
    // retomada depois de uma queda: as conexões diretas continuam
    renderizar();
    enviarEstado();
    return;
  }

  if (!eAnfitria() && S.gravando) {
    S.pausado = true;
    const ok = await janela('Esta reunião está sendo gravada', [
      'A anfitriã está gravando este encontro (imagem e áudio de todos). A gravação fica guardada no computador dela.',
      'Ao continuar, você concorda em participar de uma reunião gravada.',
    ], [
      { rotulo: 'Sair', valor: false },
      { rotulo: 'Entendi, quero entrar', valor: true, primario: true },
    ]);
    if (!ok) {
      S.pausado = false;
      return terminar('Você saiu da reunião', 'Você escolheu não participar de uma reunião gravada.', true);
    }
    S.sig.enviar({ t: 'consent' });
  }
  iniciarChamada();
  S.pausado = false;
  const fila = S.fila;
  S.fila = [];
  fila.forEach(tratar);
}

function iniciarChamada() {
  S.malha = new Malha({
    meuId: S.meuId,
    servidoresIce: S.ice,
    enviarSinal: (para, dados) => S.sig && S.sig.enviar({ t: 'signal', to: para, data: dados }),
    local: () => ({ cam: S.fluxoLocal, tela: S.tela }),
    aoMudar: agendarRender,
    aoEstadoLigacao: agendarRender,
    registrar,
  });
  registrar('entrou na chamada como ' + S.papel + ' com ' + S.pares.size + ' pessoa(s)');
  S.pares.forEach((p) => S.malha.ligar(p.id, true));
  ir('call');
  montarBarra();
  S.inicioChamada = Date.now();
  clearInterval(S.relogio);
  let tic = 0;
  S.relogio = setInterval(() => {
    texto($('#call-timer'), formatarTempo((Date.now() - S.inicioChamada) / 1000));
    if (++tic % 5 === 0) agendarRender(); // reavalia "conectando/falhou" com o passar do tempo
  }, 1000);
  texto($('#call-titulo'), S.titulo);
  mostrar($('#b-convite'), eAnfitria());
  mostrar($('#b-rec'), eAnfitria());
  mostrar($('#painel-anfitria'), eAnfitria());
  pedirWakeLock();
  enviarEstado();
  renderizar();
  atualizarFaixa();
}

// ---------- pessoas entrando e saindo ----------
function aoEntrar(p) {
  S.pares.set(p.id, p);
  if (S.malha) S.malha.ligar(p.id, false);
  aviso(p.name + ' entrou na reunião.', { ms: 3000 });
  agendarRender();
}

function aoSair(id) {
  const p = S.pares.get(id);
  S.pares.delete(id);
  if (S.malha) S.malha.remover(id);
  if (p) aviso(p.name + ' saiu da reunião.', { ms: 3000 });
  agendarRender();
}

function aoEstado(m) {
  const p = S.pares.get(m.id);
  if (!p) return;
  p.mic = m.mic;
  p.cam = m.cam;
  p.screenStreamId = m.screenStreamId;
  agendarRender();
}

function enviarEstado() {
  if (!S.sig) return;
  S.sig.enviar({ t: 'state', mic: S.micLigado && temAudio(), cam: S.camLigada && temVideo() });
}

// ---------- pedidos de entrada (anfitriã) ----------
function aoBater(m) {
  if (!eAnfitria()) return;
  S.espera.set(m.id, m.name);
  bip();
  const fechar = aviso(m.name + ' quer entrar na reunião.', {
    ms: 0,
    botoes: [
      { rotulo: 'Aceitar', acao: () => decidir('admit', m.id) },
      { rotulo: 'Recusar', secundario: true, acao: () => decidir('deny', m.id) },
    ],
  });
  S.avisosEspera.set(m.id, fechar);
  renderPainel();
}

function aoDesistir(id) {
  S.espera.delete(id);
  const fechar = S.avisosEspera.get(id);
  if (fechar) fechar();
  S.avisosEspera.delete(id);
  renderPainel();
}

function aoListaEspera(lista) {
  if (!eAnfitria()) return;
  lista.forEach((w) => {
    if (!S.espera.has(w.id)) aoBater({ id: w.id, name: w.name });
  });
}

function decidir(acao, id) {
  S.sig.enviar({ t: acao, id });
  aoDesistir(id);
}

// ---------- gravação (aviso para todos) ----------
async function aoGravacao(m) {
  const antes = S.gravando;
  S.gravando = !!m.value;
  atualizarBadge();
  if (eAnfitria()) return;
  if (S.gravando && !antes) {
    S.pausado = true;
    bip();
    const ok = await janela('A anfitriã começou a gravar', [
      'Esta reunião está sendo gravada agora (imagem e áudio de todos). A gravação fica guardada no computador da anfitriã.',
    ], [
      { rotulo: 'Sair da reunião', valor: false },
      { rotulo: 'Entendi, continuar', valor: true, primario: true },
    ]);
    S.pausado = false;
    const fila = S.fila;
    S.fila = [];
    fila.forEach(tratar);
    if (!ok) return sairDaSala('sair');
    S.sig.enviar({ t: 'consent' });
  } else if (!S.gravando && antes) {
    aviso('A gravação foi encerrada.');
  }
}

function atualizarBadge() {
  mostrar($('#badge-rec'), S.gravando);
  const b = $('#b-rec');
  const ativa = !!(S.gravador && S.gravador.ativo);
  b.classList.toggle('gravando', ativa);
  b.querySelector('.ic').innerHTML = icone(ativa ? 'parar' : 'gravar', true);
  texto(b.querySelector('.rot'), ativa ? 'Parar' : 'Gravar');
}

// ======================================================================
// Chamada: barra de botões
// ======================================================================
function montarBarra() {
  const def = [
    ['#b-mic', 'mic'], ['#b-cam', 'video'], ['#b-tela', 'tela'], ['#b-trocar', 'virar'],
    ['#b-rec', 'gravar'], ['#b-pessoas', 'pessoas'], ['#b-sair', 'sair'],
  ];
  def.forEach(([sel, ic]) => {
    $(sel).querySelector('.ic').innerHTML = icone(ic, ic === 'gravar');
  });
  $('#b-convite').innerHTML = icone('copiar');
  $('#painel-fechar').innerHTML = icone('x');
  mostrar($('#b-tela'), suportaCompartilharTela());
  mostrar($('#b-trocar'), ehCelular() && (S.camerasDisponiveis || []).length > 1);
  atualizarBotoes();
  atualizarBadge();
}

function atualizarBotoes() {
  const mic = S.micLigado && temAudio();
  const cam = S.camLigada && temVideo();
  const bm = $('#b-mic');
  bm.classList.toggle('off', !mic);
  bm.querySelector('.ic').innerHTML = icone(mic ? 'mic' : 'micOff');
  texto(bm.querySelector('.rot'), mic ? 'Microfone' : 'Sem som');
  const bc = $('#b-cam');
  bc.classList.toggle('off', !cam);
  bc.querySelector('.ic').innerHTML = icone(cam ? 'video' : 'videoOff');
  texto(bc.querySelector('.rot'), cam ? 'Câmera' : 'Sem vídeo');
  const bt = $('#b-tela');
  bt.classList.toggle('ativo', !!S.tela);
  texto(bt.querySelector('.rot'), S.tela ? 'Parar tela' : 'Compartilhar');
}

async function alternarMic() {
  if (!temAudio()) {
    await reabrirMidia();
    return;
  }
  S.micLigado = !S.micLigado;
  aplicarHabilitado();
  atualizarBotoes();
  enviarEstado();
  agendarRender();
}

async function alternarCam() {
  if (!temVideo()) {
    await reabrirMidia();
    return;
  }
  S.camLigada = !S.camLigada;
  aplicarHabilitado();
  atualizarBotoes();
  enviarEstado();
  agendarRender();
}

// Se a pessoa liberou a câmera/microfone depois de entrar.
async function reabrirMidia() {
  const r = await abrirMidia();
  if (!r.fluxo) {
    aviso('Não consegui acessar a câmera ou o microfone. Libere o acesso nas configurações do navegador.', { ms: 6000 });
    return;
  }
  pararFluxo(S.fluxoLocal);
  S.fluxoLocal = r.fluxo;
  S.micLigado = true;
  S.camLigada = true;
  aplicarHabilitado();
  if (S.malha) S.malha.atualizarLocal();
  atualizarBotoes();
  enviarEstado();
  forcarTiles();
  agendarRender();
}

async function trocarCamera() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (cams.length < 2 || !S.fluxoLocal) return;
  const atual = S.fluxoLocal.getVideoTracks()[0];
  const idAtual = atual ? atual.getSettings().deviceId : '';
  const i = cams.findIndex((c) => c.deviceId === idAtual);
  const prox = cams[(i + 1) % cams.length];
  const r = await pegarMidia({ video: { deviceId: { exact: prox.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  if (!r.fluxo) return aviso('Não consegui trocar de câmera.');
  const nova = r.fluxo.getVideoTracks()[0];
  S.fluxoLocal.getVideoTracks().forEach((t) => {
    S.fluxoLocal.removeTrack(t);
    t.stop();
  });
  nova.enabled = S.camLigada;
  S.fluxoLocal.addTrack(nova);
  if (S.malha) S.malha.atualizarLocal();
  forcarTiles();
  agendarRender();
}

// ---------- compartilhar tela ----------
async function alternarTela() {
  if (S.tela) return pararCompartilhar();
  if (!suportaCompartilharTela()) return aviso('Este aparelho não permite compartilhar a tela pelo navegador. Use um computador.');
  let fluxo;
  try {
    fluxo = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true });
  } catch (e) {
    if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') aviso('Não foi possível compartilhar a tela.');
    return;
  }
  const v = fluxo.getVideoTracks()[0];
  if (v && 'contentHint' in v) v.contentHint = 'detail';
  // pede a vez ao servidor (só uma pessoa compartilha por vez)
  const resp = await new Promise((resolve) => {
    S.shareResolve = resolve;
    S.sig.enviar({ t: 'state', screenStreamId: fluxo.id });
    setTimeout(() => {
      if (S.shareResolve === resolve) {
        S.shareResolve = null;
        resolve({ ok: false, timeout: true });
      }
    }, 5000);
  });
  if (!resp.ok) {
    pararFluxo(fluxo);
    aviso(resp.by ? resp.by + ' já está compartilhando a tela.' : 'Não foi possível compartilhar agora. Tente de novo.');
    return;
  }
  S.tela = fluxo;
  if (v) v.addEventListener('ended', pararCompartilhar);
  if (S.malha) S.malha.atualizarTela();
  atualizarBotoes();
  agendarRender();
}

function pararCompartilhar() {
  if (!S.tela) return;
  const f = S.tela;
  S.tela = null;
  S.sig && S.sig.enviar({ t: 'state', screenStreamId: null });
  if (S.malha) S.malha.atualizarTela();
  pararFluxo(f);
  atualizarBotoes();
  agendarRender();
}

// ---------- gravar (anfitriã) ----------
async function alternarGravacao() {
  if (S.gravador && S.gravador.ativo) return pararGravacao();
  if (S.gravador && S.gravador.finalizando) return aviso('Ainda estou salvando a gravação anterior. Espere alguns segundos.');
  const sup = suporteGravacao();
  if (!sup.gravar) {
    return aviso('Este navegador não consegue gravar a reunião. Use o Chrome ou o Edge no computador.', { ms: 6000 });
  }
  const ok = await janela('Gravar esta reunião?', [
    'Todas as pessoas serão avisadas, na hora, de que a reunião está sendo gravada. Quem entrar depois também será avisada.',
    sup.direto
      ? 'O vídeo é salvo no seu computador em partes de até 500 MB, sozinho, sem parar a gravação. A seguir, escolha uma pasta (pode criar uma chamada “Gravações”) e permita que o site salve nela. Nada é enviado para a internet.'
      : 'O vídeo é baixado em partes de até 500 MB, sozinho, sem parar a gravação. Se o navegador perguntar se pode baixar vários arquivos, permita. Para reuniões longas, prefira o Chrome ou o Edge no computador.',
  ], [
    { rotulo: 'Cancelar', valor: false },
    { rotulo: 'Começar a gravar', valor: true, primario: true },
  ]);
  if (!ok) return;
  S.gravador = new Gravador({ titulo: S.titulo, obterCena, obterAudios, aoParte: aoSalvarParte, limiteParte: limiteDeTeste() });
  const r = await S.gravador.iniciar();
  if (!r.ok) {
    S.gravador = null;
    if (r.cancelou) aviso('A gravação não começou: é preciso escolher uma pasta para salvar.', { ms: 7000 });
    else if (r.erro === 'pasta') aviso('Não consegui salvar nessa pasta. Toque em Gravar de novo, escolha outra pasta e permita o acesso.', { ms: 9000 });
    else aviso('Não foi possível iniciar a gravação neste navegador.', { ms: 6000 });
    return;
  }
  S.sig.enviar({ t: 'recording', value: true });
  atualizarBadge();
  aviso('Gravando. Todos foram avisados.', { tipo: 'rec' });
}

async function pararGravacao() {
  const g = S.gravador;
  if (!g || !g.ativo) return;
  const r = await g.parar();
  if (S.gravador === g) S.gravador = null;
  S.sig && S.sig.enviar({ t: 'recording', value: false });
  atualizarBadge();
  if (r && r.partes && r.partes.length) aviso(resumoDaGravacao(r), { tipo: 'bom', ms: 15000 });
}

// Avisa a anfitriã a cada parte salva durante a gravação.
function aoSalvarParte(p) {
  registrar('gravação: parte ' + p.n + ' (' + Math.round(p.bytes / 1e6) + ' MB) em ' + p.onde);
  if (p.falhou) aviso('Não consegui salvar a parte ' + p.n + ' na pasta, então ela foi baixada: veja a pasta Downloads.', { ms: 15000 });
  else if (!p.ultima) {
    aviso(
      p.onde === 'disco' ? 'Parte ' + p.n + ' salva. A gravação continua.' : 'Parte ' + p.n + ' baixada (pasta Downloads). A gravação continua.',
      { tipo: 'bom', ms: 6000 }
    );
  }
}

function resumoDaGravacao(r) {
  const total = r.partes.length;
  const naPasta = r.partes.filter((p) => p.onde === 'disco').length;
  const baixadas = total - naPasta;
  if (total === 1) {
    return naPasta
      ? 'Gravação salva na pasta “' + r.pasta + '”: ' + r.partes[0].nome
      : 'Gravação baixada: ' + r.partes[0].nome + ' (veja a pasta Downloads).';
  }
  if (!baixadas) return 'Gravação salva em ' + total + ' partes na pasta “' + r.pasta + '”.';
  if (!naPasta) return 'Gravação baixada em ' + total + ' partes (veja a pasta Downloads).';
  return 'Gravação salva: ' + naPasta + ' de ' + total + ' partes na pasta “' + r.pasta + '” e ' + baixadas + ' na pasta Downloads.';
}

// Só nos testes locais: troca de arquivo com poucos KB em vez de 500 MB.
function limiteDeTeste() {
  return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? window.__LIMITE_PARTE : undefined;
}

// O gravador pede a "cena" e os áudios a cada quadro/segundo.
function obterCena() {
  const pessoas = [];
  const eu = S.tiles.get('eu');
  if (eu) pessoas.push({ fluxo: S.fluxoLocal, video: eu.v, nome: S.nome + ' (você)', camLigada: S.camLigada && temVideo(), micLigado: S.micLigado && temAudio() });
  S.pares.forEach((p) => {
    const t = S.tiles.get(p.id);
    if (t) pessoas.push({ fluxo: S.malha ? fluxoCamera(p.id) : null, video: t.v, nome: p.name, camLigada: p.cam !== false && t.temVideo, micLigado: p.mic !== false });
  });
  const stage = S.stageVideo && !$('#stage').hidden ? { fluxo: S.stageFluxo, video: S.stageVideo, nome: S.nomeDaTela || '' } : null;
  return { tela: stage, pessoas };
}

function obterAudios() {
  const m = new Map();
  if (S.fluxoLocal) m.set('eu', S.fluxoLocal);
  if (S.tela && S.tela.getAudioTracks().length) m.set('minha-tela', S.tela);
  if (S.malha) {
    S.pares.forEach((p) => {
      S.malha.fluxos(p.id).forEach((f, fid) => m.set(p.id + ':' + fid, f));
    });
  }
  return m;
}

// ---------- sair ----------
async function pedirSair() {
  if (!eAnfitria()) {
    const ok = await janela('Sair da reunião?', [], [
      { rotulo: 'Ficar', valor: false },
      { rotulo: 'Sair', valor: true, perigo: true },
    ]);
    if (ok) sairDaSala('sair');
    return;
  }
  const gravando = !!(S.gravador && S.gravador.ativo);
  const corpo = [];
  if (gravando) corpo.push('A gravação será finalizada e salva no seu computador.');
  if (S.pares.size) corpo.push('Há ' + S.pares.size + (S.pares.size === 1 ? ' pessoa' : ' pessoas') + ' na reunião. Se você só sair, elas continuam por até 3 minutos esperando você voltar.');
  const r = await janela('Sair da reunião?', corpo, [
    { rotulo: 'Voltar', valor: 'voltar' },
    { rotulo: 'Só sair', valor: 'sair' },
    { rotulo: 'Encerrar para todos', valor: 'encerrar', perigo: true },
  ]);
  if (r === 'sair' || r === 'encerrar') sairDaSala(r);
}

async function sairDaSala(modo) {
  S.encerrando = true;
  if (S.gravador && S.gravador.ativo) await pararGravacao();
  if (modo === 'encerrar') S.sig.enviar({ t: 'end' });
  S.sig && S.sig.sair();
  limparChamada();
  pararFluxo(S.fluxoLocal);
  S.fluxoLocal = null;
  fim(modo === 'encerrar' ? 'Reunião encerrada' : 'Você saiu da reunião', modo === 'encerrar' ? 'Todos foram desconectados.' : 'Para voltar, abra o link da reunião de novo.', true);
}

async function aoEncerrada(m) {
  if (S.encerrando) return;
  if (S.gravador && S.gravador.ativo) await pararGravacao();
  const motivo = m.reason === 'host-absent'
    ? 'A anfitriã ficou fora da sala por mais de 3 minutos.'
    : m.reason === 'deleted' ? 'Esta reunião foi excluída.' : 'A anfitriã encerrou a reunião.';
  terminar('Reunião encerrada', motivo);
}

// Termina por decisão do servidor (recusada, removida, encerrada…).
function terminar(titulo, msg, jaSaiu) {
  if (!jaSaiu) S.sig && S.sig.fechar();
  limparChamada();
  pararFluxo(S.fluxoLocal);
  S.fluxoLocal = null;
  fim(titulo, msg);
}

function fim(titulo, msg, forcado) {
  if (S.gravador && S.gravador.ativo && !forcado) pararGravacao();
  texto($('#fim-titulo'), titulo);
  texto($('#fim-texto'), msg || '');
  document.title = 'Sala de Reuniões · Pâmela Pissutti';
  ir('fim');
}

function limparChamada(mantemMidia) {
  clearInterval(S.relogio);
  if (S.tela) pararFluxo(S.tela);
  S.tela = null;
  if (S.malha) S.malha.fechar();
  S.malha = null;
  S.tiles.forEach((t) => t.el.remove());
  S.tiles.clear();
  S.pares = new Map();
  S.espera.clear();
  S.avisosEspera.forEach((f) => f());
  S.avisosEspera.clear();
  $('#grid').textContent = '';
  $('#stage').textContent = '';
  S.stageVideo = null;
  mostrar($('#stage'), false);
  mostrar($('#painel'), false);
  mostrar($('#faixa'), false);
  mostrar($('#som-faixa'), false);
  if (S.wakeLock) {
    try { S.wakeLock.release(); } catch (e) {}
    S.wakeLock = null;
  }
  if (!mantemMidia) S.meuId = null;
}

// ======================================================================
// Chamada: desenho dos quadros
// ======================================================================
function agendarRender() {
  if (S.desenhoAgendado) return;
  S.desenhoAgendado = true;
  requestAnimationFrame(() => {
    S.desenhoAgendado = false;
    renderizar();
  });
}

function forcarTiles() {
  S.tiles.forEach((t) => (t.fluxo = undefined));
}

function criarTile(id, ehEu) {
  const el = document.createElement('div');
  el.className = 'tile' + (ehEu ? ' eu' : '');
  // usa um elemento já "destravado" no toque de entrar (essencial no iPhone); senão cria um novo
  let v = !ehEu && S.pool.length ? S.pool.pop() : null;
  if (!v) {
    v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
  }
  v.muted = !!ehEu;
  v.autoplay = true;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.appendChild(document.createElement('span'));
  const nome = document.createElement('div');
  nome.className = 'nome';
  const micEl = document.createElement('span');
  micEl.className = 'mic';
  const txt = document.createElement('span');
  nome.append(micEl, txt);
  el.append(v, av, nome);
  return { id, el, v, av, micEl, txt, fluxo: undefined, temVideo: false, criadoEm: Date.now() };
}

// Toca o vídeo. Se o aparelho (iPhone) bloquear o som por falta de toque, mostra a imagem
// sem som e pede um toque na tela para liberar o áudio.
function tocar(v) {
  const p = v.play();
  if (p && p.catch) {
    p.catch((e) => {
      S.somBloqueado++;
      registrar('som bloqueado pelo aparelho (' + ((e && e.name) || 'erro') + ')');
      if (!v.muted) {
        v.muted = true;
        v.dataset.mudoPorBloqueio = '1';
        const q = v.play();
        if (q && q.catch) q.catch(() => {});
      }
      mostrar($('#som-faixa'), true);
    });
  }
}

// Depois de um toque do usuário: liga o som dos vídeos que foram silenciados à força e mostra tudo.
function liberarSomDosVideos() {
  $$('#grid video, #stage video').forEach((v) => {
    if (v.dataset.mudoPorBloqueio === '1') {
      v.muted = false;
      delete v.dataset.mudoPorBloqueio;
    }
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  });
  mostrar($('#som-faixa'), false);
  liberarSom();
  registrar('toque para ativar o som');
}

function fluxoCamera(id) {
  const par = S.pares.get(id);
  const telaId = par ? par.screenStreamId : null;
  let achado = null;
  S.malha.fluxos(id).forEach((f, fid) => {
    if (fid !== telaId && !achado && f.getTracks().length) achado = f;
  });
  return achado;
}

function fluxoTelaDe(id) {
  const par = S.pares.get(id);
  if (!par || !par.screenStreamId) return null;
  return S.malha.fluxos(id).get(par.screenStreamId) || null;
}

function renderizar() {
  if (!S.malha || $('#v-call').hidden) return;
  const grid = $('#grid');

  // 1) quadros (eu + cada par)
  const ids = ['eu'].concat(Array.from(S.pares.keys()));
  Array.from(S.tiles.keys()).forEach((id) => {
    if (ids.indexOf(id) < 0) {
      S.tiles.get(id).el.remove();
      S.tiles.delete(id);
    }
  });
  const ordem = Array.from(S.pares.keys()).concat(['eu']);
  ordem.forEach((id, i) => {
    let t = S.tiles.get(id);
    if (!t) {
      t = criarTile(id, id === 'eu');
      S.tiles.set(id, t);
    }
    // mantém a ordem (eu por último) sem recolocar quem já está no lugar
    if (grid.children[i] !== t.el) grid.insertBefore(t.el, grid.children[i] || null);
    if (id === 'eu') {
      const camOn = S.camLigada && temVideo();
      if (t.fluxo !== S.fluxoLocal) {
        t.v.srcObject = S.fluxoLocal;
        t.fluxo = S.fluxoLocal;
        if (S.fluxoLocal) tocar(t.v);
      }
      t.temVideo = camOn;
      t.av.hidden = camOn;
      t.av.firstChild.textContent = inicial(S.nome);
      t.txt.textContent = S.nome + ' (você)';
      t.micEl.innerHTML = S.micLigado && temAudio() ? '' : icone('micOff');
      t.el.classList.remove('sem-conexao');
    } else {
      const p = S.pares.get(id);
      const f = fluxoCamera(id);
      if (t.fluxo !== f) {
        t.v.srcObject = f || null;
        t.fluxo = f;
        if (f) tocar(t.v);
      }
      const temV = !!(f && f.getVideoTracks().length);
      t.temVideo = temV;
      t.av.hidden = !!(temV && p.cam !== false);
      t.av.firstChild.textContent = inicial(p.name);
      t.txt.textContent = p.name + (p.role === 'host' ? ' · anfitriã' : '');
      t.micEl.innerHTML = p.mic === false ? icone('micOff') : '';
      const est = S.malha.estado(id);
      // Mesmo que a descrição do vídeo já tenha chegado, sem conexão de verdade o quadro fica preto:
      // por isso olhamos o estado real da conexão, não se já existe uma transmissão.
      const semConexao = est !== 'connected';
      const demorou = S.malha.haQuanto(id) > 20000;
      t.el.classList.toggle('sem-conexao', semConexao);
      // a conexão não completa (ou caiu e não volta): avisa, em vez de "Conectando…" para sempre
      t.el.classList.toggle('falhou', semConexao && (est === 'failed' || demorou));
    }
  });

  // 2) palco de tela compartilhada
  let telaFluxo = null;
  let quem = '';
  let minha = false;
  if (S.tela) {
    telaFluxo = S.tela;
    quem = S.nome;
    minha = true;
  } else {
    S.pares.forEach((p) => {
      if (!telaFluxo) {
        const f = fluxoTelaDe(p.id);
        if (f) {
          telaFluxo = f;
          quem = p.name;
        }
      }
    });
  }
  const stage = $('#stage');
  const palco = $('#palco');
  if (telaFluxo) {
    if (!S.stageVideo) {
      stage.textContent = '';
      const v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      stage.appendChild(v);
      const etq = document.createElement('div');
      etq.className = 'etq';
      etq.id = 'stage-etq';
      stage.appendChild(etq);
      const tc = document.createElement('button');
      tc.type = 'button';
      tc.className = 'topo-botao tc';
      tc.setAttribute('aria-label', 'Tela cheia');
      tc.innerHTML = icone('tamanho');
      tc.addEventListener('click', () => {
        const alvo = stage;
        if (document.fullscreenElement) document.exitFullscreen();
        else if (alvo.requestFullscreen) alvo.requestFullscreen().catch(() => {});
        else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
      });
      stage.appendChild(tc);
      S.stageVideo = v;
      S.stageFluxo = null;
    }
    if (S.stageFluxo !== telaFluxo) {
      S.stageVideo.srcObject = telaFluxo;
      S.stageVideo.muted = minha; // não repete o meu próprio som de volta
      S.stageFluxo = telaFluxo;
      tocar(S.stageVideo);
    }
    S.nomeDaTela = quem;
    texto($('#stage-etq'), minha ? 'Você está compartilhando a tela' : quem + ' está compartilhando a tela');
  } else if (S.stageVideo) {
    S.stageVideo.srcObject = null;
    stage.textContent = '';
    S.stageVideo = null;
    S.stageFluxo = null;
    S.nomeDaTela = '';
  }
  mostrar(stage, !!telaFluxo);
  palco.classList.toggle('com-tela', !!telaFluxo);
  grid.style.setProperty('--n', String(ids.length));

  // 3) grade
  ajustarGrade();
  atualizarBotoes();
  renderPainel();
  atualizarBadge();
  atualizarFaixa();
}

function ajustarGrade() {
  const grid = $('#grid');
  const n = S.tiles.size;
  const comTela = $('#palco').classList.contains('com-tela');
  const pip = n === 2 && !comTela;
  grid.classList.toggle('pip', pip);
  if (comTela) return;
  if (pip) {
    grid.style.setProperty('--cols', '1');
    grid.style.setProperty('--rows', '1');
    return;
  }
  const w = grid.clientWidth || window.innerWidth;
  const h = grid.clientHeight || window.innerHeight * 0.6;
  const g = melhorGrade(Math.max(n, 1), w, h, w >= h ? 16 / 9 : 3 / 4);
  grid.style.setProperty('--cols', String(g.cols));
  grid.style.setProperty('--rows', String(g.rows));
}

function atualizarFaixa() {
  const f = $('#faixa');
  let msg = '';
  if (S.reconectando) msg = 'Reconectando… verifique a sua internet.';
  else if (!eAnfitria() && !S.anfitriaPresente && S.malha) msg = 'A anfitriã saiu da sala. Se ela não voltar em 3 minutos, a reunião será encerrada.';
  else if (document.querySelector('#grid .tile.falhou')) msg = 'Não conseguimos conectar o vídeo com alguém. Tente trocar do Wi‑Fi para o 4G (ou o contrário), ou entre pelo computador. Toque em “Pessoas” para copiar um relatório.';
  f.textContent = msg;
  f.hidden = !msg;
}

// ---------- painel de participantes ----------
function renderPainel() {
  if (!S.malha) return;
  const host = eAnfitria();
  const nEspera = S.espera.size;
  const bn = $('#pessoas-n');
  bn.textContent = String(nEspera);
  bn.hidden = !(host && nEspera > 0);

  mostrar($('#painel-espera'), host && nEspera > 0);
  const le = $('#lista-espera');
  le.textContent = '';
  S.espera.forEach((nome, id) => {
    const li = document.createElement('li');
    const q = document.createElement('div');
    q.className = 'quem';
    q.textContent = nome;
    const ac = document.createElement('div');
    ac.className = 'acoes';
    ac.append(botaoPequeno('Aceitar', () => decidir('admit', id), true), botaoPequeno('Recusar', () => decidir('deny', id)));
    li.append(q, ac);
    le.appendChild(li);
  });

  const ld = $('#lista-dentro');
  ld.textContent = '';
  const linha = (nome, sub, acoes) => {
    const li = document.createElement('li');
    const q = document.createElement('div');
    q.className = 'quem';
    q.textContent = nome;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      q.appendChild(s);
    }
    li.appendChild(q);
    if (acoes && acoes.length) {
      const ac = document.createElement('div');
      ac.className = 'acoes';
      acoes.forEach((a) => ac.appendChild(a));
      li.appendChild(ac);
    }
    ld.appendChild(li);
  };
  linha(S.nome + ' (você)', host ? 'anfitriã' : '');
  S.pares.forEach((p) => {
    const acoes = [];
    if (host && p.role !== 'host') {
      if (p.screenStreamId) acoes.push(botaoPequeno('Parar tela', () => S.sig.enviar({ t: 'stop-share', id: p.id })));
      acoes.push(botaoPequeno('Remover', async () => {
        const ok = await janela('Remover ' + p.name + '?', ['Ela(e) sairá da reunião e não poderá voltar nos próximos minutos.'], [
          { rotulo: 'Cancelar', valor: false },
          { rotulo: 'Remover', valor: true, perigo: true },
        ]);
        if (ok) S.sig.enviar({ t: 'remove', id: p.id });
      }));
    }
    linha(p.name, p.role === 'host' ? 'anfitriã' : '', acoes);
  });
  $('#chk-trancar').checked = S.trancada;
}

async function pedirWakeLock() {
  try {
    if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}

function ligarChamada() {
  ao('#b-mic', 'click', alternarMic);
  ao('#b-cam', 'click', alternarCam);
  ao('#b-tela', 'click', alternarTela);
  ao('#b-trocar', 'click', trocarCamera);
  ao('#b-rec', 'click', alternarGravacao);
  ao('#b-sair', 'click', pedirSair);
  ao('#b-pessoas', 'click', () => {
    const p = $('#painel');
    p.hidden = !p.hidden;
    renderPainel();
  });
  ao('#painel-fechar', 'click', () => mostrar($('#painel'), false));
  ao('#painel-aceitar-todos', 'click', () => {
    S.sig.enviar({ t: 'admit-all' });
    Array.from(S.espera.keys()).forEach(aoDesistir);
  });
  ao('#chk-trancar', 'change', () => S.sig.enviar({ t: 'lock', value: $('#chk-trancar').checked }));
  const copiarConvite = async () => {
    aviso((await copiar(linkDaSala(S.salaId))) ? 'Link da reunião copiado.' : 'Não consegui copiar.', { tipo: 'bom' });
  };
  ao('#b-convite', 'click', copiarConvite);
  ao('#painel-copiar', 'click', copiarConvite);
  ao('#som-ativar', 'click', liberarSomDosVideos);
  // se a pessoa tocar em qualquer lugar da chamada enquanto o aviso de som está aberto, também libera
  ao('#v-call', 'click', () => { if (!$('#som-faixa').hidden) liberarSomDosVideos(); });
  ao('#lobby-relatorio', 'click', copiarRelatorio);
  ao('#painel-relatorio', 'click', copiarRelatorio);
  ao('#fim-voltar', 'click', () => {
    location.href = location.pathname;
  });
  ao('#espera-cancelar', 'click', () => {
    S.sig && S.sig.sair();
    pararFluxo(S.fluxoLocal);
    fim('Você saiu', 'Para voltar, abra o link da reunião de novo.', true);
  });

  window.addEventListener('resize', () => S.malha && ajustarGrade());
  window.addEventListener('orientationchange', () => setTimeout(() => S.malha && ajustarGrade(), 300));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.malha) {
      pedirWakeLock();
      $$('#grid video').forEach((v) => { if (v.paused && v.srcObject) v.play().catch(() => {}); });
    }
  });
  window.addEventListener('beforeunload', (ev) => {
    if (S.gravador && (S.gravador.ativo || S.gravador.finalizando)) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
}

// ======================================================================
// Início
// ======================================================================
async function iniciar() {
  registrar('página aberta' + (navegadorEmbutido() ? ' (navegador embutido em outro app)' : ''));
  if (!suporteCompleto()) {
    ir('fim');
    if (navegadorEmbutido()) {
      texto($('#fim-titulo'), 'Abra no navegador do celular');
      texto($('#fim-texto'), 'O aplicativo em que você abriu este link não permite videochamada. Toque nos três pontinhos (ou no ícone de compartilhar) e escolha “Abrir no Safari” ou “Abrir no navegador”. Também dá para copiar o link e colar no Safari ou no Chrome.');
    } else {
      texto($('#fim-titulo'), 'Navegador não compatível');
      texto($('#fim-texto'), 'Este navegador não consegue fazer videochamadas. Abra o link no Chrome, Edge, Firefox ou Safari atualizados.');
    }
    mostrar($('#fim-voltar'), false);
    return;
  }
  ligarHome();
  ligarLobby();
  ligarChamada();
  const id = new URLSearchParams(location.search).get('sala');
  if (id) await iniciarSala(id.trim().toLowerCase());
  else await iniciarHome();
}

// Gancho só para os testes automáticos locais (não existe no site publicado).
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__SALA = { S };

iniciar();
