// Gravação da reunião — feita no navegador da anfitriã, salva no computador dela.
// Nada é enviado para servidor nenhum.
//
// Como funciona:
//  - o vídeo é uma "cena" desenhada num canvas (todas as câmeras ou a tela
//    compartilhada + miniaturas), 1280x720 a 30 quadros por segundo;
//  - o áudio de todo mundo é misturado num só (WebAudio);
//  - o MediaRecorder grava os dois e a gravação é salva em PARTES de até 500 MB,
//    sem parar: cada parte é um arquivo completo, que abre sozinho;
//  - no Chrome/Edge do computador as partes vão direto para a pasta escolhida
//    pela anfitriã; nos outros navegadores cada parte é baixada ao ficar pronta.

import { melhorGrade, inicial } from './util.js';

const LARGURA = 1280;
const ALTURA = 720;
const FPS = 30;
const FUNDO = '#1c1209';
const GAP = 8;

// A troca de arquivo começa um pouco antes dos 500 MB, porque a parte atual ainda
// recebe o último trecho enquanto a próxima começa.
const LIMITE_PARTE = 490 * 1000 * 1000;
const ESPERA_NOVA_PARTE = 15000; // se a parte nova não gravar nada nesse tempo, segue na atual

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
  return { gravar: ok, direto: ok && typeof window.showDirectoryPicker === 'function' };
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

