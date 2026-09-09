# ScreenLink

Compartilhamento de tela e áudio em tempo real entre um computador e celulares ou outros computadores. O transmissor e os espectadores usam o mesmo endereço; não é necessário instalar um aplicativo.

## Experiência do MVP

1. Abra o ScreenLink no Chrome ou Edge do computador.
2. Clique em **Compartilhar minha tela** e escolha uma tela ou janela.
3. Copie o link privado exibido.
4. Abra o link em até oito celulares ou computadores, conforme o limite escolhido pelo apresentador.
5. O espectador pode ativar o próprio microfone para conversar com o apresentador.
6. Clique em **Encerrar compartilhamento** quando terminar.

Cada sala permite escolher de 1 a 8 espectadores. A transmissão oferece até 1080p/60 FPS, áudio da tela, microfone do apresentador e microfone dos espectadores, sempre sujeita à capacidade real de CPU e rede.

## Arquitetura

Existe apenas um serviço Node.js:

- entrega a interface web;
- mantém a sala privada temporária;
- encaminha somente as mensagens necessárias para formar a conexão WebRTC.

O vídeo e o áudio viajam diretamente entre os dispositivos por WebRTC P2P. O STUN
ajuda os navegadores a descobrir esse caminho, e o próprio WebRTC adapta bitrate,
resolução e quadros conforme a rede. Um servidor TURN pode ser configurado como
fallback para redes que bloqueiam P2P; ele não é usado quando existe um caminho
direto melhor. O ScreenLink não grava o conteúdo.

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

## Uso em redes diferentes

O endereço público HTTPS do Render permite que os dispositivos entrem na mesma sala.
O WebRTC tenta primeiro um caminho P2P direto com ajuda do STUN. NAT simétrico,
CGNAT e firewalls restritivos podem impedir essa rota; nesses casos configure
`TURN_URLS`, `TURN_USERNAME` e `TURN_CREDENTIAL` para oferecer um relay de fallback.
O relay deve ficar geograficamente próximo dos usuários para evitar RTT desnecessário.

Se a sinalização WebSocket cair temporariamente, a sala e os pares são preservados por uma janela de recuperação, e o navegador tenta reassociar a mesma sessão ao voltar do segundo plano. Isso reduz desconexões provocadas por suspensão de abas, mas não pode impedir o próprio sistema operacional de congelar ou encerrar uma página web em segundo plano.

## Publicar no Render

O arquivo `render.yaml` descreve o deploy completo em um único Web Service.

1. Coloque o conteúdo desta pasta em um repositório Git.
2. No Render, crie um **Blueprint** a partir do repositório.
3. Aguarde o build e abra o endereço `onrender.com` fornecido.
4. Confira `/health`. O campo `mode` deve ser `p2p-stun`.

O plano gratuito do Render pode adormecer após um período sem uso. O primeiro acesso seguinte pode levar alguns segundos para despertar o serviço; isso não muda a arquitetura.

## Segurança e privacidade

- O identificador e a chave da sala são gerados aleatoriamente no navegador.
- A chave fica no fragmento `#` do link, que não é enviado durante a requisição HTTP da página.
- O servidor mantém somente o hash SHA-256 da chave enquanto a transmissão está ativa.
- A sala é apagada imediatamente quando o transmissor encerra; perdas inesperadas de sinalização recebem uma janela curta de recuperação.
- O limite de espectadores é definido pelo apresentador antes de iniciar a sala.
- Cabeçalhos de segurança bloqueiam câmera, incorporação em outros sites e carregamento de scripts externos; microfone e captura de tela são permitidos somente para a própria origem.

## Comandos

```powershell
npm run dev    # interface local com atualização automática
npm run build  # checagem TypeScript e build de produção
npm test       # teste do site e do protocolo de sinalização
npm start      # servidor único de produção
```
