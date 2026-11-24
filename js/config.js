// Configuração da Sala de Reuniões.
// "api" é o endereço do sinalizador (Cloudflare Worker). Em testes locais usa localhost.
(function () {
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  window.SALA_CONFIG = {
    api: local ? 'http://localhost:8787' : 'https://pamela-reuniao.pamela-reuniao-sinalizador.workers.dev',
    nomePadraoAnfitria: 'Pâmela',
    maxPessoas: 6,
  };
})();
