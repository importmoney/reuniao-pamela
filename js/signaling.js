// Conexão com o sinalizador (WebSocket) com reconexão automática.
// Se a rede do celular cair por alguns segundos, o servidor segura o lugar e a
// pessoa volta sozinha (mesma "chave"), sem pedir para entrar de novo.

// Códigos de fechamento que NÃO devem reconectar (recusada, removida, encerrada…)
const TERMINAIS = [4000, 4002, 4003, 4004, 4005, 4006, 4007, 4008];

export class Sinalizacao {
  // opcoes: { url, montarEntrada(): objeto, aoMensagem(m), aoEstado(estado, extra), limiteSilencio? }
  constructor(opcoes) {
    this.url = opcoes.url;
    this.montarEntrada = opcoes.montarEntrada;
    this.aoMensagem = opcoes.aoMensagem;
    this.aoEstado = opcoes.aoEstado;
    this.limiteSilencio = opcoes.limiteSilencio || 50000; // sem nenhuma resposta do servidor por tanto tempo = conexão morta
    this.ws = null;
    this.fechado = false;
    this.tentativas = 0;
    this.jaAbriu = false;
    this.ultimaMsg = Date.now();
    this.timerPing = null;
    this.timerVigia = null;
    this.timerReconexao = null;

    // Voltou a rede / voltou para o app: confere se a conexão ainda está viva.
    this._voltou = () => {
      if (this.fechado) return;
      if (!this.ws || this.ws.readyState > 1) {
        clearTimeout(this.timerReconexao);
        this.conectar();
        return;
      }
      if (this.ws.readyState === 1) {
        const marca = Date.now();
        this.enviar({ t: 'ping' });
        setTimeout(() => {
          if (!this.fechado && this.ultimaMsg < marca) this._abandonar();
        }, 4000);
      }
    };
    window.addEventListener('online', this._voltou);
    this._visivel = () => {
      if (document.visibilityState === 'visible') this._voltou();
    };
    document.addEventListener('visibilitychange', this._visivel);
  }

  conectar() {
    if (this.fechado) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._reconectar();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.jaAbriu = true;
      this.tentativas = 0;
      this.ultimaMsg = Date.now();
      this.aoEstado('aberta');
      ws.send(JSON.stringify(this.montarEntrada()));
      clearInterval(this.timerPing);
      this.timerPing = setInterval(() => this.enviar({ t: 'ping' }), 20000);
      clearInterval(this.timerVigia);
      this.timerVigia = setInterval(() => this._vigiar(), 3000);
    };
    ws.onmessage = (ev) => {
      this.ultimaMsg = Date.now();
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!m || m.t === 'pong') return;
      this.aoMensagem(m);
    };
    ws.onclose = (ev) => {
      clearInterval(this.timerPing);
      clearInterval(this.timerVigia);
      if (this.ws !== ws || this.fechado) return;
      if (TERMINAIS.indexOf(ev.code) >= 0) {
        this.fechado = true;
        this.aoEstado('encerrada', ev.code);
        return;
      }
      this._reconectar();
    };
    ws.onerror = () => {};
  }

  // Conexão "aberta" que não responde mais (sinal fraco, aparelho dormiu): troca por uma nova.
  _vigiar() {
    if (this.fechado || !this.ws || this.ws.readyState !== 1) return;
    if (Date.now() - this.ultimaMsg > this.limiteSilencio) this._abandonar();
  }

  _abandonar() {
    const velho = this.ws;
    if (velho) {
      velho.onopen = velho.onmessage = velho.onclose = velho.onerror = null;
      try { velho.close(); } catch (e) {}
    }
    this.ws = null;
    clearInterval(this.timerPing);
    clearInterval(this.timerVigia);
    this._reconectar();
  }

  _reconectar() {
    if (this.fechado) return;
    if (!this.jaAbriu && this.tentativas >= 5) {
      this.fechado = true;
      this.aoEstado('falhou');
      return;
    }
    this.aoEstado('reconectando');
    const espera = Math.min(10000, 500 * Math.pow(2, this.tentativas++));
    clearTimeout(this.timerReconexao);
    this.timerReconexao = setTimeout(() => this.conectar(), espera);
  }

  enviar(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  sair() {
    this.enviar({ t: 'leave' });
    this.fechar();
  }

  fechar() {
    this.fechado = true;
    clearInterval(this.timerPing);
    clearInterval(this.timerVigia);
    clearTimeout(this.timerReconexao);
    window.removeEventListener('online', this._voltou);
    document.removeEventListener('visibilitychange', this._visivel);
    try {
      if (this.ws) this.ws.close();
    } catch (e) {}
  }
}
