// Malha de conexões diretas entre os aparelhos (WebRTC).
// Cada pessoa mantém uma conexão com cada uma das outras. O vídeo e o áudio vão
// direto de aparelho para aparelho (criptografados); o servidor só ajuda a
// apresentá-los.
//
// Usa o padrão "perfect negotiation" para que os dois lados possam renegociar
// (ex.: começar a compartilhar a tela) sem travar quando as ofertas se cruzam.

async function definirLocal(pc) {
  try {
    await pc.setLocalDescription();
  } catch (e) {
    // navegadores mais antigos não aceitam a forma sem argumentos
    const estado = pc.signalingState;
    const d = estado === 'have-remote-offer' || estado === 'have-local-pranswer' ? await pc.createAnswer() : await pc.createOffer();
    await pc.setLocalDescription(d);
  }
}

function fixarTaxa(remetente, bps) {
  try {
    const p = remetente.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = bps;
    remetente.setParameters(p).catch(() => {});
  } catch (e) {}
}

class Ligacao {
  constructor(malha, id, iniciador) {
    this.malha = malha;
    this.id = id;
    this.educada = malha.meuId < id; // quem tem o id menor cede quando há choque de ofertas
    this.fazendoOferta = false;
    this.ignorarOferta = false;
    this.aguardandoResposta = false;
    this.anexado = false;
    this.fluxos = new Map();
    this.remetentes = { audio: null, video: null };
    this.somenteRecepcao = { audio: null, video: null };
    this.remTela = [];
    this.estado = 'new';
    this.timerQueda = null;
    this.candidatos = {}; // quantos candidatos de cada tipo (host, srflx, relay) este aparelho achou
    this.criadaEm = Date.now();
    this.mudouEm = Date.now(); // quando o estado da conexão mudou pela última vez

    const pc = new RTCPeerConnection({ iceServers: malha.servidoresIce, bundlePolicy: 'max-bundle' });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const m = /\styp\s(\w+)/.exec(ev.candidate.candidate || '');
        const tipo = ev.candidate.type || (m ? m[1] : '?');
        this.candidatos[tipo] = (this.candidatos[tipo] || 0) + 1;
        malha.enviarSinal(id, { candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => malha.registrar('ice(' + id + ') ' + pc.iceConnectionState);
    pc.onicecandidateerror = (ev) => malha.registrar('erro ice(' + id + ') ' + (ev.errorCode || '') + ' ' + (ev.errorText || '') + ' ' + (ev.url || ''));

    pc.onnegotiationneeded = async () => {
      try {
        this.fazendoOferta = true;
        await definirLocal(pc);
        const d = pc.localDescription;
        malha.enviarSinal(id, { description: { type: d.type, sdp: d.sdp } });
      } catch (e) {
        console.warn('oferta', e);
      } finally {
        this.fazendoOferta = false;
      }
    };

    pc.ontrack = (ev) => {
      const fluxo = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]);
      malha.registrar('recebeu ' + ev.track.kind + ' de ' + id + (ev.streams && ev.streams[0] ? '' : ' (sem fluxo associado)'));
      this.fluxos.set(fluxo.id, fluxo);
      fluxo.addEventListener('removetrack', () => {
        if (!fluxo.getTracks().length) {
          this.fluxos.delete(fluxo.id);
          malha.aoMudar(id);
        }
      });
      malha.aoMudar(id);
    };

    pc.onconnectionstatechange = () => {
      this.estado = pc.connectionState;
      this.mudouEm = Date.now();
      malha.registrar('conexão(' + id + ') ' + pc.connectionState);
      clearTimeout(this.timerQueda);
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (e) {}
      } else if (pc.connectionState === 'disconnected') {
        this.timerQueda = setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            try { pc.restartIce(); } catch (e) {}
          }
        }, 5000);
      } else if (pc.connectionState === 'connected') {
        this.ajustarTaxa();
      }
      malha.aoEstadoLigacao(id, pc.connectionState);
    };

    if (iniciador) this.anexarLocal();
  }

  // Coloca a câmera/microfone (e a tela, se estiver compartilhando) nesta conexão.
  anexarLocal() {
    this.anexado = true;
    const pc = this.pc;
    const loc = this.malha.local();
    ['audio', 'video'].forEach((tipo) => {
      const trilha = loc.cam ? loc.cam.getTracks().find((t) => t.kind === tipo && t.readyState === 'live') : null;
      if (trilha) {
        if (this.remetentes[tipo]) {
          if (this.remetentes[tipo].track !== trilha) this.remetentes[tipo].replaceTrack(trilha).catch(() => {});
        } else {
          this.remetentes[tipo] = pc.addTrack(trilha, loc.cam);
          this.somenteRecepcao[tipo] = null;
        }
      } else if (!this.remetentes[tipo] && !this.somenteRecepcao[tipo]) {
        // sem câmera/microfone: continua recebendo o dos outros
        const jaTem = pc.getTransceivers().some((t) => t.receiver && t.receiver.track && t.receiver.track.kind === tipo);
        if (!jaTem) this.somenteRecepcao[tipo] = pc.addTransceiver(tipo, { direction: 'recvonly' });
      }
    });
    if (loc.tela && !this.remTela.length) this.anexarTela(loc.tela);
    this.ajustarTaxa();
  }

  anexarTela(fluxo) {
    this.removerTela();
    this.remTela = fluxo.getTracks().map((t) => this.pc.addTrack(t, fluxo));
    this.ajustarTaxa();
  }

  removerTela() {
    this.remTela.forEach((s) => {
      try { this.pc.removeTrack(s); } catch (e) {}
    });
    this.remTela = [];
  }

  ajustarTaxa() {
    const n = this.malha.quantidade();
    const cam = n <= 1 ? 1500000 : n <= 3 ? 900000 : 500000;
    const tela = n <= 1 ? 3000000 : n <= 3 ? 2000000 : 1200000;
    if (this.remetentes.video) fixarTaxa(this.remetentes.video, cam);
    this.remTela.forEach((s) => {
      if (s.track && s.track.kind === 'video') fixarTaxa(s, tela);
    });
  }

  async receber(dados) {
    const pc = this.pc;
    try {
      if (dados.description) {
        const d = dados.description;
        const pronta = !this.fazendoOferta && (pc.signalingState === 'stable' || this.aguardandoResposta);
        const choque = d.type === 'offer' && !pronta;
        this.ignorarOferta = !this.educada && choque;
        if (this.ignorarOferta) return;
        if (choque && pc.signalingState === 'have-local-offer') {
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) {}
        }
        this.aguardandoResposta = d.type === 'answer';
        await pc.setRemoteDescription(d);
        this.aguardandoResposta = false;
        if (d.type === 'offer') {
          if (!this.anexado) this.anexarLocal(); // quem já estava na sala responde já com a sua mídia
          await definirLocal(pc);
          const l = pc.localDescription;
          this.malha.enviarSinal(this.id, { description: { type: l.type, sdp: l.sdp } });
        }
      } else if (dados.candidate) {
        try {
          await pc.addIceCandidate(dados.candidate);
        } catch (e) {
          if (!this.ignorarOferta) throw e;
        }
      }
    } catch (e) {
      console.warn('sinal', e);
    }
  }

  fechar() {
    clearTimeout(this.timerQueda);
    this.pc.onicecandidate = null;
    this.pc.onnegotiationneeded = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try { this.pc.close(); } catch (e) {}
  }
}