function nomeBase(titulo) {
  const d = new Date();
  const data = d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()) + '_' + dois(d.getHours()) + 'h' + dois(d.getMinutes());
  const base = String(titulo || 'Reuniao')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'Reuniao';
  return 'Reuniao-' + base + '-' + data;
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  // opcoes: { titulo, obterCena(): {tela, pessoas}, obterAudios(): Map<chave, MediaStream>,
  //           aoParte({ n, nome, bytes, onde, falhou, ultima }), limiteParte (bytes) }
  //   tela:    { fluxo, video, nome } | null
  //   pessoas: [{ fluxo, video, nome, camLigada, micLigado }]
  //   (fluxo = MediaStream com a imagem; video = elemento <video> usado como reserva)
  //   onde = 'disco' (pasta escolhida) ou 'download'
  constructor(opcoes) {
    this.titulo = opcoes.titulo;
    this.obterCena = opcoes.obterCena;
    this.obterAudios = opcoes.obterAudios;
    this.aoParte = opcoes.aoParte || (() => {});
    this.limiteParte = opcoes.limiteParte || LIMITE_PARTE;
    this.ativo = false;
    this.finalizando = false;
    this.inicio = 0;
    this.fontes = new Map();
    this.leitores = new Map(); // id da trilha -> LeitorDeQuadros
    this.parte = null; // parte que está sendo gravada
    this.proxima = null; // parte nova, enquanto ainda não assumiu o lugar da atual
    this.encerramentos = [];
    this.salvas = [];
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

  // Precisa ser chamado direto de um clique (o navegador exige para abrir a escolha da pasta).
  async iniciar() {
    if (this.ativo) return { ok: true };
    this.tipo = escolherTipo();
    this.ext = this.tipo.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    this.base = nomeBase(this.titulo);
    this.pasta = null;
    let primeiro = null;

    if (typeof window.showDirectoryPicker === 'function') {
      try {
        this.pasta = await window.showDirectoryPicker({ id: 'gravacoes', mode: 'readwrite', startIn: 'documents' });
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, cancelou: true };
        if (e && e.name === 'NotAllowedError') return { ok: false, erro: 'pasta' };
        this.pasta = null; // o navegador não deixou abrir a escolha: cada parte vira download
      }
      if (this.pasta) {
        // o 1º arquivo é criado antes de começar: se a pasta não servir, avisa já
        try {
          primeiro = await this.criarArquivo(1);
        } catch (e) {
          console.warn('pasta', e);
          return { ok: false, erro: 'pasta' };
        }
      }
    }

    try {
      this.montar(primeiro);
    } catch (e) {
      console.warn('gravador', e);
      await this.limpar();
      if (primeiro) await this.apagarArquivo(primeiro);
      return { ok: false, erro: 'montar' };
    }
    this.ativo = true;
    this.inicio = Date.now();
    return { ok: true, modo: this.pasta ? 'disco' : 'download', pasta: this.pasta ? this.pasta.name : null, tipo: this.tipo };
  }

  nomeDaParte(n, repeticao) {
    return this.base + '-parte-' + dois(n) + (repeticao > 1 ? '-' + repeticao : '') + '.' + this.ext;
  }

  // Cria o arquivo da parte n na pasta escolhida, sem nunca escrever por cima de um que já exista.
  async criarArquivo(n) {
    for (let k = 1; k <= 50; k++) {
      const nome = this.nomeDaParte(n, k);
      try {
        await this.pasta.getFileHandle(nome);
        continue; // já existe
      } catch (e) {
        if (!e || e.name !== 'NotFoundError') throw e;
      }
      const arquivo = await this.pasta.getFileHandle(nome, { create: true });
      try {
        return { nome, escritor: await arquivo.createWritable() };
      } catch (e) {
        try { await this.pasta.removeEntry(nome); } catch (e2) {}
        throw e;
      }
    }
    throw new Error('sem nome livre na pasta');
  }

  // Remove um arquivo criado por nós que não chegou a ser salvo (nunca um já fechado).
  async apagarArquivo(parte) {
    if (!parte.escritor) return;
    try { await parte.escritor.abort(); } catch (e) {}
    parte.escritor = null;
    try { await this.pasta.removeEntry(parte.nome); } catch (e) {}
  }

  montar(primeiro) {
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
    // Uma fonte muda sempre ligada: sem som nenhum entrando (ex.: ninguém com microfone),
    // o Chrome não vai gravando o MP4 e a reunião se perderia.
    try {
      const mudo = this.ac.createConstantSource();
      mudo.offset.value = 0;
      mudo.connect(this.destino);
      mudo.start();
    } catch (e) {}
    this.sincronizarAudio();

    const video = this.canvas.captureStream(FPS);
    const trilhas = video.getVideoTracks().concat(this.destino.stream.getAudioTracks());
    this.saida = new MediaStream(trilhas);

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
    this.parte = this.novaParte(1, primeiro);
  }

  // ---------- partes ----------
  // Uma parte = um MediaRecorder próprio + um arquivo próprio (por isso cada arquivo abre sozinho).
  novaParte(n, arquivo) {
    const opc = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
    if (this.tipo) opc.mimeType = this.tipo;
    const rec = new MediaRecorder(this.saida, opc);
    const parte = {
      n,
      rec,
      nome: arquivo ? arquivo.nome : this.nomeDaParte(n, 1),
      escritor: arquivo ? arquivo.escritor : null,
      pedacos: [], // cópia de segurança, até o arquivo ser fechado com sucesso
      bytes: 0,
      limite: this.limiteParte,
      falhou: false,
      descartada: false,
      fila: Promise.resolve(),
    };
    parte.parou = new Promise((resolve) => {
      rec.onstop = resolve;
    });
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) this.guardar(parte, ev.data);
    };
    rec.onerror = (ev) => {
      console.warn('MediaRecorder', ev);
      if (parte === this.proxima) this.desistirDaProxima();
    };
    rec.start(1000);
    if (this.pasta && !arquivo) {
      // o arquivo é criado em paralelo; as escritas esperam por ele
      parte.fila = this.criarArquivo(n).then(
        (a) => {
          parte.nome = a.nome;
          parte.escritor = a.escritor;
        },
        (e) => {
          console.warn('arquivo da parte ' + n, e);
          parte.falhou = true;
        }
      );
    }
    return parte;
  }

  guardar(parte, blob) {
    if (parte.descartada) return;
    parte.bytes += blob.size;
    parte.pedacos.push(blob);
    parte.fila = parte.fila.then(() => {
      if (!parte.escritor || parte.falhou) return null;
      return parte.escritor.write(blob).catch((e) => {
        console.warn('escrita', e);
        parte.falhou = true;
      });
    });
    if (!this.ativo) return;
    if (parte === this.proxima) this.assumirProxima();
    else if (parte === this.parte && !this.proxima && parte.bytes >= parte.limite) this.prepararProxima();
  }

  // A parte nova começa ANTES de a atual parar: assim nenhum trecho se perde na troca.
  prepararProxima() {
    try {
      this.proxima = this.novaParte(this.parte.n + 1);
    } catch (e) {
      console.warn('nova parte', e);
      this.adiarTroca();
      return;
    }
    this.esperaProxima = setTimeout(() => this.desistirDaProxima(), ESPERA_NOVA_PARTE);
  }

  // A parte nova já está gravando: agora a antiga pode parar e ser salva.
  assumirProxima() {
    clearTimeout(this.esperaProxima);
    const antiga = this.parte;
    this.parte = this.proxima;
    this.proxima = null;
    this.encerramentos.push(this.encerrar(antiga, false));
  }

  desistirDaProxima() {
    const nova = this.proxima;
    if (!nova) return;
    clearTimeout(this.esperaProxima);
    this.proxima = null;
    this.adiarTroca();
    this.encerramentos.push(this.descartar(nova));
  }

  // A troca não deu certo: continua na parte atual e tenta de novo mais adiante.
  adiarTroca() {
    this.parte.limite += Math.ceil(this.limiteParte / 20);
  }

  async descartar(parte) {
    parte.descartada = true;
    try { parte.rec.stop(); } catch (e) {}
    await parte.fila;
    await this.apagarArquivo(parte);
    parte.pedacos = [];
  }

  // Para o gravador da parte e garante o arquivo: na pasta ou, se a pasta falhar, como download.
  async encerrar(parte, ultima) {
    try { parte.rec.stop(); } catch (e) {}
    await Promise.race([parte.parou, esperar(4000)]);
    await parte.fila;
    if (!parte.bytes) return this.apagarArquivo(parte);

    let onde = 'download';
    if (parte.escritor && !parte.falhou) {
      try {
        await parte.escritor.close();
        parte.escritor = null;
        onde = 'disco';
      } catch (e) {
        console.warn('fechar arquivo', e);
      }
    }
    if (onde === 'download') {
      await this.apagarArquivo(parte);
      this.baixar(parte);
    }
    parte.pedacos = [];
    const info = { n: parte.n, nome: parte.nome, bytes: parte.bytes, onde, falhou: !!this.pasta && onde === 'download', ultima };
    this.salvas.push(info);
    this.aoParte(info);
  }

  baixar(parte) {
    const url = URL.createObjectURL(new Blob(parte.pedacos, { type: this.tipo || 'video/webm' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = parte.nome;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
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
  // Devolve { partes: [{ n, nome, bytes, onde }], pasta, bytes, duracao }.
  async parar() {
    if (!this.ativo) return null;
    this.ativo = false;
    this.finalizando = true;
    const duracao = Math.round((Date.now() - this.inicio) / 1000);
    // uma parte nova que ainda não assumiu só repete o fim da atual: é descartada
    this.desistirDaProxima();
    this.encerramentos.push(this.encerrar(this.parte, true));
    const feitos = await Promise.allSettled(this.encerramentos);
    feitos.forEach((f) => f.status === 'rejected' && console.warn('salvar parte', f.reason));
    await this.limpar();
    this.finalizando = false;

    const partes = this.salvas.slice().sort((a, b) => a.n - b.n);
    return { partes, pasta: this.pasta ? this.pasta.name : null, bytes: partes.reduce((t, p) => t + p.bytes, 0), duracao };
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
