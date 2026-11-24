// Conversa com o sinalizador (criar salas, login da anfitriã, estado da sala).
const cfg = window.SALA_CONFIG;
const CHAVE = 'sala.sessao';

export const sessao = {
  token() {
    try {
      const s = JSON.parse(localStorage.getItem(CHAVE) || 'null');
      if (s && s.exp > Date.now()) return s.token;
    } catch (e) {}
    return null;
  },
  guardar(token, exp) {
    try {
      localStorage.setItem(CHAVE, JSON.stringify({ token, exp }));
    } catch (e) {}
  },
  limpar() {
    try {
      localStorage.removeItem(CHAVE);
    } catch (e) {}
  },
};

export function urlWs(id) {
  return cfg.api.replace(/^http/, 'ws') + '/ws/' + encodeURIComponent(id);
}

export function linkDaSala(id) {
  return location.origin + location.pathname.replace(/index\.html$/, '') + '?sala=' + encodeURIComponent(id);
}

async function pedir(caminho, opcoes) {
  const o = opcoes || {};
  const cab = {};
  if (o.corpo) cab['content-type'] = 'application/json';
  if (o.auth) {
    const t = sessao.token();
    if (!t) throw erro('nao-autorizada', 401);
    cab.authorization = 'Bearer ' + t;
  }
  let resp;
  try {
    resp = await fetch(cfg.api + caminho, {
      method: o.metodo || 'GET',
      headers: cab,
      body: o.corpo ? JSON.stringify(o.corpo) : undefined,
    });
  } catch (e) {
    throw erro('rede', 0);
  }
  let dados = {};
  try {
    dados = await resp.json();
  } catch (e) {}
  if (!resp.ok) {
    if (resp.status === 401 && o.auth) sessao.limpar();
    throw erro(dados.error || 'erro', resp.status, dados);
  }
  return dados;
}

function erro(codigo, status, dados) {
  const e = new Error(codigo);
  e.codigo = codigo;
  e.status = status;
  e.dados = dados || {};
  return e;
}

export const api = {
  async entrar(senha) {
    const r = await pedir('/api/login', { metodo: 'POST', corpo: { password: senha } });
    sessao.guardar(r.token, r.exp);
    return r;
  },
  salas: () => pedir('/api/rooms', { auth: true }),
  criar: (titulo, slug) => pedir('/api/rooms', { metodo: 'POST', auth: true, corpo: { title: titulo, slug: slug || undefined } }),
  apagar: (id) => pedir('/api/rooms/' + encodeURIComponent(id), { metodo: 'DELETE', auth: true }),
  info: (id) => pedir('/api/rooms/' + encodeURIComponent(id)),
  ice: (id) => pedir('/api/ice?sala=' + encodeURIComponent(id)),
};

export function mensagemDeErro(e) {
  switch (e && e.codigo) {
    case 'senha-incorreta': return 'Senha incorreta. Tente de novo.';
    case 'muitas-tentativas': return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    case 'senha-nao-configurada': return 'A senha da anfitriã ainda não foi configurada no servidor.';
    case 'nome-invalido': return 'Use de 3 a 40 letras minúsculas, números ou hífen (sem espaços).';
    case 'ja-existe': return 'Já existe uma reunião com esse nome de link. Escolha outro.';
    case 'rede': return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    case 'nao-autorizada': return 'Sua sessão de anfitriã expirou. Entre de novo.';
    default: return 'Algo deu errado. Tente de novo em instantes.';
  }
}
