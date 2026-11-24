// Gravação da reunião — feita no navegador da anfitriã, salva no computador dela.
// Nada é enviado para servidor nenhum.
//
// Como funciona:
//  - o vídeo é uma "cena" desenhada num canvas (todas as câmeras ou a tela
//    compartilhada + miniaturas), 1280x720 a 30 quadros por segundo;
//  - o áudio de todo mundo é misturado num só (WebAudio);
//  - o MediaRecorder grava os dois e, no Chrome/Edge do computador, escreve direto
//    no arquivo escolhido (não ocupa a memória, aguenta reuniões longas).
//    Nos outros navegadores o arquivo é montado na memória e baixado ao parar.

import { melhorGrade, inicial } from './util.js';

const LARGURA = 1280;
const ALTURA = 720;
const FPS = 30;
const FUNDO = '#1c1209';
const GAP = 8;

const TIPOS = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function suporteGravacao() {
  const ok = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && (window.AudioContext || window.webkitAudioContext));
  return { gravar: ok, direto: ok && typeof window.showSaveFilePicker === 'function' };
}

function escolherTipo() {
  for (let i = 0; i < TIPOS.length; i++) {
    try {
      if (MediaRecorder.isTypeSupported(TIPOS[i])) return TIPOS[i];
    } catch (e) {}
  }
  return '';
}

function dois(n) {
  return n < 10 ? '0' + n : '' + n;
}

function nomeDoArquivo(titulo, ext) {
  const d = new Date();
  const data = d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()) + '_' + dois(d.getHours()) + 'h' + dois(d.getMinutes());
  const base = String(titulo || 'Reuniao')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'Reuniao';
  return 'Reuniao-' + base + '-' + data + '.' + ext;
}

