// Funções de apoio da interface.

export const $ = (sel, raiz) => (raiz || document).querySelector(sel);
export const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));

export function mostrar(el, sim) {
  if (!el) return;
  if (sim === undefined) sim = true;
  el.hidden = !sim;
}

export function texto(el, valor) {
  if (el) el.textContent = valor;
}

export function inicial(nome) {
  const n = String(nome || '?').trim();
  return (n.charAt(0) || '?').toUpperCase();
}

export function formatarTempo(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const dois = (n) => (n < 10 ? '0' + n : '' + n);
  return h > 0 ? h + ':' + dois(m) + ':' + dois(r) : dois(m) + ':' + dois(r);
}

// Chave aleatória por aba (identifica a mesma pessoa se a conexão cair).
export function gerarChave() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function copiar(valor) {
  try {
    await navigator.clipboard.writeText(valor);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = valor;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

// Escolhe quantas colunas/linhas dão os maiores quadros para n pessoas.
export function melhorGrade(n, largura, altura, razao) {
  const r = razao || 16 / 9;
  let melhor = { cols: 1, rows: Math.max(1, n), area: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = largura / cols;
    const h = altura / rows;
    const lw = Math.min(w, h * r);
    const area = lw * (lw / r);
    if (area > melhor.area) melhor = { cols, rows, area };
  }
  return melhor;
}

// Instagram, Facebook, TikTok etc. abrem os links num navegador embutido que
// bloqueia câmera e microfone (principalmente no iPhone).
export function navegadorEmbutido() {
  const ua = navigator.userAgent || '';
  return /(FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|TikTok|musical_ly|BytedanceWebview|Snapchat|Pinterest|LinkedInApp|Line\/|GSA\/)/i.test(ua);
}

export function ehCelular() {
  return /(iPhone|iPad|iPod|Android)/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function suporteCompleto() {
  return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket);
}

export function suportaCompartilharTela() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !ehCelular();
}

// Aviso sonoro curto (quando alguém pede para entrar).
let ctxSom = null;
export function liberarSom() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctxSom) ctxSom = new AC();
    if (ctxSom.state === 'suspended') ctxSom.resume();
  } catch (e) {}
}
export function bip() {
  try {
    if (!ctxSom) return;
    const o = ctxSom.createOscillator();
    const g = ctxSom.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctxSom.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctxSom.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctxSom.currentTime + 0.45);
    o.connect(g);
    g.connect(ctxSom.destination);
    o.start();
    o.stop(ctxSom.currentTime + 0.5);
  } catch (e) {}
}

// ---------- avisos na tela ----------
export function aviso(mensagem, opcoes) {
  const o = opcoes || {};
  const caixa = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (o.tipo ? ' ' + o.tipo : '');
  const t = document.createElement('span');
  t.textContent = mensagem;
  el.appendChild(t);
  const remover = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  if (o.botoes && o.botoes.length) {
    const area = document.createElement('div');
    area.className = 'botoes';
    o.botoes.forEach((b) => {
      const bt = document.createElement('button');
      bt.type = 'button';
      bt.textContent = b.rotulo;
      if (b.secundario) bt.className = 'sec';
      bt.addEventListener('click', () => {
        remover();
        if (b.acao) b.acao();
      });
      area.appendChild(bt);
    });
    el.appendChild(area);
  }
  caixa.appendChild(el);
  if (o.ms !== 0) setTimeout(remover, o.ms || 4500);
  return remover;
}

// ---------- janela de confirmação ----------
// botoes: [{ rotulo, valor, primario, perigo }]; devolve o valor do botão clicado.
export function janela(titulo, corpo, botoes) {
  return new Promise((resolve) => {
    const fundo = $('#modal-fundo');
    $('#modal-titulo').textContent = titulo;
    const area = $('#modal-corpo');
    area.textContent = '';
    (Array.isArray(corpo) ? corpo : [corpo]).forEach((linha) => {
      if (!linha) return;
      const p = document.createElement('p');
      p.textContent = linha;
      area.appendChild(p);
    });
    const bs = $('#modal-botoes');
    bs.textContent = '';
    const fechar = (valor) => {
      fundo.hidden = true;
      bs.textContent = '';
      resolve(valor);
    };
    botoes.forEach((b) => {
      const bt = document.createElement('button');
      bt.type = 'button';
      bt.className = 'botao' + (b.primario ? ' primario' : '') + (b.perigo ? ' perigo' : '');
      bt.textContent = b.rotulo;
      bt.addEventListener('click', () => fechar(b.valor));
      bs.appendChild(bt);
    });
    fundo.hidden = false;
    const primeiro = bs.querySelector('.primario') || bs.querySelector('button');
    if (primeiro) primeiro.focus();
  });
}
