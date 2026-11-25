/* Teste do tratamento de erro da Wati no envio de mensagem.
   O painel mostrava "[object Object]" porque o motivo da recusa vem como
   objeto aninhado ({ error: { code, message } }). As funções são lidas
   direto do index.js para o teste não divergir do código de produção. */
const fs = require('fs');

const fonte = fs.readFileSync('index.js', 'utf8');

function pegarFuncao(nome) {
    const inicio = fonte.indexOf('function ' + nome + '(');
    if (inicio < 0) throw new Error('função não encontrada: ' + nome);

    const abre = fonte.indexOf('{', inicio);
    let nivel = 0;

    for (let i = abre; i < fonte.length; i++) {
        if (fonte[i] === '{') nivel++;
        else if (fonte[i] === '}') {
            nivel--;
            if (nivel === 0) return fonte.slice(inicio, i + 1);
        }
    }

    throw new Error('função sem fechamento: ' + nome);
}

const codigo = pegarFuncao('achatarErroWati') + '\n'
    + pegarFuncao('erroJanelaFechada') + '\n'
    + 'return { achatarErroWati, erroJanelaFechada };';

const { achatarErroWati, erroJanelaFechada } = new Function(codigo)();

const casos = [
    {
        nome: 'erro da Cloud API (objeto aninhado)',
        entrada: { error: { code: 131047, message: 'Re-engagement message' } },
        esperado: 'código 131047: Re-engagement message'
    },
    {
        nome: 'message como objeto na raiz',
        entrada: { message: { error: { message: 'Aninhado' } } },
        esperado: 'Aninhado'
    },
    { nome: 'texto simples', entrada: 'Falha simples', esperado: 'Falha simples' },
    { nome: 'vazio', entrada: null, esperado: '' },
    { nome: 'lista de erros', entrada: [{ message: 'Primeiro' }, { message: 'Segundo' }], esperado: 'Primeiro | Segundo' }
];

let falhas = 0;

casos.forEach((caso) => {
    const obtido = achatarErroWati(caso.entrada, 0);
    const ok = obtido === caso.esperado;

    if (!ok) falhas++;
    console.log((ok ? 'OK - ' : 'FALHOU - ') + caso.nome + ': ' + JSON.stringify(obtido));
});

const janelaOk = erroJanelaFechada('código 131047: Re-engagement message')
    && erroJanelaFechada('Message failed to send because more than 24 hours have passed')
    && !erroJanelaFechada('Telefone inválido');

if (!janelaOk) falhas++;
console.log((janelaOk ? 'OK - ' : 'FALHOU - ') + 'detecção da janela de 24h');

process.exit(falhas ? 1 : 0);