export class Malha {
  // opcoes: { meuId, servidoresIce, enviarSinal(paraId, dados), local(): {cam, tela},
  //           aoMudar(idDoPar), aoEstadoLigacao(idDoPar, estado) }
  constructor(opcoes) {
    this.meuId = opcoes.meuId;
    this.servidoresIce = opcoes.servidoresIce;
    this.enviarSinal = opcoes.enviarSinal;
    this.local = opcoes.local;
    this.aoMudar = opcoes.aoMudar || (() => {});
    this.aoEstadoLigacao = opcoes.aoEstadoLigacao || (() => {});
    this.registrar = opcoes.registrar || (() => {});
    this.ligacoes = new Map();
  }

  quantidade() {
    return this.ligacoes.size;
  }

  // iniciador = true: quem acabou de entrar liga para quem já estava na sala.
  ligar(id, iniciador) {
    let l = this.ligacoes.get(id);
    if (!l) {
      l = new Ligacao(this, id, iniciador);
      this.ligacoes.set(id, l);
      this.ligacoes.forEach((outra) => outra.ajustarTaxa());
    }
    return l;
  }

  sinal(deId, dados) {
    const l = this.ligacoes.get(deId) || this.ligar(deId, false);
    return l.receber(dados);
  }

  remover(id) {
    const l = this.ligacoes.get(id);
    if (!l) return;
    l.fechar();
    this.ligacoes.delete(id);
    this.ligacoes.forEach((outra) => outra.ajustarTaxa());
    this.aoMudar(id);
  }

  // câmera/microfone mudaram (trocou de câmera, voltou a permissão…)
  atualizarLocal() {
    this.ligacoes.forEach((l) => {
      if (l.anexado) l.anexarLocal();
    });
  }

  atualizarTela() {
    const loc = this.local();
    this.ligacoes.forEach((l) => {
      if (!l.anexado) return;
      if (loc.tela) l.anexarTela(loc.tela);
      else l.removerTela();
    });
  }

  fluxos(id) {
    const l = this.ligacoes.get(id);
    return l ? l.fluxos : new Map();
  }

  // Foto do estado de cada conexão, para o relatório de suporte.
  async relatorio() {
    const saida = [];
    for (const [id, l] of this.ligacoes) {
      const o = {
        com: id,
        conexao: l.pc.connectionState,
        ice: l.pc.iceConnectionState,
        coleta: l.pc.iceGatheringState,
        sinalizacao: l.pc.signalingState,
        candidatosLocais: l.candidatos,
        ha: Math.round((Date.now() - l.criadaEm) / 1000) + ' s',
        recebido: {},
      };
      try {
        const st = await l.pc.getStats();
        const porId = {};
        st.forEach((x) => { porId[x.id] = x; });
        st.forEach((x) => {
          if (x.type === 'inbound-rtp') o.recebido[x.kind] = { pacotes: x.packetsReceived, perdidos: x.packetsLost, quadrosDecodificados: x.framesDecoded };
          if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') {
            const a = porId[x.localCandidateId];
            const b = porId[x.remoteCandidateId];
            o.caminho = (a ? a.candidateType : '?') + ' → ' + (b ? b.candidateType : '?');
          }
        });
      } catch (e) {
        o.estatisticas = 'indisponíveis';
      }
      saida.push(o);
    }
    return saida;
  }

  // Estado real da conexão com essa pessoa (navegadores sem connectionState usam o estado do ICE).
  estado(id) {
    const l = this.ligacoes.get(id);
    if (!l) return 'new';
    const c = l.pc.connectionState;
    if (c) return c;
    const i = l.pc.iceConnectionState;
    return i === 'completed' ? 'connected' : i;
  }

  // Há quantos milissegundos a conexão está neste estado.
  haQuanto(id) {
    const l = this.ligacoes.get(id);
    return l ? Date.now() - l.mudouEm : 0;
  }

  fechar() {
    this.ligacoes.forEach((l) => l.fechar());
    this.ligacoes.clear();
  }
}
