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
    + pegarFuncao('contatoInexistenteNaWati') + '\n'
    + pegarFuncao('mensagemCriadaNaWati') + '\n'
    + 'return { achatarErroWati, erroJanelaFechada, contatoInexistenteNaWati, mensagemCriadaNaWati };';

const { achatarErroWati, erroJanelaFechada, contatoInexistenteNaWati, mensagemCriadaNaWati } = new Function(codigo)();

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
    { nome: 'lista de erros', entrada: [{ message: 'Primeiro' }, { message: 'Segundo' }], esperado: 'Primeiro | Segundo' },
    { nome: 'só o código (sem detalhe)', entrada: { code: 1 }, esperado: 'código 1' },
    {
        nome: 'só o código com a resposta crua',
        entrada: { result: false, code: 1 },
        esperado: 'código 1 (resposta da Wati: {"result":false,"code":1})'
    }
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
    && erroJanelaFechada('Ticket has been expired.')
    && erroJanelaFechada('Ticket has been expired')
    && erroJanelaFechada('O ticket desta conversa foi fechado')
    /* Caso real de produção: Wati respondeu "Invalid Conversation." para um
       contato cuja conversa já tinha vencido. */
    && erroJanelaFechada('Invalid Conversation.')
    && !erroJanelaFechada('Telefone inválido')
    && !erroJanelaFechada('Template não encontrado');

if (!janelaOk) falhas++;
console.log((janelaOk ? 'OK - ' : 'FALHOU - ') + 'detecção da janela de 24h (inclui "Ticket has been expired")');

const contatoOk = contatoInexistenteNaWati('Contact with phone number 5562982248765 not found.')
    && contatoInexistenteNaWati('contact not found')
    && !contatoInexistenteNaWati('Ticket has been expired.')
    && !contatoInexistenteNaWati('Telefone inválido');

if (!contatoOk) falhas++;
console.log((contatoOk ? 'OK - ' : 'FALHOU - ') + 'detecção de contato inexistente na Wati (cria e repete o envio)');

/* O caso real de produção: a Wati respondeu 200 com o objeto da mensagem
   (whatsappMessageId + text) e o painel acusava erro "código 1". */
const criadaOk = mensagemCriadaNaWati({ result: true, message: 'ok' })
    && mensagemCriadaNaWati({ result: false, message: { whatsappMessageId: 'wamid.X', text: 'Boa Tarde' } })
    && mensagemCriadaNaWati({ message: { localMessageId: 'abc' } })
    && !mensagemCriadaNaWati({ result: false, message: 'Contact with phone number 1 not found.' })
    && !mensagemCriadaNaWati({ result: false, message: { code: 1 } })
    && !mensagemCriadaNaWati(null);

if (!criadaOk) falhas++;
console.log((criadaOk ? 'OK - ' : 'FALHOU - ') + 'envio aceito quando a Wati devolve o objeto da mensagem (sem result:true)');

process.exit(falhas ? 1 : 0);
