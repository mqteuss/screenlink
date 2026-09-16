# ScreenLink

Chamada de voz, compartilhamento de tela e chat temporário em tempo real entre um computador e celulares ou outros computadores. O host e os espectadores usam o mesmo endereço; não é necessário instalar um aplicativo.

## Experiência do MVP

1. Abra o ScreenLink no Chrome ou Edge do computador.
2. Clique em **Iniciar chamada**. A sala e o convite são criados antes de qualquer captura de tela.
3. Copie o link privado e abra-o em outros celulares ou computadores, respeitando o limite total escolhido pelo host.
4. Converse por voz ou pelo chat P2P temporário.
5. Clique em **Compartilhar tela** quando quiser; é possível trocar ou parar a tela sem encerrar a chamada.
6. Ajuste separadamente o volume da voz de cada pessoa e o som de cada tela compartilhada.
7. Clique em **Encerrar chamada** quando terminar.

Cada sala permite escolher de 2 a 8 participantes ao todo. O compartilhamento oferece até 1080p/60 FPS, áudio da tela, microfone bidirecional e chat efêmero, sempre sujeitos à capacidade real de CPU e rede.

## Sala multiusuário

O ScreenLink usa uma única interface para criar uma sala ou entrar com um código. Nessa mesma chamada:

- participantes no computador entram colando o link ou o código da sala;
- qualquer participante no computador pode iniciar ou parar a própria tela pelo mesmo botão;
- várias telas podem ficar ativas ao mesmo tempo;
- se o criador sair, o participante conectado há mais tempo assume a liderança;
- quando o criador retorna com a chave privada salva neste navegador, ele retoma a liderança;
- nome, status, avatar ou foto personalizada ficam salvos somente no armazenamento local deste dispositivo;
- a interface compacta para celular mantém voz, visualização, participantes e chat, sem expor o controle de compartilhar tela.
- tela cheia, miniplayer e bloqueio de suspensão ficam reunidos em **Mais opções** durante a chamada.
- o fundo da chamada é composto por gradientes CSS estáticos e não inicializa WebGL, preservando GPU para a codificação de tela; **Interface > Animações e movimento** controla somente o mascote e as transições, respeitando `prefers-reduced-motion` no primeiro acesso.
- no compartilhamento P2P, o encoder prioriza detalhe em uma conversa 1:1 saudável e muda automaticamente para baixa latência quando há múltiplos peers ou degradação de rede.
- o build gera versões Brotli e gzip dos arquivos textuais; o servidor negocia a melhor delas via `Accept-Encoding` e mantém fallback sem compressão.

A sala em grupo usa uma malha WebRTC: cada participante mantém uma conexão direta com cada um dos demais. É adequada para grupos pequenos, mas várias telas simultâneas multiplicam upload, CPU e consumo de bateria. Para grupos grandes, a evolução indicada é usar uma SFU.

## Arquitetura

Existe apenas um serviço Node.js:

- entrega a interface web;
- mantém a sala privada temporária;
- encaminha as mensagens necessárias para formar e recuperar a conexão WebRTC;
- retransmite temporariamente uma mensagem de chat somente quando algum DataChannel ainda não está pronto.

O vídeo e o áudio viajam diretamente entre os dispositivos por WebRTC P2P. O chat usa
RTCDataChannel sempre que o canal está disponível e possui o fallback temporário de sinalização
descrito acima. Confirmações de entrega, fila com reenvio e sincronização entre os participantes
recuperam mensagens durante reconexões e para quem entra depois, sem banco de dados; nenhuma
mensagem é persistida. O STUN ajuda os navegadores a descobrir esse caminho. O modo
de bitrate adaptativo mede perda, latência e capacidade de saída de cada conexão e
reduz bitrate, escala e quadros quando a rede aperta; o orçamento de upload também é
dividido entre os pares. A instalação padrão não depende de SFU nem TURN e, portanto,
não cria franquia mensal de mídia. O ScreenLink não grava o conteúdo.

Cada conexão pré-negocia três trilhas independentes — voz, vídeo da tela e áudio da
tela — além de um RTCDataChannel para o chat. A captura de tela usa replaceTrack(),
por isso iniciar, trocar ou parar a tela normalmente não exige recriar a conexão.
As mensagens existem apenas na memória durante a chamada; cada participante envia aos
DataChannels abertos dos demais participantes. Links `http`/`https` são abertos separadamente,
e cores dos balões e nomes podem ser personalizadas apenas no dispositivo local.

Com vários espectadores, o computador cria uma conexão P2P por pessoa. Isso preserva baixa latência em grupos pequenos, mas multiplica o upload e o trabalho de codificação; para audiências maiores, uma arquitetura SFU é mais eficiente.

## Executar localmente

Requisitos: Node.js 22 ou mais recente.

```powershell
npm install
npm run build
npm start
```

Abra `http://localhost:8787` no computador que vai compartilhar. O convite gerado
usa automaticamente o IPv4 da rede local quando a página do transmissor está em
`localhost`. O computador continua usando `localhost`, porque a captura de tela
do navegador exige um contexto seguro.

Para testar no celular, abra primeiro `http://IP-DO-PC:8787/health`. Se não abrir:

1. confirme que os dois dispositivos estão na mesma rede;
2. marque essa rede do Windows como **Privada**;
3. permita a porta TCP 8787 no Firewall do Windows somente para redes privadas.

É possível forçar a origem colocada nos convites com `PUBLIC_ORIGIN`, por exemplo
ao usar um domínio público ou túnel HTTPS.

Para desenvolver com atualização automática, mantenha o servidor Node em um terminal e
o Vite em outro. O Vite encaminha `/ws`, `/runtime-config` e `/health` para a porta 8787:

```powershell
# terminal 1 (depois de ao menos um npm run build)
npm start

# terminal 2
npm run dev
```

## Aplicativo para Windows (Electron)

O aplicativo desktop reutiliza a mesma interface e o mesmo protocolo WebRTC do site. Ele
mantém `contextIsolation` e sandbox ativos, usa uma ponte IPC pequena para o perfil e abre
um seletor próprio de telas e janelas. No Windows, o áudio do sistema acompanha a captura
quando o compartilhamento solicita áudio.

```powershell
npm run desktop       # compila e abre o aplicativo local
npm run desktop:pack  # cria uma pasta não instalável para inspeção
npm run desktop:dist  # gera instalador e versão portátil x64 em release/
```

O instalador público fica disponível pelo botão **Baixar para Windows** do site e pelo
endereço estável abaixo. Ele sempre aponta para a versão mais recente publicada:

`https://github.com/mqteuss/screenlink/releases/latest/download/ScreenLink-Setup-x64.exe`

Por padrão, o Electron se conecta ao deploy HTTPS oficial do ScreenLink, inclusive depois
de um cold start do Render. Se ele não responder, o aplicativo cai automaticamente para o
servidor local empacotado. Também é possível apontar para outro deploy HTTPS:

```powershell
$env:SCREENLINK_APP_URL = 'https://seu-screenlink.onrender.com'
npm run desktop
```

Para forçar uma sessão apenas na rede local, use
`$env:SCREENLINK_APP_URL = 'local'`. Convites pela internet e permissões completas de mídia
em navegadores móveis continuam dependendo do deploy HTTPS.

O nome, status e avatar do perfil desktop ficam somente no SQLite local
`%APPDATA%\ScreenLink\screenlink.sqlite`. Nenhuma mensagem de chat é gravada nele.
O workflow **Electron Windows** também permite gerar os dois `.exe` pela aba Actions do
GitHub ou automaticamente ao enviar uma tag `v*`.

## Uso em redes diferentes

O endereço público HTTPS do Render permite que os dispositivos entrem na mesma sala.
O WebRTC tenta um caminho P2P direto com ajuda do STUN. NAT simétrico, CGNAT e
firewalls restritivos podem impedir essa rota. Sem TURN, essas combinações de rede podem
não conectar; essa é uma limitação conhecida e deliberada para manter a operação sem
franquia mensal de relay.

Se a sinalização WebSocket cair temporariamente, a sala e os pares são preservados por uma janela de recuperação, e o navegador tenta reassociar a mesma sessão ao voltar do segundo plano. Isso reduz desconexões provocadas por suspensão de abas, mas não pode impedir o próprio sistema operacional de congelar ou encerrar uma página web em segundo plano.

## Publicar no Render

O arquivo `render.yaml` descreve o deploy completo em um único Web Service.

1. Coloque o conteúdo desta pasta em um repositório Git.
2. No Render, crie um **Blueprint** a partir do repositório.
3. Aguarde o build e abra o endereço `onrender.com` fornecido.
4. Confira `/health`. O campo `mode` deve ser `p2p-mesh`.

O plano gratuito do Render pode adormecer após um período sem uso. O primeiro acesso seguinte pode levar alguns segundos para despertar o serviço; isso não muda a arquitetura.

## Segurança e privacidade

- O identificador e a chave da sala são gerados aleatoriamente no navegador.
- A chave fica no fragmento `#` do link, que não é enviado durante a requisição HTTP da página.
- A chave do proprietário é mantida somente como hash SHA-256. A chave de entrada da sala permanece apenas na memória do processo enquanto a sala existe, pois é necessária para transformar o código curto de seis caracteres em um convite completo.
- A sala é apagada quando o proprietário escolhe **Encerrar sala** ou quando fica vazia após a janela de recuperação; sair sem encerrar permite que outro participante assuma a liderança.
- O limite de espectadores é definido pelo apresentador antes de iniciar a sala.
- Cabeçalhos de segurança bloqueiam incorporação em outros sites e carregamento de scripts externos; câmera é bloqueada, e microfone e captura de tela são permitidos somente para a própria origem. No Electron, o microfone ainda exige consentimento explícito em uma caixa nativa por execução.
- O WebSocket valida a origem, limita tentativas de código, frequência de mensagens e conexões simultâneas; o servidor também limita a quantidade total de salas. Use `ALLOWED_ORIGINS` apenas quando frontend e backend realmente estiverem em origens diferentes.

## Comandos

```powershell
npm run dev    # interface local com atualização automática
npm run build  # checagem TypeScript e build de produção
npm test       # teste do site e do protocolo de sinalização
npm start      # servidor único de produção
npm run desktop       # abre o app Electron
npm run desktop:dist  # gera os executáveis do Windows
```