function pronto(v) {
  return !!(v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
}

// Lê os quadros direto da transmissão (Chrome/Edge), sem depender do elemento <video>.
// Assim a gravação continua perfeita mesmo com a aba da reunião em segundo plano
// (ex.: a anfitriã compartilhando outra janela), quando o navegador congela os <video>.
const TEM_PROCESSADOR = typeof window !== 'undefined' && typeof window.MediaStreamTrackProcessor === 'function';

class LeitorDeQuadros {
  constructor(trilha) {
    this.trilha = trilha;
    this.quadro = null;
    this.parado = false;
    this.ultimoUso = Date.now();
    this.leitor = new window.MediaStreamTrackProcessor({ track: trilha }).readable.getReader();
    this.ler();
  }

  async ler() {
    try {
      while (!this.parado) {
        const r = await this.leitor.read();
        if (r.done) break;
        if (this.parado) {
          if (r.value) r.value.close();
          break;
        }
        if (this.quadro) this.quadro.close();
        this.quadro = r.value;
      }
    } catch (e) {}
  }

  parar() {
    this.parado = true;
    try { this.leitor.cancel(); } catch (e) {}
    if (this.quadro) {
      try { this.quadro.close(); } catch (e) {}
      this.quadro = null;
    }
  }
}

export class Gravador {
  // opcoes: { titulo, obterCena(): {tela, pessoas}, obterAudios(): Map<chave, MediaStream> }
  //   tela:    { fluxo, video, nome } | null
  //   pessoas: [{ fluxo, video, nome, camLigada, micLigado }]
  //   (fluxo = MediaStream com a imagem; video = elemento <video> usado como reserva)
  constructor(opcoes) {
    this.titulo = opcoes.titulo;
    this.obterCena = opcoes.obterCena;
    this.obterAudios = opcoes.obterAudios;
    this.ativo = false;
    this.bytes = 0;
    this.inicio = 0;
    this.fontes = new Map();
    this.leitores = new Map(); // id da trilha -> LeitorDeQuadros
    this.pedacos = [];
    this.fila = Promise.resolve();
  }

  // Devolve { img, vw, vh } com o quadro mais recente daquela pessoa/tela, ou null.
  fonteDe(item) {
    if (!item || !this.vivo) return null;
    if (TEM_PROCESSADOR && item.fluxo) {
      const trilha = item.fluxo.getVideoTracks().find((t) => t.readyState === 'live');
      if (trilha) {
        let l = this.leitores.get(trilha.id);
        if (!l) {
          try {
            l = new LeitorDeQuadros(trilha);
            this.leitores.set(trilha.id, l);
          } catch (e) {
            l = null;
          }
        }
        if (l) {
          l.ultimoUso = Date.now();
          const q = l.quadro;
          if (q && q.displayWidth > 0) return { img: q, vw: q.displayWidth, vh: q.displayHeight };
          return null;
        }
      }
    }
    if (pronto(item.video)) return { img: item.video, vw: item.video.videoWidth, vh: item.video.videoHeight };
    return null;
  }

  // Libera leitores de transmissões que não existem mais.
  podarLeitores() {
    const agora = Date.now();
    this.leitores.forEach((l, id) => {
      if (agora - l.ultimoUso > 3000 || l.trilha.readyState !== 'live') {
        l.parar();
        this.leitores.delete(id);
      }
    });
  }

  // Precisa ser chamado direto de um clique (o navegador exige para abrir "Salvar como").
  async iniciar() {
    if (this.ativo) return { ok: true };
    const tipo = escolherTipo();
    const ext = tipo.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    this.tipo = tipo;
    this.nome = nomeDoArquivo(this.titulo, ext);
    this.escritor = null;
    this.modo = 'download';

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const arquivo = await window.showSaveFilePicker({
          suggestedName: this.nome,
          types: [{ description: 'Vídeo da reunião', accept: ext === 'mp4' ? { 'video/mp4': ['.mp4'] } : { 'video/webm': ['.webm'] } }],
        });
        this.escritor = await arquivo.createWritable();
        this.nome = arquivo.name || this.nome;
        this.modo = 'disco';
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, cancelou: true };
        this.escritor = null; // cai para o modo "baixar ao final"
      }
    }

    try {
      this.montar();
    } catch (e) {
      console.warn('gravador', e);
      await this.limpar();
      if (this.escritor) {
        try { await this.escritor.close(); } catch (e2) {}
        this.escritor = null;
      }
      return { ok: false, erro: 'montar' };
    }
    this.ativo = true;
    this.inicio = Date.now();
    return { ok: true, nome: this.nome, modo: this.modo, tipo: this.tipo };
  }

  montar() {
    this.vivo = true; // enquanto falso, nenhum desenho (nem leitor de quadros) pode ser criado
    this.canvas = document.createElement('canvas');
    this.canvas.width = LARGURA;
    this.canvas.height = ALTURA;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.ctx.fillStyle = FUNDO;
    this.ctx.fillRect(0, 0, LARGURA, ALTURA);

    const AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    if (this.ac.state === 'suspended') this.ac.resume();
    this.destino = this.ac.createMediaStreamDestination();
    this.sincronizarAudio();

    const video = this.canvas.captureStream(FPS);
    const trilhas = video.getVideoTracks().concat(this.destino.stream.getAudioTracks());
    this.saida = new MediaStream(trilhas);

    const opc = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
    if (this.tipo) opc.mimeType = this.tipo;
    this.rec = new MediaRecorder(this.saida, opc);
    this.rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) this.guardar(ev.data);
    };
    this.rec.onerror = (ev) => console.warn('MediaRecorder', ev);

    // O relógio fica num Worker: abas em segundo plano não o atrasam.
    try {
      const blob = new Blob(['var t;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}'], { type: 'application/javascript' });
      this.urlRelogio = URL.createObjectURL(blob);
      this.relogio = new Worker(this.urlRelogio);
      this.relogio.onmessage = () => this.desenhar();
      this.relogio.postMessage(Math.round(1000 / FPS));
    } catch (e) {
      this.timer = setInterval(() => this.desenhar(), Math.round(1000 / FPS));
    }
    this.timerAudio = setInterval(() => {
      this.sincronizarAudio();
      this.podarLeitores();
    }, 1000);
    this.desenhar();
    this.rec.start(1000);
  }

  guardar(blob) {
    this.bytes += blob.size;
    if (this.escritor) {
      this.fila = this.fila.then(() => this.escritor.write(blob)).catch((e) => console.warn('escrita', e));
    } else {
      this.pedacos.push(blob);
    }
  }

  sincronizarAudio() {
    if (!this.ac) return;
    const atuais = this.obterAudios();
    atuais.forEach((fluxo, chave) => {
      const n = fluxo.getAudioTracks().length;
      const ex = this.fontes.get(chave);
      if (ex && ex.fluxo === fluxo && ex.n === n) return;
      if (ex) {
        try { ex.no.disconnect(); } catch (e) {}
        this.fontes.delete(chave);
      }
      if (!n) return;
      try {
        const no = this.ac.createMediaStreamSource(fluxo);
        no.connect(this.destino);
        this.fontes.set(chave, { fluxo, no, n });
      } catch (e) {}
    });
    this.fontes.forEach((ex, chave) => {
      if (!atuais.has(chave)) {
        try { ex.no.disconnect(); } catch (e) {}
        this.fontes.delete(chave);
      }
    });
  }

  // ---------- desenho da cena ----------
  desenhar() {
    const c = this.ctx;
    // desenhos já agendados podem chegar depois do fim da gravação: ignorar
    if (!c || !this.vivo) return;
    c.fillStyle = FUNDO;
    c.fillRect(0, 0, LARGURA, ALTURA);
    let cena;
    try { cena = this.obterCena(); } catch (e) { return; }
    const pessoas = cena.pessoas || [];

    const fonteTela = cena.tela ? this.fonteDe(cena.tela) : null;
    if (fonteTela) {
      const lateral = pessoas.length ? 260 : 0;
      const larg = LARGURA - (lateral ? lateral + GAP : 0);
      this.quadroVideo(fonteTela, 0, 0, larg, ALTURA, 'contain');
      this.rotulo(cena.tela.nome + ' (tela)', 10, ALTURA - 34);
      if (lateral) {
        const n = pessoas.length;
        const h = Math.min(146, (ALTURA - GAP * (n - 1)) / n);
        pessoas.forEach((p, i) => this.quadroPessoa(p, larg + GAP, i * (h + GAP), lateral, h, true));
      }
      return;
    }

    const n = pessoas.length;
    if (!n) return;
    const g = melhorGrade(n, LARGURA, ALTURA, 16 / 9);
    const w = (LARGURA - GAP * (g.cols - 1)) / g.cols;
    const h = (ALTURA - GAP * (g.rows - 1)) / g.rows;
    pessoas.forEach((p, i) => {
      const col = i % g.cols;
      const lin = Math.floor(i / g.cols);
      // centraliza a última linha quando sobram colunas
      const naLinha = lin === g.rows - 1 ? n - lin * g.cols : g.cols;
      const sobra = (g.cols - naLinha) * (w + GAP) / 2;
      this.quadroPessoa(p, col * (w + GAP) + sobra, lin * (h + GAP), w, h, false);
    });
  }

  // fonte = { img (VideoFrame ou <video>), vw, vh }
  quadroVideo(fonte, x, y, w, h, modo) {
    const c = this.ctx;
    const vw = fonte.vw;
    const vh = fonte.vh;
    const escala = modo === 'contain' ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
    if (modo === 'contain') {
      const dw = vw * escala;
      const dh = vh * escala;
      c.fillStyle = '#000';
      c.fillRect(x, y, w, h);
      c.drawImage(fonte.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const sw = w / escala;
      const sh = h / escala;
      c.drawImage(fonte.img, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
    }
  }

  quadroPessoa(p, x, y, w, h, pequeno) {
    const c = this.ctx;
    c.fillStyle = '#2b1c10';
    c.fillRect(x, y, w, h);
    const fonte = p.camLigada ? this.fonteDe(p) : null;
    if (fonte) {
      this.quadroVideo(fonte, x, y, w, h, 'cover');
    } else {
      const r = Math.min(w, h) * 0.22;
      c.fillStyle = '#e3c9e8';
      c.beginPath();
      c.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#411e06';
      c.font = '600 ' + Math.round(r) + 'px Georgia, serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(inicial(p.nome), x + w / 2, y + h / 2 + 2);
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
    }
    this.rotulo((p.micLigado === false ? '🔇 ' : '') + p.nome, x + 8, y + h - (pequeno ? 26 : 34), pequeno);
  }

  rotulo(texto, x, y, pequeno) {
    const c = this.ctx;
    const tam = pequeno ? 13 : 17;
    c.font = '600 ' + tam + 'px Montserrat, Arial, sans-serif';
    const larg = Math.min(c.measureText(texto).width + 16, 360);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(x, y, larg, tam + 12);
    c.fillStyle = '#fff';
    c.textBaseline = 'middle';
    c.fillText(texto, x + 8, y + (tam + 12) / 2, 344);
    c.textBaseline = 'alphabetic';
  }

  // ---------- parar e salvar ----------
  async parar() {
    if (!this.ativo) return null;
    this.ativo = false;
    const rec = this.rec;
    const fim = new Promise((resolve) => {
      rec.onstop = resolve;
    });
    try { rec.stop(); } catch (e) {}
    await Promise.race([fim, new Promise((r) => setTimeout(r, 4000))]);
    await this.fila;
    await this.limpar();

    const duracao = Math.round((Date.now() - this.inicio) / 1000);
    if (this.escritor) {
      try { await this.escritor.close(); } catch (e) { console.warn('fechar arquivo', e); }
      this.escritor = null;
      return { nome: this.nome, bytes: this.bytes, modo: 'disco', duracao };
    }
    const blob = new Blob(this.pedacos, { type: this.tipo || 'video/webm' });
    this.pedacos = [];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.nome;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { nome: this.nome, bytes: blob.size, modo: 'download', duracao };
  }

  async limpar() {
    this.vivo = false;
    clearInterval(this.timer);
    clearInterval(this.timerAudio);
    if (this.relogio) {
      try { this.relogio.terminate(); } catch (e) {}
      this.relogio = null;
    }
    if (this.urlRelogio) {
      URL.revokeObjectURL(this.urlRelogio);
      this.urlRelogio = null;
    }
    this.fontes.forEach((ex) => {
      try { ex.no.disconnect(); } catch (e) {}
    });
    this.fontes.clear();
    this.leitores.forEach((l) => l.parar());
    this.leitores.clear();
    if (this.saida) this.saida.getTracks().forEach((t) => t.stop());
    this.saida = null;
    if (this.ac) {
      try { await this.ac.close(); } catch (e) {}
      this.ac = null;
    }
  }
}
